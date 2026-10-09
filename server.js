// PVE.trade Signal Engine — backend proxy.
// Keeps the X-Agent-Key server-side, solves browser CORS, caches + rate-limits upstream,
// normalizes every response into one canonical shape, and logs calls for the monitor.
//
// The uploaded file is the BUILD BRIEF, not an API spec. The real PVE.trade agent API is a
// prediction-markets flow/intel API (markets, outcomes, flow, spikes, top-traders, prices,
// orderbook, osint) — it does NOT expose an equity option chain (strikes/expiry/greeks/OI).
// So nothing here invents an option chain. Signal components are computed only from data PVE
// actually returns; the "PCR"/"OI" pieces are honest ANALOGS (outcome pressure / liquidity)
// and are labelled as such in the UI.
//
// Endpoints observed from PVE docs (adjust ROUTES / ALIASES below if your account differs):
//   GET /me  /markets  /market/:slug  /prices  /orderbook  /flow  /flow/spikes  /flow/top-traders

import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { filterMarkets, classifyMarket, configFromEnv, categorizeMarkets, ASSET_CATEGORIES, CLASSIFIER_VERSION } from './classify.js';
import { ENGINE_VERSION } from './public/engine.js';
import { makeOptionsProvider, optionsProviderStatus } from './providers/options.js';
import { OpenRouterClient, configFromEnv as aiConfigFromEnv } from './providers/openrouter.js';
import { buildAiContext, runAnalysis } from './ai/agents.js';
import { safeTicker } from './ticker.js';
import { computeShadow, SHADOW_ENGINE_VERSION, momentum } from './shadow/engine.js';
import { computeCrossSectional, computeSectorBreadth, marketRegimeState, classifyEarningsProximity, CROSS_SECTIONAL_VERSION } from './shadow/cross-sectional.js';
import { computeValidated, VALIDATED_MODEL_VERSION, IDENTITY_PROMOTION } from './validated/model.js';
import { logSignal } from './store/signal-log.js';
import { readJournal, readSignal, pendingOutcomes } from './store/journal-store.js';
import { filterJournal, computeLearning } from './store/journal.js';
import { baselineReport } from './store/evaluation.js';
import { scoreV2, V2_VERSION } from './engine/v2.js';
import { step as stateStep, isActionable } from './engine/state.js';
import { BaselineStore } from './store/normalize.js';
import { computeRvol, MarketContext, IvSkewTracker, EarningsCalendar, eventFlags } from './engine/context.js';
import { rvolReadiness, ivSkewReadiness, sectorRelativeStrength, macroReadiness, researchReadiness, promotionGate, RateLimiter } from './store/readiness.js';
import { buildOptionsSignal, OPTIONS_ENGINE_VERSION } from './public/options-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- tiny .env loader (no dependency) ----------------------------------------
(function loadEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore */ }
})();

const CONFIG = {
  BASE_URL: null,                      // §18: PVE Trade API removed; UW only
  BASE_URL_REMOVED: 'PVE_TRADE_API_REMOVED',
  AGENT_KEY: '',                       // §18: no PVE agent credentials
  PASSWORD: process.env.DASHBOARD_PASSWORD || 'SatyajitDD7',
  PORT: Number(process.env.PORT || 4000),
  CACHE_TTL_MS: Number(process.env.CACHE_TTL_MS || 8000),
  MIN_UPSTREAM_INTERVAL_MS: Number(process.env.MIN_UPSTREAM_INTERVAL_MS || 1200),
  SESSION_TTL_MS: 1000 * 60 * 60 * 12,
  MONITOR_MAX: 250,
};

// =============================================================================
//  NORMALIZATION  — the single place to adjust field mapping.
//  Look at raw JSON in the API/Data Monitor tab; if a value is missing, add the
//  real field name to the matching alias list here.
// =============================================================================
const ALIASES = {
  marketsArray: ['markets', 'data', 'results', 'items', 'list'],
  slug: ['slug', 'id', 'marketId', 'market_id', 'ticker', 'symbol'],
  title: ['title', 'name', 'question', 'description'],
  status: ['status', 'state'],
  tags: ['tags', 'categories', 'category', 'tag'],
  volume: ['volume', 'vol', 'totalVolume', 'volume24h', 'volume_24h', 'volumeUsd'],
  liquidity: ['liquidity', 'depth', 'openInterest', 'oi', 'tvl', 'liquidityUsd'],
  endDate: ['endDate', 'end_date', 'closeTime', 'close_time', 'resolutionDate', 'expiry', 'expiration', 'endsAt'],
  outcomesArray: ['outcomes', 'tokens', 'markets', 'options'],
  tokenId: ['token_id', 'tokenId', 'id', 'clobTokenId', 'outcomeId'],
  outcomeName: ['name', 'outcome', 'label', 'title'],
  price: ['price', 'lastPrice', 'last', 'mid', 'probability', 'prob'],
  outVol: ['volume', 'vol', 'volume24h', 'size'],
  // flow summary
  netFlow: ['netFlow', 'net', 'net_flow', 'netVolume', 'delta'],
  buyVol: ['buyVolume', 'buy', 'bought', 'buy_volume', 'callVolume', 'yesVolume', 'inflow'],
  sellVol: ['sellVolume', 'sell', 'sold', 'sell_volume', 'putVolume', 'noVolume', 'outflow'],
  sentiment: ['sentiment', 'bias', 'smartMoney', 'smart_money', 'score', 'signal'],
  bullish: ['bullish', 'bullishCount', 'bulls', 'callCount', 'yesCount'],
  bearish: ['bearish', 'bearishCount', 'bears', 'putCount', 'noCount'],
  hourly: ['hourlyActivity', 'hourly', 'byHour', 'activityByHour'],
  // spikes
  spikesArray: ['spikes', 'data', 'results', 'items'],
  direction: ['direction', 'side', 'dir', 'sentiment', 'type'],
  magnitude: ['magnitude', 'zscore', 'z', 'ratio', 'multiplier', 'spike', 'strength', 'score'],
  ts: ['ts', 'time', 'timestamp', 'createdAt', 'created_at', 'date'],
  // traders
  tradersArray: ['traders', 'topTraders', 'data', 'results', 'leaderboard', 'items'],
  traderName: ['name', 'agent', 'username', 'handle', 'trader'],
  tradeCount: ['count', 'trades', 'tradeCount', 'numTrades'],
  pnl: ['pnl', 'profit', 'realizedPnl', 'return', 'roi'],
  // prices
  pricesArray: ['prices', 'data', 'history', 'points', 'candles', 'series'],
  pricePoint: ['price', 'p', 'close', 'value', 'probability'],
  priceT: ['t', 'time', 'timestamp', 'date', 'ts'],
  // orderbook
  bids: ['bids', 'buy', 'buys', 'bidLevels'],
  asks: ['asks', 'sell', 'sells', 'askLevels'],
  // account
  balance: ['balance', 'cash', 'virtualBalance', 'usd', 'buyingPower'],
  agentName: ['name', 'agent', 'username', 'handle'],
};

const pick = (o, keys, d = null) => {
  if (!o || typeof o !== 'object') return d;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return d;
};
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const firstArray = (raw, keys = []) => {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    for (const k of keys) if (Array.isArray(raw[k])) return raw[k];
    for (const k of Object.keys(raw)) if (Array.isArray(raw[k])) return raw[k];
  }
  return [];
};
const dirSign = (v) => {
  if (typeof v === 'number') return v > 0 ? 1 : v < 0 ? -1 : 0;
  const s = String(v || '').toLowerCase();
  if (/buy|bull|up|yes|long|call|positive/.test(s)) return 1;
  if (/sell|bear|down|no|short|put|negative/.test(s)) return -1;
  return 0;
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function normOutcome(o) {
  let p = num(pick(o, ALIASES.price));
  if (p !== null && p > 1.5) p = p / 100; // some feeds give cents/percent
  return { tokenId: pick(o, ALIASES.tokenId), name: pick(o, ALIASES.outcomeName, ''), price: p, volume: num(pick(o, ALIASES.outVol)) };
}
function normMarket(m) {
  const outs = firstArray(m, ALIASES.outcomesArray).map(normOutcome).filter((x) => x.tokenId || x.name);
  let tags = pick(m, ALIASES.tags, []);
  if (typeof tags === 'string') tags = [tags];
  return {
    slug: pick(m, ALIASES.slug),
    title: pick(m, ALIASES.title, ''),
    status: pick(m, ALIASES.status, ''),
    tags: Array.isArray(tags) ? tags : [],
    volume: num(pick(m, ALIASES.volume)),
    liquidity: num(pick(m, ALIASES.liquidity)),
    endDate: pick(m, ALIASES.endDate),
    outcomes: outs,
  };
}
const N = {
  me: (raw) => ({ name: pick(raw, ALIASES.agentName, 'agent'), balance: num(pick(raw, ALIASES.balance)), stats: raw?.stats || null }),
  markets: (raw) => ({ markets: firstArray(raw, ALIASES.marketsArray).map(normMarket).filter((x) => x.slug) }),
  market: (raw) => normMarket(raw?.market || raw?.data || raw),
  flow: (raw) => {
    const f = raw?.flow || raw?.data || raw || {};
    let sent = num(pick(f, ALIASES.sentiment));
    if (sent !== null && Math.abs(sent) > 1.5) sent = clamp(sent / 100, -1, 1);
    return {
      netFlow: num(pick(f, ALIASES.netFlow)),
      buyVol: num(pick(f, ALIASES.buyVol)),
      sellVol: num(pick(f, ALIASES.sellVol)),
      sentiment: sent,
      bullish: num(pick(f, ALIASES.bullish)),
      bearish: num(pick(f, ALIASES.bearish)),
      hourly: firstArray(f, ALIASES.hourly),
    };
  },
  spikes: (raw) => ({
    spikes: firstArray(raw, ALIASES.spikesArray).map((s) => ({
      slug: pick(s, ALIASES.slug),
      title: pick(s, ALIASES.title, ''),
      tokenId: pick(s, ALIASES.tokenId),
      direction: dirSign(pick(s, ALIASES.direction)),
      magnitude: num(pick(s, ALIASES.magnitude)),
      volume: num(pick(s, ALIASES.volume ?? [])) ?? num(pick(s, ['volume', 'vol'])),
      price: num(pick(s, ALIASES.price)),
      ts: pick(s, ALIASES.ts),
    })),
  }),
  traders: (raw) => ({
    traders: firstArray(raw, ALIASES.tradersArray).map((t) => ({
      name: pick(t, ALIASES.traderName, '—'),
      volume: num(pick(t, ALIASES.volume)),
      count: num(pick(t, ALIASES.tradeCount)),
      pnl: num(pick(t, ALIASES.pnl)),
      direction: dirSign(pick(t, ALIASES.direction)),
      slug: pick(t, ALIASES.slug),
    })),
  }),
  prices: (raw) => {
    const arr = firstArray(raw, ALIASES.pricesArray);
    const series = arr.map((pt) => {
      if (Array.isArray(pt)) return { t: num(pt[0]), price: num(pt[1]) };
      let p = num(pick(pt, ALIASES.pricePoint));
      if (p !== null && p > 1.5) p = p / 100;
      return { t: pick(pt, ALIASES.priceT), price: p };
    }).filter((x) => x.price !== null);
    return { series };
  },
  orderbook: (raw) => {
    const ob = raw?.orderbook || raw?.data || raw || {};
    const level = (l) => Array.isArray(l) ? { price: num(l[0]), size: num(l[1]) } : { price: num(pick(l, ['price', 'p'])), size: num(pick(l, ['size', 'amount', 'quantity', 'qty'])) };
    const bids = firstArray(ob, ALIASES.bids).map(level).filter((x) => x.price !== null);
    const asks = firstArray(ob, ALIASES.asks).map(level).filter((x) => x.price !== null);
    const bidDepth = bids.reduce((a, b) => a + (b.size || 0), 0);
    const askDepth = asks.reduce((a, b) => a + (b.size || 0), 0);
    const tot = bidDepth + askDepth;
    const mid = bids[0] && asks[0] ? (bids[0].price + asks[0].price) / 2 : (bids[0]?.price ?? asks[0]?.price ?? null);
    return { bids, asks, bidDepth, askDepth, imbalance: tot ? (bidDepth - askDepth) / tot : null, mid };
  },
};

function safeNorm(fn, raw) { try { return fn(raw); } catch (e) { return { raw, _normError: e.message }; } }
function recCount(n) {
  if (!n) return 0;
  if (Array.isArray(n.markets)) return n.markets.length;
  if (Array.isArray(n.spikes)) return n.spikes.length;
  if (Array.isArray(n.traders)) return n.traders.length;
  if (Array.isArray(n.series)) return n.series.length;
  return 1;
}


// =============================================================================
//  UPSTREAM CALLER  — cache + rate-limit + monitor
// =============================================================================
const cache = new Map();
const lastUpstream = new Map();
const monitor = [];
const lastResponse = new Map();
function logMonitor(e) { monitor.unshift(e); if (monitor.length > CONFIG.MONITOR_MAX) monitor.length = CONFIG.MONITOR_MAX; }

async function callPVE({ endpointKey, pathq, params, normalizer, mode }) {
  const qs = new URLSearchParams(params || {}).toString();
  const key = mode + '|' + endpointKey + (qs ? '?' + qs : '');
  const now = Date.now();

  const c = cache.get(key);
  if (c && now - c.ts < CONFIG.CACHE_TTL_MS) {
    const payload = { ...c.payload, meta: { ...c.payload.meta, cached: true } };
    lastResponse.set(endpointKey, payload);
    return payload;
  }
  const last = lastUpstream.get(key) || 0;
  if (c && now - last < CONFIG.MIN_UPSTREAM_INTERVAL_MS) {
    return { ...c.payload, meta: { ...c.payload.meta, cached: true, rateLimited: true } };
  }

  if (!CONFIG.AGENT_KEY) {
    const payload = { ok: false, error: 'PVE_AGENT_KEY not set on server. Add it to .env and restart the server.', raw: null, normalized: null, meta: { endpoint: endpointKey, mode: 'live', status: 0, latencyMs: 0, records: 0, ts: new Date(now).toISOString(), cached: false } };
    lastResponse.set(endpointKey, payload);
    logMonitor({ endpoint: endpointKey, params: params || {}, status: 0, latencyMs: 0, records: 0, ts: payload.meta.ts, mode: 'live', error: 'no key' });
    return payload;
  }

  const url = CONFIG.BASE_URL + pathq + (qs ? '?' + qs : '');
  const t0 = Date.now();
  let status = 0, raw = null, err = null;
  try {
    const r = await fetch(url, { headers: { 'X-Agent-Key': CONFIG.AGENT_KEY, Accept: 'application/json' } });
    status = r.status;
    const text = await r.text();
    try { raw = text ? JSON.parse(text) : null; } catch { raw = { _nonJson: text ? text.slice(0, 2000) : '' }; }
    if (!r.ok) err = 'HTTP ' + status + (raw && (raw.error || raw.message) ? ' — ' + (raw.error || raw.message) : '');
  } catch (e) { err = e.message; }
  const latencyMs = Date.now() - t0;
  lastUpstream.set(key, Date.now());
  const normalized = err ? null : safeNorm(normalizer, raw);
  const payload = { ok: !err, error: err || undefined, raw, normalized, meta: { endpoint: endpointKey, mode: 'live', status, latencyMs, records: normalized ? recCount(normalized) : 0, ts: new Date().toISOString(), cached: false } };
  if (!err) cache.set(key, { ts: Date.now(), payload });
  lastResponse.set(endpointKey, payload);
  logMonitor({ endpoint: endpointKey, params: params || {}, status, latencyMs, records: payload.meta.records, ts: payload.meta.ts, mode: 'live', error: err || undefined });
  return payload;
}

// =============================================================================
//  AUTH  (basic gate for a self-hosted single-user tool — change the password;
//  this is not hardened multi-user auth)
// =============================================================================
// Stateless auth: the cookie is an HMAC-signed expiry, so sessions survive server restarts/deploys
// (previously an in-memory Map wiped every restart → refresh bounced to login). Secret derives from the
// dashboard password, so it's stable across restarts and rotates automatically if the password changes.
const SESSION_SECRET = crypto.createHash('sha256').update('pve-sess-v1|' + CONFIG.PASSWORD).digest();
function signSession(expMs) { return `${expMs}.${crypto.createHmac('sha256', SESSION_SECRET).update(String(expMs)).digest('hex')}`; }
function verifySession(token) {
  if (!token || typeof token !== 'string') return false;
  const i = token.indexOf('.'); if (i < 0) return false;
  const expStr = token.slice(0, i), mac = token.slice(i + 1);
  const exp = Number(expStr); if (!Number.isFinite(exp) || exp < Date.now()) return false;
  let a, b; try { a = Buffer.from(mac, 'hex'); b = Buffer.from(crypto.createHmac('sha256', SESSION_SECRET).update(expStr).digest('hex'), 'hex'); } catch { return false; }
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function getCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return decodeURIComponent(v.join('=')); }
  return null;
}
function safeEq(a, b) { const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b)); if (ab.length !== bb.length) return false; try { return crypto.timingSafeEqual(ab, bb); } catch { return false; } }
function authed(req) { return verifySession(getCookie(req, 'pve_sess')); }
function requireAuth(req, res, next) { if (authed(req)) return next(); res.status(401).json({ error: 'unauthorized' }); }
function resolveMode() { return 'live'; } // demo mode removed — always live

// =============================================================================
//  APP
// =============================================================================
const app = express();
app.use(express.json({ limit: '256kb' }));

app.post('/auth/login', (req, res) => {
  if (!safeEq(req.body?.password || '', CONFIG.PASSWORD)) return res.status(403).json({ error: 'wrong password' });
  const token = signSession(Date.now() + CONFIG.SESSION_TTL_MS);
  res.setHeader('Set-Cookie', `pve_sess=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(CONFIG.SESSION_TTL_MS / 1000)}`);
  res.json({ ok: true, live: !!CONFIG.AGENT_KEY });
});
app.post('/auth/logout', (req, res) => { res.setHeader('Set-Cookie', 'pve_sess=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/auth/status', (req, res) => res.json({ authed: authed(req), live: !!CONFIG.AGENT_KEY, baseUrl: CONFIG.BASE_URL, options: optionsProviderStatus(process.env) }));

// §18 — the PVE Trade agent API has been REMOVED. UW is the only external market-data source.
const R = [];
function clean(o) { const r = {}; for (const k in o) if (o[k] !== undefined && o[k] !== null && o[k] !== '') r[k] = o[k]; return r; }

// ---- US-equity classification gate (server-side; crypto/politics/sports/etc excluded here) ----
const CLASSIFY_CFG = configFromEnv(process.env);
let allowedSlugs = new Set();          // slugs that passed the US-equity filter on the last markets fetch
let lastClassify = { stats: null, decisions: [] };

for (const r of R) {
  app.get(r.route, requireAuth, async (req, res) => {
    const mode = resolveMode(req);
    const params = r.params(req.query, req.params);
    const pathq = r.pathq || ('/market/' + encodeURIComponent(req.params.slug));
    const payload = await callPVE({ endpointKey: r.key, pathq, params, normalizer: r.norm, mode });

    // Filter to US equities/ETFs BEFORE anything downstream sees the data. No fabrication on failure.
    if (payload.ok && payload.normalized) {
      if (r.key === 'markets' && Array.isArray(payload.normalized.markets)) {
        const { allowed, rejected, stats, decisions } = filterMarkets(payload.normalized.markets, CLASSIFY_CFG);
        payload.normalized.markets = allowed;
        payload.meta.classify = stats;
        allowedSlugs = new Set(allowed.map((m) => m.slug));
        lastClassify = { stats, decisions, rejected };
      } else if (r.key === 'market' && payload.normalized.slug) {
        const d = classifyMarket(payload.normalized, CLASSIFY_CFG);
        payload.normalized.asset_type = d.asset_type; payload.normalized.classification = d;
        if (d.classification !== 'ALLOWED') { payload.normalized = null; payload.ok = false; payload.error = `Excluded by US-equity filter: ${d.reason}`; }
      }
      // NOTE: /flow/spikes and /flow/top-traders are returned RAW (all PVE markets) for the PVE Explorer.
      // The signal engine only scores the FILTERED /api/markets list and matches spikes/traders by slug,
      // so non-US flow can never create a US signal. Do not filter them here.
    }
    res.json(payload);
  });
}

// Classifier debug: why each market from the last /markets fetch was kept or dropped.
app.get('/api/_classify', requireAuth, (req, res) => res.json({
  classifierVersion: CLASSIFIER_VERSION, engineVersion: ENGINE_VERSION,
  stats: lastClassify.stats, decisions: lastClassify.decisions || [], rejected: lastClassify.rejected || [],
}));

// ---- PVE DATA EXPLORER (display-only; UNFILTERED + categorized). Never feeds the signal engine. ----
// Supports search via ?q= and the usual tag/limit/status passthrough. Returns markets grouped by asset_type.
app.get('/api/explore/markets', requireAuth, async (req, res) => {
  const payload = await callPVE({ endpointKey: 'markets', pathq: '/markets', params: clean({ q: req.query.q, tag: req.query.tag, limit: req.query.limit || 100, status: req.query.status }), normalizer: N.markets, mode: resolveMode(req) });
  if (!payload.ok || !payload.normalized) return res.json({ ok: false, source: 'PVE.TRADE', error: payload.error || 'PVE data unavailable', categories: null });
  const cat = categorizeMarkets(payload.normalized.markets || [], CLASSIFY_CFG);
  res.json({ ok: true, source: 'PVE.TRADE', ts: payload.meta ? payload.meta.ts : new Date().toISOString(), meta: ASSET_CATEGORIES, ...cat });
});

// ---- REAL options + stock (PRIMARY). Provider selected via env; key stays server-side. ----
const UW_LIMITER = new RateLimiter({ maxPerMinute: Number(process.env.UW_MAX_PER_MINUTE) || null, maxPerScan: Number(process.env.UW_MAX_PER_SCAN) || 12000 });   // 500 tickers x ~14 calls + headroom
const OPT_PROVIDER = makeOptionsProvider(process.env, { limiter: UW_LIMITER });
const optCache = new Map(); // ticker -> { agg, prices:[] } for OI/IV-change + stock momentum (prior snapshots only)
const AI = { cfg: aiConfigFromEnv(process.env), client: new OpenRouterClient(aiConfigFromEnv(process.env)) };
// Phase 4 promotion config: which shadow features are approved for the validated score (evidence-driven).
// Defaults to identity (validated == current) until research/run-phase3.js rewrites it from real data.
let PROMOTION = IDENTITY_PROMOTION;
try { const pj = JSON.parse(fs.readFileSync(path.join(__dirname, 'validated', 'promotion.json'), 'utf8')); if (pj && Array.isArray(pj.approvedFeatures)) PROMOTION = pj; } catch { /* keep identity */ }
const aiCache = new Map(); // ticker -> { ts, payload } advisory AI results (short TTL)
// Optional lightweight persistence of AI runs (OFF by default). Never stores keys/prompts/secrets.
const AI_PERSIST = process.env.AI_PERSIST === 'true';
const AI_LOG_DIR = process.env.AI_LOG_DIR || path.join(__dirname, 'ai-runs');
async function persistAiRun(ticker, rec) {
  if (!AI_PERSIST) return;
  try { await fs.promises.mkdir(AI_LOG_DIR, { recursive: true }); await fs.promises.appendFile(path.join(AI_LOG_DIR, `${ticker}.jsonl`), JSON.stringify(rec) + '\n'); } catch (e) { /* best-effort; never breaks the response */ }
}

function isNumS(x) { return typeof x === 'number' && Number.isFinite(x); }

// Shared: build the deterministic options signal for a ticker (used by /api/options and /api/ai).
async function buildTickerSignal(ticker) {
  if (OPT_PROVIDER.name === 'null') return { ok: false, error: OPT_PROVIDER.reason || 'No options provider configured', signal: null, chain: null };
  const c = await OPT_PROVIDER.getChain(ticker, { limit: 250 });
  const chain = c.chain;
  // §14 — bad/absent UW data must never become a real-looking score of 0. If the chain is
  // empty (outage, rate limit, unknown ticker) report UNAVAILABLE instead of scoring nothing.
  if (!chain || !Array.isArray(chain.contracts) || chain.contracts.length === 0) {
    return { ok: false, status: 'UNAVAILABLE', reason: c && c.error ? 'UW_REQUEST_FAILED' : 'UW_NO_CONTRACTS',
      detail: c && c.error ? String(c.error).slice(0, 200) : 'UW returned no option contracts for this ticker',
      signal: null, chain: null };
  }
  try { const u = await OPT_PROVIDER.getUnderlying(ticker); if (u && u.underlying && u.underlying.available) { chain.underlying = { ...chain.underlying, ...u.underlying, available: true }; chain.fieldsAvailable.underlying = true; } } catch (e) { /* underlying optional */ }
  let ohlcHist = [], ohlcBars = [];
  try { if (OPT_PROVIDER.getOhlc) { const oh = await OPT_PROVIDER.getOhlc(ticker); if (oh && oh.available && Array.isArray(oh.bars)) { ohlcBars = oh.bars; ohlcHist = oh.bars.slice(-6).map((b) => b.close).filter(isNumS); } } } catch (e) { /* ohlc optional */ }
  let vwap = null, _intraday = null; try { if (OPT_PROVIDER.getIntraday) { const iv = await OPT_PROVIDER.getIntraday(ticker); if (iv && iv.available) { _intraday = iv; if (isNumS(iv.vwap)) vwap = iv.vwap; } } } catch (e) { /* intraday optional */ }
  const prev = optCache.get(ticker) || {};
  const pc = chain.underlying && chain.underlying.prevClose;
  const ref = isNumS(vwap) ? vwap : pc; // INTRADAY: price vs VWAP; fall back to prev close when market closed
  const hist = (isNumS(ref) && ref > 0) ? [ref, ref] : (ohlcHist.length >= 2 ? ohlcHist.slice(-2) : (Array.isArray(prev.prices) ? prev.prices : []));
  let prevAgg = prev.agg || null;
  if (!prevAgg && OPT_PROVIDER.getOiChange) { // cold start: derive prior OI snapshot from UW's real OI change
    try {
      const oc = await OPT_PROVIDER.getOiChange(ticker);
      if (oc && oc.available && isNumS(oc.callOIChange) && isNumS(oc.putOIChange)) {
        const probe = buildOptionsSignal(chain, { prevAgg: null, underlyingHist: hist, flow: chain.flow }, {});
        const cOI = probe && probe.agg && probe.agg.callOI, pOI = probe && probe.agg && probe.agg.putOI;
        if (isNumS(cOI) && isNumS(pOI)) prevAgg = { callOI: Math.max(0, cOI - oc.callOIChange), putOI: Math.max(0, pOI - oc.putOIChange) };
      }
    } catch (e) { /* oi-change optional */ }
  }
  const sig = buildOptionsSignal(chain, { prevAgg, underlyingHist: hist, flow: chain.flow }, {});
  if (isNumS(vwap)) sig.vwap = vwap;
  // SIGNAL JOURNAL (req 7): snapshot the aggregates the SCORE actually used, BEFORE the PVE display
  // overrides below mutate sig.agg. This is bucket (A). The overrides become bucket (B).
  const scoredAgg = { gex: sig.agg.gex, gammaFlip: sig.agg.gammaFlip, maxPain: sig.agg.maxPain, cpVolRatio: sig.agg.cpVolRatio, cpOIRatio: sig.agg.cpOIRatio, volOIRatio: sig.agg.volOIRatio, atmIV: sig.agg.atmIV, strikeConcentration: sig.agg.strikeConcentration, avgSpread: sig.agg.avgSpread, spot: sig.agg.spot };
  if (OPT_PROVIDER.name !== 'null' && OPT_PROVIDER.getGex) {
    try { const g = await OPT_PROVIDER.getGex(ticker); if (g && g.available) { if (isNumS(g.net_gex)) sig.agg.gex = g.net_gex; if (isNumS(g.gamma_flip)) sig.agg.gammaFlip = g.gamma_flip; sig.walls = { call: g.call_wall, put: g.put_wall }; sig.gexSource = 'pve'; } } catch (e) { /* gex optional */ }
    try { const iv = await OPT_PROVIDER.getIvRank(ticker); if (iv && iv.available) { sig.ivRank = iv.iv_rank; sig.ivPercentile = iv.iv_percentile; } } catch (e) { /* iv rank optional */ }
  }
  if (isNumS(chain.underlying && chain.underlying.price)) optCache.set(ticker, { agg: sig.agg, prices: [...hist, chain.underlying.price].slice(-30) });
  // fire-and-forget — never awaited, wrapped internally; a logging failure cannot affect this response (req 10)
  // Entry option price = ATM contract on the signal's side, captured at signal time (never back-filled).
  let entryOption = null;
  try {
    const spot = chain.underlying && chain.underlying.price;
    const want = sig.dir === 'bull' ? 'call' : 'put';
    if (isNumS(spot) && Array.isArray(chain.contracts)) {
      const cands = chain.contracts.filter((c) => c && c.type === want && isNumS(c.strike) && (isNumS(c.bid) || isNumS(c.ask) || isNumS(c.last)));
      if (cands.length) {
        const atm = cands.reduce((best, c) => (Math.abs(c.strike - spot) < Math.abs(best.strike - spot) ? c : best), cands[0]);
        const mid = (isNumS(atm.bid) && isNumS(atm.ask)) ? (atm.bid + atm.ask) / 2 : (isNumS(atm.last) ? atm.last : null);
        if (isNumS(mid)) entryOption = Math.round(mid * 100) / 100;
      }
    }
  } catch (e) { entryOption = null; }
  const _vsVwap = (isNumS(vwap) && isNumS(chain.underlying && chain.underlying.price) && vwap > 0) ? Math.round(((chain.underlying.price - vwap) / vwap) * 10000) / 100 : null;
  const _chg = (chain.underlying && isNumS(chain.underlying.price) && isNumS(chain.underlying.prevClose) && chain.underlying.prevClose > 0) ? Math.round(((chain.underlying.price - chain.underlying.prevClose) / chain.underlying.prevClose) * 10000) / 100 : null;
  // fire-and-forget — never awaited, wrapped internally; a logging failure cannot affect this response (req 10)
  // ATR(14) from the daily bars already fetched — real value or null, never a guess.
  let _atr = null;
  try {
    if (Array.isArray(ohlcBars) && ohlcBars.length >= 15) {
      const b = ohlcBars.slice(-15), trs = [];
      for (let i = 1; i < b.length; i++) {
        const h = b[i].high, l = b[i].low, pc = b[i - 1].close;
        if (isNumS(h) && isNumS(l) && isNumS(pc)) trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
      }
      if (trs.length >= 10) _atr = Math.round((trs.reduce((x, y) => x + y, 0) / trs.length) * 100) / 100;
    }
  } catch (e) { _atr = null; }
  // ---- v2 SHADOW PATH (spec phases 2-5). Computed alongside, never overrides production. ----
  let v2 = null, v2state = null;
  try {
    const trades = (chain.flow && Array.isArray(chain.flow.largeTrades)) ? chain.flow.largeTrades : [];
    const nowIso = new Date().toISOString();
    const rawFlow = trades.length ? (await import('./engine/features.js')).signedFlow(trades, { spot: chain.underlying && chain.underlying.price }) : null;
    // per-ticker same-time-of-day normalization (strictly backward-looking)
    let normalized = {};
    if (rawFlow && rawFlow.available) {
      normalized = await BASELINES.normalizeAndRecord(ticker, {
        deltaWeightedSignedFlow: rawFlow.deltaWeightedSignedFlow,
        openingDeltaFlow: rawFlow.openingDeltaFlow,
        flowIntensity: rawFlow.flowIntensity,
      }, nowIso);
    }
    // ---- real Phase-4 context inputs (null only when genuinely unavailable) ----
    const _flags = eventFlags(new Date());
    let _rvol = { available: false, rvol: null }, _mkt = { spyTrend: null, qqqTrend: null }, _ivc = { available: false }, _earn = null;
    try { if (_intraday) _rvol = await computeRvol({ baselines: BASELINES, ticker, intraday: _intraday, at: nowIso }); } catch (e) { /* rvol optional */ }
    try { _mkt = await MARKET_CTX.get(); } catch (e) { /* market optional */ }
    try { _ivc = IV_SKEW.update(ticker, chain.contracts || [], chain.underlying && chain.underlying.price); } catch (e) { /* iv optional */ }
    try { _earn = await EARNINGS.daysAway(ticker); } catch (e) { _earn = null; }
    // §5 sector relative strength from UW sector-tide (no external provider)
    let _sector = { state: 'UNAVAILABLE' };
    try {
      if (Date.now() - SECTOR_TIDE.at > 5 * 60000 && OPT_PROVIDER.getSectorTide) { SECTOR_TIDE.data = await OPT_PROVIDER.getSectorTide(); SECTOR_TIDE.at = Date.now(); }
      let secName = null;
      try { const comp = await OPT_PROVIDER.getCompanies([ticker]); secName = comp && comp[ticker] ? comp[ticker].sector : null; } catch (e) { secName = null; }
      _sector = sectorRelativeStrength({ ticker, sector: secName, sectorTide: SECTOR_TIDE.data, marketTide: null });
    } catch (e) { _sector = { state: 'UNAVAILABLE', reason: 'SECTOR_LOOKUP_FAILED' }; }
    READINESS.rvol = rvolReadiness({ baselines: BASELINES, ticker, bucket: _flags.timeBucket, rvolResult: _rvol });
    READINESS.ivSkew = ivSkewReadiness(_ivc);
    READINESS.sector = _sector;

    v2 = scoreV2({
      ticker, at: nowIso, trades, normalized,
      prevFlow: V2_PREVFLOW.get(ticker) ?? null,
      spot: chain.underlying && chain.underlying.price, vwap: isNumS(vwap) ? vwap : null, atr: _atr,
      gex: sig.agg && isNumS(sig.agg.gex) ? sig.agg.gex : null,
      gammaFlip: sig.agg && isNumS(sig.agg.gammaFlip) ? sig.agg.gammaFlip : null,
      callWall: sig.walls ? sig.walls.call : null, putWall: sig.walls ? sig.walls.put : null,
      previousRegime: (V2_STATE.get(ticker) || {}).gammaRegime || null,
      rvol: _rvol.available ? _rvol.rvol : null,
      market: { spyTrend: _mkt.spyTrend, qqqTrend: _mkt.qqqTrend, sectorTrend: _sector.sectorTrend || null, relativeStrength: _sector.sectorRelativeStrength ?? null },
      ivChanges: _ivc.available ? _ivc : {},
      events: { timeBucket: _flags.timeBucket, isOpex: _flags.isOpex, earningsDaysAway: _earn },
      vwapSlope: null, ret5m: null, ret15m: null, ret30m: null,
    });
    if (rawFlow && rawFlow.available) V2_PREVFLOW.set(ticker, rawFlow.deltaWeightedSignedFlow);
    if (v2 && v2.available) {
      const prevState = V2_STATE.get(ticker) || null;
      v2state = stateStep(prevState, { score: v2.score, dir: v2.dir, at: nowIso });
      v2state.gammaRegime = v2.gamma && v2.gamma.available ? v2.gamma.regime : null;
      V2_STATE.set(ticker, v2state);
      sig.v2 = { version: V2_VERSION, score: v2.score, dir: v2.dir, state: v2state.state, smoothedScore: v2state.smoothedScore,
        actionable: isActionable(v2state.state), coverage: v2.coverage, components: v2.components,
        multipliers: v2.multipliers, reasons: v2.reasons, quality: v2.quality, gated: v2.gated,
        note: 'shadow only — production score is unchanged' };
    }
  } catch (e) { sig.v2 = { error: e.message, note: 'shadow path failed; production unaffected' }; }

  void logSignal({ provider: OPT_PROVIDER, ticker, sig, scoredAgg, underlying: chain.underlying || null, prevHadSnapshot: !!prev.agg, now: new Date(), entryOption, vsVwapPct: _vsVwap, changePct: _chg, atr: _atr, vwap: isNumS(vwap) ? vwap : null, v2: sig.v2 || null });
  return { ok: true, signal: sig, chain };
}

app.get('/api/options/:ticker', requireAuth, async (req, res) => {
  const ticker = safeTicker(req.params.ticker);
  if (!ticker) return res.json({ ok: false, error: 'Invalid ticker', provider: OPT_PROVIDER.name, normalized: null });
  if (OPT_PROVIDER.name === 'null') {
    return res.json({ ok: false, provider: 'null', error: OPT_PROVIDER.reason || 'Insufficient options data — no options provider configured (set OPTIONS_PROVIDER + OPTIONS_API_KEY)', normalized: null });
  }
  try {
    const built = await buildTickerSignal(ticker);
    const sig = built.signal; const chain = built.chain;
    const contracts = (chain.contracts || []).slice().sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 60);
    res.json({ ok: true, provider: OPT_PROVIDER.name, ts: new Date().toISOString(), signal: sig, chain: { ticker, underlying: chain.underlying, fieldsAvailable: chain.fieldsAvailable, contracts } });
  } catch (e) {
    res.json({ ok: false, provider: OPT_PROVIDER.name, error: e.message, normalized: null }); // 403/paywall surfaces here; no fabrication
  }
});

// ---- ADVISORY AI layer (OpenRouter). On-demand only. Never alters the deterministic signal. ----
app.post('/api/ai/analyze/:ticker', requireAuth, async (req, res) => {
  const ticker = safeTicker(req.params.ticker);
  if (!ticker) return res.json({ ok: false, error: 'Invalid ticker' });
  if (!AI.client.available || !AI.cfg.enabled) return res.json({ ok: false, error: 'AI layer not configured (set OPENROUTER_API_KEY)', aiEnabled: false });
  // cache
  const hit = aiCache.get(ticker);
  if (hit && (Date.now() - hit.ts) < AI.cfg.cacheTtlMs) return res.json({ ok: true, cached: true, ...hit.payload });
  let built;
  try { built = await buildTickerSignal(ticker); } catch (e) { return res.json({ ok: false, error: 'options data error: ' + e.message }); }
  if (!built.ok || !built.signal) return res.json({ ok: false, error: built.error || 'no options data for ticker' });
  const sig = built.signal;
  // gather real extras for AI context (no fabrication; each optional)
  const extras = { ticker };
  try { if (OPT_PROVIDER.name !== 'null' && OPT_PROVIDER.getNetPremium) { const np = await OPT_PROVIDER.getNetPremium(ticker); if (np && np.available) extras.netPremium = np; } } catch (e) {}
  if (built.chain && built.chain.flow && built.chain.flow.largeTrades) extras.sweeps = built.chain.flow.largeTrades;
  const context = buildAiContext(sig, extras);
  const split = AI.cfg.models.analyst !== AI.cfg.models.manager;   // single call when identical → no extra cost
  const llm = (messages, o = {}) => AI.client.chat({ messages, model: (AI.cfg.models[o.role] || AI.cfg.model), reasoning: !!(AI.cfg.reasoning && AI.cfg.reasoning[o.role]), responseFormat: AI.cfg.structured ? { type: 'json_object' } : undefined });
  const r = await runAnalysis({ signal: sig, context, extras, split, llm });
  if (!r.ok) { await persistAiRun(ticker, { ts: new Date().toISOString(), ticker, model: r.model || AI.cfg.model, deterministic: { finalScore: sig.finalScore, dir: sig.dir, tier: sig.tier }, error: r.error || 'AI analysis failed' }); return res.json({ ok: false, error: r.error || 'AI analysis failed', signal: publicSignal(sig) }); }
  const payload = { provider: OPT_PROVIDER.name, model: r.model, ts: new Date().toISOString(), signal: publicSignal(sig), ai: r.ai };
  aiCache.set(ticker, { ts: Date.now(), payload });
  await persistAiRun(ticker, { ts: payload.ts, ticker, model: r.model, deterministic: { finalScore: sig.finalScore, dir: sig.dir, tier: sig.tier }, aiView: r.ai.aiView, aiConfidence: r.ai.aiConfidence });
  res.json({ ok: true, cached: false, ...payload });
});

// AI-run history (only when AI_PERSIST=true). Read-only; never feeds scoring/backtest.
app.get('/api/ai/history/:ticker', requireAuth, async (req, res) => {
  const ticker = safeTicker(req.params.ticker);
  if (!ticker) return res.json({ ok: false, error: 'Invalid ticker' });
  if (!AI_PERSIST) return res.json({ ok: true, enabled: false, runs: [] });
  try {
    const txt = await fs.promises.readFile(path.join(AI_LOG_DIR, `${ticker}.jsonl`), 'utf8');
    const runs = txt.split('\n').filter(Boolean).slice(-50).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    res.json({ ok: true, enabled: true, runs });
  } catch (e) { res.json({ ok: true, enabled: true, runs: [] }); }
});
// PHASE 2 market-regime endpoint (shadow-only conditioning; cannot affect the live score)
app.get('/api/shadow/market', requireAuth, async (req, res) => {
  if (OPT_PROVIDER.name === 'null') return res.json({ ok: false, error: 'Requires a configured options provider (set OPTIONS_PROVIDER + key).' });
  try { const ctx = await shadowMarketContext(); let sectorTide = null; try { if (OPT_PROVIDER.getSectorTide) { const st = await OPT_PROVIDER.getSectorTide(); if (st && st.available) sectorTide = st.rows; } } catch {}
    res.json({ ok: true, ts: new Date().toISOString(), regime: marketRegimeNow(ctx), context: { indexGex: ctx.indexGex, indexMomentumRet: ctx.indexMomentumRet, tideNet: ctx.tideNet, dix: ctx.dix }, sectorTide, note: 'SHADOW ONLY — not used in the live score' });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// PHASE 2 cross-sectional ranking across the S&P 500 (shadow-only; from PVE's own cross-section endpoints)
app.get('/api/shadow/cross-section', requireAuth, async (req, res) => {
  if (OPT_PROVIDER.name === 'null') return res.json({ ok: false, error: 'Requires a configured options provider (set OPTIONS_PROVIDER + key).' });
  try {
    const xs = await buildLiteCrossSection();
    if (!xs.available) return res.json({ ok: true, available: false, reason: 'No cross-sectional data from PVE /screener yet (post-deploy warming or empty). Try again shortly.', ranked: [], sectors: {} });
    const ranks = computeCrossSectional(xs.records, XSEC_FEATURES, { absKeys: XSEC_ABS, compositeKeys: XSEC_FEATURES });
    const breadth = computeSectorBreadth(xs.records);
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const ranked = xs.records.map((r) => ({ ticker: r.ticker, sector: r.sector, direction: r.direction, composite: (ranks.perTicker[r.ticker] || {}).composite, ranks: (ranks.perTicker[r.ticker] || {}).ranks }))
      .filter((r) => isNumS(r.composite)).sort((a, b) => b.composite - a.composite).slice(0, limit);
    res.json({ ok: true, available: true, version: CROSS_SECTIONAL_VERSION, populationSize: ranks.populationSize, features: XSEC_FEATURES, ranked, sectors: breadth.sectors, note: 'SHADOW ONLY — not used in the live score. Ranks are relative notability, not a directional score.' });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ---- PHASE 1 SHADOW endpoint (research/observation only). Fetches PVE via read-only adapters and
// runs the pure shadow engine. It NEVER calls the scoring path and cannot alter the live signal. ----
const shadowMktCache = { ts: 0, data: null };
async function shadowMarketContext() {
  if (OPT_PROVIDER.name === 'null') return {};
  if (shadowMktCache.data && (Date.now() - shadowMktCache.ts) < 60000) return shadowMktCache.data;
  const out = { indexGex: null, indexMomentumRet: null, tideNet: null };
  try { const g = await OPT_PROVIDER.getGex('SPY'); if (g && g.available && isNumS(g.net_gex)) { out.indexGex = g.net_gex; out.gexRegime = g.net_gex > 0 ? 'positive' : (g.net_gex < 0 ? 'negative' : 'neutral'); } } catch {}
  try { if (OPT_PROVIDER.getMarketTide) { const t = await OPT_PROVIDER.getMarketTide(); if (t && t.available && isNumS(t.net_premium)) { out.tideNet = t.net_premium; out.tideDirection = t.net_premium > 0 ? 'bullish' : (t.net_premium < 0 ? 'bearish' : 'neutral'); } } } catch {}
  try { if (OPT_PROVIDER.getDarkpool) { const d = await OPT_PROVIDER.getDarkpool('SPY'); if (d && d.available && isNumS(d.dix)) out.dix = d.dix; } } catch {}
  try { if (OPT_PROVIDER.getOhlc) { const o = await OPT_PROVIDER.getOhlc('SPY'); const m = momentum(o && o.bars ? o.bars : o); if (m && m.available) out.indexMomentumRet = m.ret; } } catch {}
  shadowMktCache.ts = Date.now(); shadowMktCache.data = out; return out;
}
function marketRegimeNow(ctx) { return marketRegimeState({ indexGex: ctx.indexGex, indexMomentumRet: ctx.indexMomentumRet, tideNet: ctx.tideNet, dix: ctx.dix }); }

// Lite live cross-section from PVE's own cross-sectional endpoints (screener + top/iv-rank + companies).
// Real data, cheap (~3 calls), cached 60s. No fabrication: ranks only fields actually present.
const XSEC_FEATURES = ['netPremium', 'totalPremium', 'sweeps', 'ivRank'];
const XSEC_ABS = ['netPremium', 'totalPremium'];
const xsecCache = { ts: 0, data: null };
async function buildLiteCrossSection() {
  if (OPT_PROVIDER.name === 'null') return { available: false, records: [] };
  if (xsecCache.data && (Date.now() - xsecCache.ts) < 60000) return xsecCache.data;
  let screener = { rows: [] }, tiv = { rows: [] };
  try { screener = await OPT_PROVIDER.getScreener({ range: '1d', limit: 100 }); } catch {}
  try { tiv = await OPT_PROVIDER.getTopIvRank({ direction: 'high', limit: 250 }); } catch {}
  const rows = (screener && screener.rows) || [];
  if (!rows.length) { const empty = { available: false, records: [] }; xsecCache.ts = Date.now(); xsecCache.data = empty; return empty; }
  const ivMap = {}; for (const r of (tiv && tiv.rows) || []) ivMap[r.ticker] = r.ivRank;
  let companies = {}; try { companies = await OPT_PROVIDER.getCompanies(rows.map((r) => r.ticker)); } catch {}
  const records = rows.map((r) => {
    const net = isNumS(r.netPremium) ? r.netPremium : ((isNumS(r.callPremium) && isNumS(r.putPremium)) ? r.callPremium - r.putPremium : null);
    return { ticker: r.ticker, sector: companies[r.ticker] ? companies[r.ticker].sector : null,
      direction: isNumS(net) ? (net > 0 ? 'bullish' : net < 0 ? 'bearish' : 'neutral') : 'neutral',
      features: { netPremium: net, totalPremium: r.premium, sweeps: r.sweeps, ivRank: isNumS(ivMap[r.ticker]) ? ivMap[r.ticker] : null } };
  });
  const data = { available: true, records };
  xsecCache.ts = Date.now(); xsecCache.data = data; return data;
}
// best-effort read of the latest captured snapshot for ΔGEX (no research-module import; scoring-independent)
async function latestSnapshotFor(ticker) {
  const dir = process.env.RESEARCH_SNAPSHOT_DIR; if (!dir) return null;
  try { const file = path.join(dir, `snapshots-${new Date().toISOString().slice(0, 10)}.jsonl`); const txt = await fs.promises.readFile(file, 'utf8');
    const rows = txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.ticker === ticker);
    return rows.length ? rows[rows.length - 1] : null;
  } catch { return null; }
}
// Build the full shadow block for a ticker (used by /api/shadow and /api/validated). Read-only.
async function buildShadowBlock(ticker) {
  const P = OPT_PROVIDER; const opt = (fn, ...a) => (typeof P[fn] === 'function' ? P[fn](...a).catch(() => null) : Promise.resolve(null));
  const [gex, byStrike, ivRank, skew, term, flow, netPremium, chainRes, ohlc, darkpool, prevSnapshot, market] = await Promise.all([
    opt('getGex', ticker), opt('getByStrikeGex', ticker), opt('getIvRank', ticker), opt('getSkew', ticker), opt('getTermStructure', ticker),
    opt('getFlowDetailed', ticker), opt('getNetPremium', ticker), opt('getChain', ticker), opt('getOhlc', ticker), opt('getDarkpool', ticker),
    latestSnapshotFor(ticker), shadowMarketContext(),
  ]);
  const chain = chainRes && chainRes.chain ? chainRes.chain : null;
  const underlying = chain && chain.underlying ? chain.underlying : null;
  const marketWithDix = { ...(market || {}) };
  const shadow = computeShadow({ gex, byStrike, ivRank, skew, termStructure: term, flow, netPremium, underlying, ohlc, chain, market: marketWithDix, prevSnapshot });
  try { shadow.marketRegime = marketRegimeNow(market || {}); } catch {}
  try { const e = await (OPT_PROVIDER.getEarnings ? OPT_PROVIDER.getEarnings(ticker) : Promise.resolve(null)); if (e) shadow.earnings = { available: !!e.available, nextDate: e.nextDate || null, daysToEarnings: isNumS(e.daysToEarnings) ? e.daysToEarnings : null, proximity: classifyEarningsProximity(e.daysToEarnings) }; } catch {}
  try {
    const xs = await buildLiteCrossSection();
    if (xs.available) {
      const ranks = computeCrossSectional(xs.records, XSEC_FEATURES, { absKeys: XSEC_ABS, compositeKeys: XSEC_FEATURES });
      const br = computeSectorBreadth(xs.records);
      shadow.crossSectional = { version: CROSS_SECTIONAL_VERSION, populationSize: ranks.populationSize, inUniverse: !!ranks.perTicker[ticker], ...(ranks.perTicker[ticker] || {}) };
      if (br.perTicker[ticker]) shadow.sectorBreadth = br.perTicker[ticker];
    }
  } catch {}
  return shadow;
}
// Normalize a shadow block into validated-model feature inputs (~[-1,1]). Used only if a feature is promoted.
function shadowToFeatureInputs(shadow) {
  if (!shadow) return {};
  const s3 = (l) => (l === 'bullish' || l === 'bull' ? 1 : l === 'bearish' || l === 'bear' ? -1 : 0);
  const pct = (x) => (isNumS(x) ? x / 50 - 1 : null);         // 0..100 percentile → -1..1
  const q = (x) => (isNumS(x) ? Math.max(-1, Math.min(1, x / 50 - 1)) : null); // 0..100 quality → -1..1
  const inputs = {
    flowDirection: s3(shadow.flow && shadow.flow.direction),
    flowQuality: q(shadow.flow && shadow.flow.quality),
    gexRegime: shadow.regime ? (shadow.regime.gex === 'positive' ? 1 : shadow.regime.gex === 'negative' ? -1 : 0) : 0,
    skew: s3(shadow.iv && shadow.iv.skewLabel),
    ivSpread: s3(shadow.iv && shadow.iv.ivSpreadLabel),
    momentum: s3(shadow.momentum && shadow.momentum.label),
    vrp: shadow.vrp && isNumS(shadow.vrp.value) ? Math.max(-1, Math.min(1, shadow.vrp.value * 10)) : null,
    crossSectionalRank: shadow.crossSectional ? pct(shadow.crossSectional.composite) : null,
    sectorBreadth: shadow.sectorBreadth ? (shadow.sectorBreadth.aligned ? (shadow.sectorBreadth.breadthPct / 100) : 0) : null,
  };
  const clean = {}; for (const [k, v] of Object.entries(inputs)) if (isNumS(v)) clean[k] = v;
  return clean;
}
app.get('/api/shadow/:ticker', requireAuth, async (req, res) => {
  const ticker = safeTicker(req.params.ticker);
  if (!ticker) return res.json({ ok: false, error: 'Invalid ticker' });
  if (OPT_PROVIDER.name === 'null') return res.json({ ok: false, error: 'Shadow features require a configured options provider.' });
  try { const shadow = await buildShadowBlock(ticker); res.json({ ok: true, provider: 'pve', ticker, ts: new Date().toISOString(), shadow, note: 'SHADOW ONLY — not used in the live score' }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// ON-DEMAND SCAN — the ONLY thing that spends options-provider quota in bulk. Deliberately manual
// (no timer) so API usage is user-triggered. One run at a time; the child is detached from the request.
const BASELINES = new BaselineStore();
const V2_STATE = new Map();          // ticker -> anti-flicker state (in-memory, per process)
const V2_PREVFLOW = new Map();       // ticker -> previous delta-weighted flow (for acceleration)
const MARKET_CTX = new MarketContext(OPT_PROVIDER);   // SPY/QQQ fetched once per 5 min, shared
const IV_SKEW = new IvSkewTracker();
const EARNINGS = new EarningsCalendar(OPT_PROVIDER);
const SECTOR_TIDE = { data: null, at: 0 };
const READINESS = { rvol: null, ivSkew: null, sector: null };

const SCAN_STATE = { running: false, startedAt: null, finishedAt: null, lastOk: null, message: '', limit: null };
app.post('/api/scan/run', requireAuth, (req, res) => {
  if (OPT_PROVIDER.name === 'null') return res.status(400).json({ ok: false, error: 'No options provider configured', reason: OPT_PROVIDER.reason || null });
  if (SCAN_STATE.running) return res.status(409).json({ ok: false, error: 'A scan is already running', state: SCAN_STATE });
  const limit = Math.max(1, Math.min(500, Number(req.body && req.body.limit) || Number(process.env.SCAN_LIMIT) || 500));
  const script = path.join(__dirname, 'research', 'scan-universe.js');
  if (!fs.existsSync(script)) return res.status(500).json({ ok: false, error: 'scan-universe.js not found' });
  SCAN_STATE.running = true; SCAN_STATE.startedAt = new Date().toISOString(); SCAN_STATE.finishedAt = null; SCAN_STATE.lastOk = null; SCAN_STATE.message = 'running'; SCAN_STATE.limit = limit;
  const child = spawn(process.execPath, [script], { cwd: __dirname, env: { ...process.env, SCAN_LIMIT: String(limit) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const grab = (b) => { tail = (tail + b.toString()).slice(-2000); };
  child.stdout.on('data', grab); child.stderr.on('data', grab);
  child.on('close', (code) => {
    SCAN_STATE.running = false; SCAN_STATE.finishedAt = new Date().toISOString();
    SCAN_STATE.lastOk = code === 0; SCAN_STATE.message = (tail.trim().split('\n').pop() || `exit ${code}`).slice(0, 300);
  });
  child.on('error', (e) => { SCAN_STATE.running = false; SCAN_STATE.finishedAt = new Date().toISOString(); SCAN_STATE.lastOk = false; SCAN_STATE.message = e.message; });
  res.json({ ok: true, started: true, limit, state: SCAN_STATE });
});
app.get('/api/scan/status', requireAuth, (req, res) => res.json({ ok: true, ...SCAN_STATE }));

// MAIN SIGNALS FEED — serves the universe scan cache (production + shadow per ticker) for /signals.
// Fast: reads the cache written by research/scan-universe.js (no PVE calls on page load). Never fabricates.
const SCAN_CACHE = path.join(process.env.SCAN_DIR || path.join(__dirname, 'research-data', 'scan'), 'latest.json');
app.get('/api/signals/us', requireAuth, (req, res) => {
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(SCAN_CACHE, 'utf8')); } catch { /* not scanned yet */ }
  if (!cache || !Array.isArray(cache.rows)) {
    return res.json({ ok: true, available: false, reason: 'No scan yet — press “Run Scan” to fetch fresh data.', dataStatus: 'DATA UNAVAILABLE', rows: [] });
  }
  const ageMs = Date.now() - Date.parse(cache.generatedAt || 0);
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 500));
  const rows = cache.rows.slice(0, limit);
  res.json({
    ok: true, available: true, generatedAt: cache.generatedAt, ageSeconds: Math.round(ageMs / 1000),
    dataStatus: ageMs < 20 * 60000 ? 'MARKET DATA LIVE' : 'MARKET DATA DELAYED',
    universe: cache.universe, scored: cache.scored, skipped: cache.skipped, count: rows.length,
    primary: PROMOTION.primary || 'current', promotedFeatures: (PROMOTION.approvedFeatures || []).length,
    rows,
    note: 'productionScore is the live authority; shadowScore is validation-only and never modifies it. confidence is a data/conviction score, not a probability of profit.',
  });
});

// ===== CLAUDE REVIEW — Phase A: read-only export of the Signal Journal (no production impact) =====
// The archive dir is the SAME journal the logger writes; export only READS it, never mutates.
const ARCHIVE_DIR = path.join(process.env.SIGNAL_LOG_DIR || path.join(__dirname, 'research-data', 'signal-log'));
// ---- SIGNAL JOURNAL (replaces Claude Review) -------------------------------
// Read-only over immutable signal records + append-only outcome patches.
app.get('/api/journal/list', requireAuth, (req, res) => {
  try { res.json({ ok: true, ...filterJournal(readJournal(), req.query) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/journal/signal/:id', requireAuth, (req, res) => {
  try {
    const rec = readSignal(req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, signal: rec });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/journal/stats', requireAuth, (req, res) => {
  try {
    const recs = readJournal();
    res.json({ ok: true, learning: computeLearning(recs, { horizon: req.query.horizon || '1h' }), pending: pendingOutcomes(recs).length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// On-demand outcome resolution (spends provider quota only when pressed).
const RESOLVE_STATE = { running: false, startedAt: null, finishedAt: null, lastOk: null, message: '' };
app.post('/api/journal/resolve', requireAuth, (req, res) => {
  if (OPT_PROVIDER.name === 'null') return res.status(400).json({ ok: false, error: 'No options provider configured', reason: OPT_PROVIDER.reason || null });
  if (RESOLVE_STATE.running) return res.status(409).json({ ok: false, error: 'Already resolving' });
  const script = path.join(__dirname, 'research', 'resolve-outcomes.js');
  if (!fs.existsSync(script)) return res.status(500).json({ ok: false, error: 'resolve-outcomes.js not found' });
  RESOLVE_STATE.running = true; RESOLVE_STATE.startedAt = new Date().toISOString(); RESOLVE_STATE.lastOk = null; RESOLVE_STATE.message = 'running';
  const child = spawn(process.execPath, [script], { cwd: __dirname, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = ''; const grab = (b) => { tail = (tail + b.toString()).slice(-2000); };
  child.stdout.on('data', grab); child.stderr.on('data', grab);
  child.on('close', (code) => { RESOLVE_STATE.running = false; RESOLVE_STATE.finishedAt = new Date().toISOString(); RESOLVE_STATE.lastOk = code === 0; RESOLVE_STATE.message = (tail.trim().split('\n').pop() || `exit ${code}`).slice(0, 300); });
  child.on('error', (e) => { RESOLVE_STATE.running = false; RESOLVE_STATE.lastOk = false; RESOLVE_STATE.message = e.message; });
  res.json({ ok: true, started: true });
});
app.get('/api/research/readiness', requireAuth, (req, res) => {
  try {
    const recs = readJournal();
    const report = baselineReport(recs);
    res.json({ ok: true, readiness: researchReadiness({
      report, journalCount: recs.length,
      rvol: READINESS.rvol, ivSkew: READINESS.ivSkew, sector: READINESS.sector,
      macro: macroReadiness({ uwSupportsMacroCalendar: false }),
    }), uw: { ...UW_LIMITER.stats(), ...optionsProviderStatus(process.env) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/journal/evaluation', requireAuth, (req, res) => {
  try { res.json({ ok: true, report: baselineReport(readJournal()) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/journal/resolve/status', requireAuth, (req, res) => res.json({ ok: true, ...RESOLVE_STATE }));
// PHASE 4 validated ranking across the (cross-section) universe. Bounded; current stays primary.
app.get('/api/validated/ranking', requireAuth, async (req, res) => {
  if (OPT_PROVIDER.name === 'null') return res.json({ ok: false, error: 'Requires a configured options provider (set OPTIONS_PROVIDER + key).' });
  try {
    const xs = await buildLiteCrossSection();
    if (!xs.available) return res.json({ ok: true, available: false, reason: 'No cross-sectional universe yet.', ranked: [] });
    const ranks = computeCrossSectional(xs.records, XSEC_FEATURES, { absKeys: XSEC_ABS, compositeKeys: XSEC_FEATURES });
    const topN = Math.max(1, Math.min(50, Number(req.query.limit) || 25));
    const names = xs.records.map((r) => r.ticker).filter((t) => (ranks.perTicker[t] || {}).composite != null)
      .sort((a, b) => (ranks.perTicker[b].composite) - (ranks.perTicker[a].composite)).slice(0, topN);
    const out = [];
    for (const t of names) {                       // bounded per-ticker current-score computation
      try { const built = await buildTickerSignal(t); const sig = built.signal; if (!sig) continue;
        const v = computeValidated({ current: { score: sig.finalScore, dir: sig.dir, tier: sig.tier }, featureInputs: {}, promotion: PROMOTION });
        out.push({ ticker: t, current: sig.finalScore, validated: v.validatedScore, delta: v.delta, dir: sig.dir, tier: v.tier });
      } catch {}
    }
    out.sort((a, b) => (b.validated ?? -1) - (a.validated ?? -1));
    res.json({ ok: true, available: true, primary: PROMOTION.primary || 'current', promotedFeatures: (PROMOTION.approvedFeatures || []).length, count: out.length, ranked: out, note: (PROMOTION.approvedFeatures || []).length ? 'Ranked by validated score.' : 'No features promoted → validated mirrors current; ranking equals current-score ranking.' });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});


// PHASE 4 validated score (runs ALONGSIDE current; current stays primary). Never changes /api/options.
app.get('/api/validated/:ticker', requireAuth, async (req, res) => {
  const ticker = safeTicker(req.params.ticker);
  if (!ticker) return res.json({ ok: false, error: 'Invalid ticker' });
  if (OPT_PROVIDER.name === 'null') return res.json({ ok: false, error: OPT_PROVIDER.reason || 'No options provider configured' });
  try {
    const built = await buildTickerSignal(ticker); const sig = built.signal;
    if (!sig) return res.json({ ok: false, error: built.error || 'no signal' });
    let featureInputs = {}; try { featureInputs = shadowToFeatureInputs(await buildShadowBlock(ticker)); } catch {}
    const validated = computeValidated({ current: { score: sig.finalScore, dir: sig.dir, tier: sig.tier }, featureInputs, promotion: PROMOTION });
    res.json({ ok: true, provider: OPT_PROVIDER.name, ticker, ts: new Date().toISOString(),
      current: { score: sig.finalScore, dir: sig.dir, tier: sig.tier }, validated,
      promotion: { primary: PROMOTION.primary || 'current', approvedFeatures: PROMOTION.approvedFeatures || [], calibrated: !!(PROMOTION.calibration && PROMOTION.calibration.validated) },
      note: 'Current score remains the production baseline. Validated score is research-backed and shown for comparison.' });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// compact, safe view of the deterministic signal for the AI response (authority fields intact)
function publicSignal(sig) {
  return { ticker: sig.ticker, finalScore: sig.finalScore, dir: sig.dir, tier: sig.tier, optionsScore: sig.optionsScore, stockScore: sig.stockScore, dataQualityStatus: sig.dataQualityStatus, dataQuality: sig.dataQuality, gexSource: sig.gexSource, ivRank: sig.ivRank, walls: sig.walls, agg: sig.agg ? { gex: sig.agg.gex, gammaFlip: sig.agg.gammaFlip, maxPain: sig.agg.maxPain } : null };
}

app.get('/api/_monitor', requireAuth, (req, res) => res.json({
  logs: monitor, endpoints: [...lastResponse.keys()], live: !!CONFIG.AGENT_KEY, baseUrl: CONFIG.BASE_URL,
  engineVersion: ENGINE_VERSION, classifierVersion: CLASSIFIER_VERSION, optionsEngineVersion: OPTIONS_ENGINE_VERSION, shadowEngineVersion: SHADOW_ENGINE_VERSION, crossSectionalVersion: CROSS_SECTIONAL_VERSION, validatedModelVersion: VALIDATED_MODEL_VERSION,
  validated: { primary: PROMOTION.primary || 'current', promotedFeatures: (PROMOTION.approvedFeatures || []).length, calibrated: !!(PROMOTION.calibration && PROMOTION.calibration.validated) },
  optionsProvider: optionsProviderStatus(process.env), ai: { enabled: AI.cfg.enabled, configured: AI.client.available, model: AI.cfg.model }, classify: lastClassify.stats,
}));
app.get('/api/_inspect', requireAuth, (req, res) => res.json(lastResponse.get(req.query.endpoint) || { error: 'no data captured for ' + req.query.endpoint }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

export const httpServer = app.listen(CONFIG.PORT, () => {
  console.log(`\n  PVE Signal Engine → http://localhost:${CONFIG.PORT}`);
  console.log(`  Options data: Unusual Whales only (PVE Trade API removed)`);
  console.log(`  Password: ${CONFIG.PASSWORD === 'SatyajitDD7' ? 'SatyajitDD7 (default — change DASHBOARD_PASSWORD in .env)' : '[custom]'}\n`);
});
