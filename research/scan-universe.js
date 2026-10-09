// @ts-check
/*
 * research/scan-universe.js — builds the /signals display cache. For the active options universe
 * (PVE /screener), it computes the CURRENT production score (buildOptionsSignal, same authority as
 * the server) AND the shadow score (computeShadow) per ticker, then writes one JSON snapshot that
 * GET /api/signals/us serves instantly. Runs on a timer (see deploy/pve-scan.*), throttled to stay
 * under PVE's 10 req/s. Never imported by the server. Missing PVE fields stay null — nothing faked.
 *
 *   SCAN_DIR=./research-data/scan SCAN_LIMIT=500 node research/scan-universe.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { crossSectionalRank } from '../engine/context.js';
import { scoreV2, V2_VERSION } from '../engine/v2.js';
import { signedFlow } from '../engine/features.js';
import { BaselineStore } from '../store/normalize.js';
import { logSignal } from '../store/signal-log.js';

const SCAN_BASELINES = new BaselineStore();
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const g = (o, ...ks) => { let v = o; for (const k of ks) { if (v == null) return null; v = v[k]; } return v == null ? null : v; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

// ---- honest derivations (documented; never a probability of profit) ----
function marketBias(score, dir) {
  if (!isNum(score)) return 'UNAVAILABLE';
  if (score >= 80) return 'STRONG';
  if (score >= 65) return dir === 'bull' ? 'BULLISH' : dir === 'bear' ? 'BEARISH' : 'WATCH';
  if (score >= 50) return 'WATCH';
  if (score >= 35) return 'WEAK';
  return 'AVOID';
}
function signalFrom(score, dir) {
  if (!isNum(score)) return 'DATA UNAVAILABLE';
  if (score < 65) return 'WATCH';
  return dir === 'bull' ? 'CALL' : dir === 'bear' ? 'PUT' : 'WATCH';
}
function agreement(prod, shadow) {
  if (!isNum(shadow)) return 'INSUFFICIENT';
  const d = Math.abs(shadow - prod);
  return d <= 5 ? 'HIGH' : d <= 15 ? 'MODERATE' : 'DIVERGENCE';
}
function liquidityBucket(chain) {
  const rows = (chain && chain.contracts) || [];
  let vol = 0, oi = 0; for (const c of rows) { if (isNum(c.volume)) vol += c.volume; if (isNum(c.openInterest)) oi += c.openInterest; }
  if (!rows.length) return null;                       // unavailable
  const liq = vol + oi;
  return liq >= 200000 ? 'HIGH' : liq >= 40000 ? 'MED' : 'LOW';
}
function relativeVolume(ohlc, todayVol) {
  const bars = (ohlc && ohlc.bars) || (Array.isArray(ohlc) ? ohlc : []);
  const vols = bars.map((b) => b.volume).filter(isNum); if (vols.length < 5 || !isNum(todayVol)) return null;
  const avg = vols.slice(-20).reduce((s, x) => s + x, 0) / Math.min(20, vols.length);
  return avg > 0 ? Math.round((todayVol / avg) * 100) / 100 : null;
}

async function computeRow(P, ticker, opt) {
  const { buildOptionsSignal, computeShadow, sectorMap } = opt;
  let chainRes = null, chainErr = null;
  try { chainRes = await P.getChain(ticker); } catch (e) { chainErr = e.message || String(e); }
  const chain = chainRes && chainRes.chain ? chainRes.chain : null;
  if (!chain) return { ticker, error: chainErr || 'no chain', shadowStatus: 'INSUFFICIENT' };
  const [underlyingRes, gex, byStrike, ivRank, skew, term] = await Promise.all([
    P.getUnderlying(ticker).catch(() => null), P.getGex(ticker).catch(() => null), P.getByStrikeGex(ticker).catch(() => null),
    P.getIvRank(ticker).catch(() => null), P.getSkew(ticker).catch(() => null), P.getTermStructure(ticker).catch(() => null),
  ]);
  await sleep(opt.gap);
  const [flow, netPremium, ohlc, intraday, oiChange] = await Promise.all([
    P.getFlowDetailed(ticker).catch(() => null), P.getNetPremium(ticker).catch(() => null), P.getOhlc(ticker).catch(() => null), (P.getIntraday ? P.getIntraday(ticker).catch(() => null) : Promise.resolve(null)), (P.getOiChange ? P.getOiChange(ticker).catch(() => null) : Promise.resolve(null)),
  ]);
  if (underlyingRes && underlyingRes.underlying && underlyingRes.underlying.available) { chain.underlying = { ...chain.underlying, ...underlyingRes.underlying, available: true }; if (chain.fieldsAvailable) chain.fieldsAvailable.underlying = true; }

  // PRODUCTION score — identical path to the server's buildTickerSignal (cold-start).
  const _pc = g(chain, 'underlying', 'prevClose'), _px = g(chain, 'underlying', 'price');
  const _vwap = (intraday && intraday.available && isNum(intraday.vwap)) ? intraday.vwap : null; // INTRADAY benchmark
  const _ref = isNum(_vwap) ? _vwap : _pc; // price vs VWAP intraday; falls back to prev close when market closed
  const uHist = (isNum(_ref) && _ref > 0) ? [_ref, _ref] : ((ohlc && ohlc.available && Array.isArray(ohlc.bars)) ? ohlc.bars.slice(-2).map((b) => b.close).filter(isNum) : []);
  let sig = null; try { sig = buildOptionsSignal(chain, { prevAgg: null, underlyingHist: uHist, flow: chain.flow }, {}); } catch {}
  // Real OI change from UW → synthesize the prior snapshot so the engine's directional `oiChange`
  // feature activates (no engine change; pure recompute, zero extra API calls).
  try {
    if (sig && oiChange && oiChange.available && isNum(oiChange.callOIChange) && isNum(oiChange.putOIChange)) {
      const cOI = g(sig, 'agg', 'callOI'), pOI = g(sig, 'agg', 'putOI');
      if (isNum(cOI) && isNum(pOI)) {
        const prevAgg = { callOI: Math.max(0, cOI - oiChange.callOIChange), putOI: Math.max(0, pOI - oiChange.putOIChange) };
        const sig2 = buildOptionsSignal(chain, { prevAgg, underlyingHist: uHist, flow: chain.flow }, {});
        if (sig2 && isNum(sig2.finalScore)) sig = sig2;
      }
    }
  } catch {}
  if (sig) {
    try { if (gex && gex.available) { if (isNum(gex.net_gex)) sig.agg.gex = gex.net_gex; if (isNum(gex.gamma_flip)) sig.agg.gammaFlip = gex.gamma_flip; sig.walls = { call: gex.call_wall, put: gex.put_wall }; sig.gexSource = 'pve'; } } catch {}
    try { if (ivRank && ivRank.available) { sig.ivRank = ivRank.iv_rank; sig.ivPercentile = ivRank.iv_percentile; } } catch {}
    try {
      const ss = (byStrike && byStrike.available && Array.isArray(byStrike.strikes)) ? byStrike.strikes.filter((x) => isNum(x.strike)).sort((a, b) => a.strike - b.strike) : [];
      if (ss.length) { let cw = null, cmax = -Infinity, pw = null, pmin = Infinity, cum = 0, flip = null, prevCum = 0, prev = null;
        for (const x of ss) { const cg = isNum(x.callGex) ? x.callGex : 0, pg = isNum(x.putGex) ? x.putGex : 0; if (cg > cmax) { cmax = cg; cw = x.strike; } if (pg < pmin) { pmin = pg; pw = x.strike; } cum += cg + pg; if (prev != null && ((prevCum <= 0 && cum > 0) || (prevCum >= 0 && cum < 0))) flip = x.strike; prevCum = cum; prev = x.strike; }
        // SANITY: a flip/wall far from spot is chain noise (thin strikes), not a real level — publish null rather than a bogus number.
        const _spot = g(chain, 'underlying', 'price');
        const near = (v) => isNum(v) && (!isNum(_spot) || (_spot > 0 && v > _spot * 0.5 && v < _spot * 1.5));
        sig.walls = { call: near(cw) ? cw : null, put: near(pw) ? pw : null };
        sig.agg.gammaFlip = near(flip) ? flip : null;
        sig.gexSource = 'uw'; }
    } catch {}
  }
  // ATR(14) from the daily bars already fetched — real value or null, never estimated.
  let _atr = null;
  try {
    const bars = (ohlc && ohlc.available && Array.isArray(ohlc.bars)) ? ohlc.bars.slice(-15) : [];
    if (bars.length >= 15) {
      const trs = [];
      for (let i = 1; i < bars.length; i++) {
        const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
        if (isNum(h) && isNum(l) && isNum(pc)) trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
      }
      if (trs.length >= 10) _atr = Math.round((trs.reduce((a, b) => a + b, 0) / trs.length) * 100) / 100;
    }
  } catch { _atr = null; }
  const underlying = chain.underlying && chain.underlying.available ? chain.underlying : null;
  // SHADOW score — independent; never mutates production.
  let shadow = null; try { shadow = computeShadow({ gex, byStrike, ivRank, skew, termStructure: term, flow, netPremium, underlying, ohlc, chain, market: {}, prevSnapshot: null }); } catch {}

  const price = g(chain, 'underlying', 'price');
  const prevClose = g(chain, 'underlying', 'prevClose');
  const changePct = isNum(price) && isNum(prevClose) && prevClose !== 0 ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : null;
  const productionScore = g(sig, 'finalScore');
  const shadowScore = g(shadow, 'shadowScore');
  const dir = g(sig, 'dir') || 'neutral';
  const shadowAvailable = isNum(shadowScore) && g(shadow, 'dataQuality') > 0;

  // ---- v2 SHADOW (spec §1: Run Scan computes BOTH engines from the same UW snapshot) ----
  let v2 = null;
  try {
    const trades = (chain.flow && Array.isArray(chain.flow.largeTrades)) ? chain.flow.largeTrades : [];
    const nowIso = new Date().toISOString();
    let normalized = {};
    const rawFlow = trades.length ? signedFlow(trades, { spot: price }) : null;
    if (rawFlow && rawFlow.available) {
      normalized = await SCAN_BASELINES.normalizeAndRecord(ticker, {
        deltaWeightedSignedFlow: rawFlow.deltaWeightedSignedFlow,
        openingDeltaFlow: rawFlow.openingDeltaFlow,
        flowIntensity: rawFlow.flowIntensity,
      }, nowIso);
    }
    const r = scoreV2({
      ticker, at: nowIso, trades, normalized,
      spot: price, vwap: _vwap, atr: _atr,
      gex: g(sig, 'agg', 'gex'), gammaFlip: g(sig, 'agg', 'gammaFlip'),
      callWall: sig && sig.walls ? sig.walls.call : null, putWall: sig && sig.walls ? sig.walls.put : null,
      events: { timeBucket: null },
    });
    if (r && r.available) v2 = { version: V2_VERSION, score: r.score, dir: r.dir, coverage: r.coverage, components: r.components, reasons: r.reasons, quality: r.quality, gated: r.gated };
  } catch { v2 = null; }

  // ---- persist to the Signal Journal (>=70 gate + 5-min dedupe live inside logSignal) ----
  try {
    await logSignal({ provider: P, ticker, sig, scoredAgg: sig ? sig.agg : {}, underlying, prevHadSnapshot: false,
      now: new Date(), shadowScore: isNum(shadowScore) ? shadowScore : null,
      vsVwapPct: (isNum(_vwap) && isNum(price) && _vwap > 0) ? Math.round(((price - _vwap) / _vwap) * 10000) / 100 : null,
      changePct, atr: _atr, vwap: _vwap, v2 });
  } catch { /* journaling must never break a scan */ }

  return {
    ticker, sector: sectorMap[ticker] || null,
    productionScore, shadowScore, scoreDelta: isNum(productionScore) && isNum(shadowScore) ? shadowScore - productionScore : null,
    engineAgreement: agreement(productionScore, shadowScore), signal: signalFrom(productionScore, dir), marketBias: marketBias(productionScore, dir), dir,
    confidence: g(sig, 'dataQuality'),                  // data/conviction (0-100) — NOT a probability of profit
    price, changePct, volume: g(chain, 'underlying', 'volume'),
    oiChangeNet: (oiChange && oiChange.available) ? oiChange.netOIChange : null,
    v2Score: v2 ? v2.score : null, v2Dir: v2 ? v2.dir : null, v2Coverage: v2 ? v2.coverage : null,
    vwap: _vwap, vsVwapPct: (isNum(_vwap) && isNum(_px) && _vwap > 0) ? Math.round(((_px - _vwap) / _vwap) * 10000) / 100 : null,
    relativeVolume: relativeVolume(ohlc, g(chain, 'underlying', 'volume')),
    ivRank: g(sig, 'ivRank'), optionsLiquidity: liquidityBucket(chain),
    dataQuality: g(sig, 'dataQuality'), tier: g(sig, 'tier'),
    shadowStatus: shadowAvailable ? 'VALID' : 'INSUFFICIENT',
    updatedAt: new Date().toISOString(),
  };
}

export async function main() {
  const key = process.env.OPTIONS_API_KEY || process.env.UNUSUAL_WHALES_API_TOKEN;
  const dir = process.env.SCAN_DIR || path.join(ROOT, 'research-data', 'scan');
  const limit = Math.max(1, Math.min(500, Number(process.env.SCAN_LIMIT || 500)));   // universe size (UW screener cap)
  const gap = Number(process.env.SCAN_GAP_MS || 400);
  if (!key) { console.error('OPTIONS_API_KEY required.'); process.exit(1); }
  fs.mkdirSync(dir, { recursive: true });

  const { makeOptionsProvider } = await import('../providers/options.js');
  const { buildOptionsSignal } = await import('../public/options-engine.js');
  const { computeShadow } = await import('../shadow/engine.js');
  const P = makeOptionsProvider(process.env);
  if (P.name === 'null') { console.error(P.reason || 'No options provider configured'); process.exit(1); }

  let screener = { rows: [] }; try { screener = await P.getScreener({ range: '1d', limit }); } catch (e) { console.error('screener failed:', e.message); }
  const tickers = (screener.rows || []).map((r) => r.ticker).filter(Boolean).slice(0, limit);
  if (!tickers.length) { console.error('empty universe from /screener (warming or off-hours) — wrote nothing.'); process.exit(0); }
  let sectorMap = {}; try { sectorMap = await P.getCompanies(tickers); sectorMap = Object.fromEntries(Object.entries(sectorMap).map(([k, v]) => [k, v && v.sector])); } catch {}

  let rows = []; let ok = 0, skipped = 0, rateLimited = 0;
  const started = Date.now();
  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    try { const row = await computeRow(P, t, { buildOptionsSignal, computeShadow, sectorMap, gap }); rows.push(row); if (isNum(row.productionScore)) ok++; else skipped++; }
    catch (e) {
      rows.push({ ticker: t, error: e.message, shadowStatus: 'INSUFFICIENT' }); skipped++;
      // If UW says the quota is gone, stop early and keep what we have (partial scan) rather
      // than grinding through hundreds of guaranteed failures.
      if (e && (e.rateLimited || /quota exhausted|429/i.test(String(e.message)))) {
        rateLimited++;
        if (rateLimited >= 5) { console.error(`stopping early after ${i + 1}/${tickers.length}: UW quota exhausted`); break; }
      }
    }
    if ((i + 1) % 25 === 0 || i + 1 === tickers.length) {
      const el = Math.round((Date.now() - started) / 1000);
      console.log(`  ${i + 1}/${tickers.length} scanned (${ok} scored, ${skipped} skipped) · ${el}s`);
    }
    await sleep(gap);
  }
  rows.sort((a, b) => (b.productionScore ?? -1) - (a.productionScore ?? -1));
  // spec §23 — cross-sectional rank across the universe each cycle
  let _xs = { available: false };
  try { _xs = crossSectionalRank(rows); if (_xs.available) rows = _xs.ranked; } catch {}

  const out = { crossSectional: _xs.available ? { universe: _xs.universe, topBullish: _xs.topBullish, topBearish: _xs.topBearish, topDecile: _xs.topDecileTickers } : null, generatedAt: new Date().toISOString(), universe: 'screener', requested: tickers.length, scored: ok, skipped, partial: rateLimited >= 5, count: rows.length, rows };
  const p = path.join(dir, 'latest.json');
  fs.writeFileSync(p, JSON.stringify(out) + '\n');
  console.log(`scanned ${ok}/${tickers.length} tickers (skipped ${skipped}) -> ${p}`);
  process.exit(0);
}
main();
