// @ts-check
/*
 * research/capture-signals.js — OFFLINE data collection for Phase 3. For each ticker it computes the
 * CURRENT deterministic score (mirroring the server's buildTickerSignal -> buildOptionsSignal(chain, ctx))
 * and the SHADOW feature vector, then appends one flat record to the signals store. Run on a schedule
 * (systemd timer / cron) on the VPS; over time this builds the labeled out-of-sample dataset that
 * research/run-phase3.js validates.
 *
 * Never imported by the server. Reads OPTIONS_API_KEY from env; NEVER logs it. Writes only scalars.
 * Note: capture runs cold (no optCache warm-up), so currentScore is the deterministic cold-start score
 * -- a stable function of the chain, adequate for validation. Missing PVE fields stay null (no fabrication).
 *
 *   OPTIONS_API_KEY=pve_live_... RESEARCH_SIGNAL_DIR=./research-data/signals \
 *   RESEARCH_TICKERS=AAPL,MSFT,NVDA,SPY,QQQ node research/capture-signals.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { appendSignal, buildSignalRecord } from './signals-store.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const g = (o, ...ks) => { let v = o; for (const k of ks) { if (v == null) return null; v = v[k]; } return v == null ? null : v; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const key = process.env.OPTIONS_API_KEY || process.env.UNUSUAL_WHALES_API_TOKEN;
  const dir = process.env.RESEARCH_SIGNAL_DIR;
  const tickers = (process.env.RESEARCH_TICKERS || 'AAPL,MSFT,NVDA,AMZN,GOOGL,META,SPY,QQQ').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (!key) { console.error('OPTIONS_API_KEY required (server-side only).'); process.exit(1); }
  if (!dir) { console.error('RESEARCH_SIGNAL_DIR required.'); process.exit(1); }
  fs.mkdirSync(dir, { recursive: true });

  const { makeOptionsProvider } = await import('../providers/options.js');
  const { buildOptionsSignal } = await import('../public/options-engine.js');
  const { computeShadow } = await import('../shadow/engine.js');
  const P = makeOptionsProvider(process.env);
  if (P.name === 'null') { console.error(P.reason || 'No options provider configured'); process.exit(1); }
  const opt = (fn, ...a) => (typeof P[fn] === 'function' ? P[fn](...a).catch(() => null) : Promise.resolve(null));
  const DELAY = Number(process.env.RESEARCH_CAPTURE_DELAY_MS || 500);   // gap between tickers (PVE = 10 req/s per account)

  let ok = 0; const skips = {};
  for (const ticker of tickers) {
    try {
      // 1) Chain first, with the REAL error surfaced (getChain throws on non-200: 404 no_chain_data / 429 / 503 not_ready).
      let chainRes = null, chainErr = null;
      try { chainRes = await P.getChain(ticker); } catch (e) { chainErr = e.message || String(e); }
      const chain = chainRes && chainRes.chain ? chainRes.chain : null;
      if (!chain) { const reason = chainErr || 'empty chain'; skips[reason] = (skips[reason] || 0) + 1; console.error(`skip ${ticker}: no chain (${reason})`); await sleep(DELAY); continue; }
      if (chain.fieldsAvailable) { /* chain present */ }
      // 2) Remaining reads in two small batches (<=6 concurrent) to stay under the rate limit.
      const [underlyingRes, gex, byStrike, ivRank, skew, term] = await Promise.all([
        opt('getUnderlying', ticker), opt('getGex', ticker), opt('getByStrikeGex', ticker), opt('getIvRank', ticker), opt('getSkew', ticker), opt('getTermStructure', ticker),
      ]);
      await sleep(Math.min(DELAY, 300));
      const [flow, netPremium, ohlc, darkpool, companies] = await Promise.all([
        opt('getFlowDetailed', ticker), opt('getNetPremium', ticker), opt('getOhlc', ticker), opt('getDarkpool', ticker), opt('getCompanies', [ticker]),
      ]);
      if (underlyingRes && underlyingRes.underlying && underlyingRes.underlying.available) { chain.underlying = { ...chain.underlying, ...underlyingRes.underlying, available: true }; if (chain.fieldsAvailable) chain.fieldsAvailable.underlying = true; }

      // CURRENT deterministic score -- same authority path as the server (cold-start, no optCache).
      let sig = null; try { sig = buildOptionsSignal(chain, { prevAgg: null, underlyingHist: [] }, {}); } catch {}
      if (sig) {
        try { if (gex && gex.available) { if (isNum(gex.net_gex)) sig.agg.gex = gex.net_gex; if (isNum(gex.gamma_flip)) sig.agg.gammaFlip = gex.gamma_flip; sig.walls = { call: gex.call_wall, put: gex.put_wall }; sig.gexSource = 'pve'; } } catch {}
        try { if (ivRank && ivRank.available) { sig.ivRank = ivRank.iv_rank; sig.ivPercentile = ivRank.iv_percentile; } } catch {}
      }

      const underlying = chain.underlying && chain.underlying.available ? chain.underlying : null;
      let shadow = null; try { shadow = computeShadow({ gex, byStrike, ivRank, skew, termStructure: term, flow, netPremium, underlying, ohlc, chain, market: {}, prevSnapshot: null }); } catch {}

      const price = g(chain, 'underlying', 'price');
      const direction = g(sig, 'dir') || g(shadow, 'shadowDirection') || 'neutral';
      const features = {
        price, currentScore: g(sig, 'finalScore'), shadowScore: g(shadow, 'shadowScore'),
        gexRegime: g(shadow, 'regime', 'gex'), flipDistancePct: g(shadow, 'regime', 'flipDistancePct'),
        callWallDistancePct: g(shadow, 'regime', 'callWallDistancePct'), putWallDistancePct: g(shadow, 'regime', 'putWallDistancePct'),
        nearSpotGex: g(shadow, 'regime', 'nearSpotGex'), deltaGexPct: g(g(shadow, 'regime', 'deltaGex') || {}, 'pct'),
        vanna: g(shadow, 'greeks', 'vanna'), charm: g(shadow, 'greeks', 'charm'),
        ivRank: g(shadow, 'iv', 'ivRank'), ivPercentile: g(shadow, 'iv', 'ivPercentile'), skew25: g(shadow, 'iv', 'skew25'),
        ivSpread: g(shadow, 'iv', 'ivSpread'), termSlope: g(shadow, 'iv', 'termSlope'), vrp: g(shadow, 'vrp', 'value'),
        flowDirection: g(shadow, 'flow', 'direction'), flowQuality: g(shadow, 'flow', 'quality'), netPremium: g(shadow, 'flow', 'netSignedPremium'),
        momentum: g(shadow, 'momentum', 'ret'), flowPrice: g(shadow, 'flowPrice', 'relation'),
        sector: g((companies && companies[ticker]) || {}, 'sector'), dataQuality: g(shadow, 'dataQuality'),
      };
      const rec = buildSignalRecord({ ts: new Date().toISOString(), ticker, features, score: features.currentScore, dir: direction, tier: g(sig, 'tier'), horizonDays: 5 });
      await appendSignal(dir, rec); ok++;
      await sleep(DELAY);
    } catch (e) { console.error(`skip ${ticker}: ${e.message}`); }
  }
  const skipSummary = Object.entries(skips).map(([r, n]) => `${n}×[${r}]`).join(', ');
  console.log(`captured ${ok}/${tickers.length} signal records -> ${path.join(dir, 'signals-' + new Date().toISOString().slice(0, 10) + '.jsonl')}${skipSummary ? ' | skips: ' + skipSummary : ''}`);
  process.exit(0);
}
main();
