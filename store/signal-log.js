// @ts-check
/*
 * store/signal-log.js — SERVER-SIDE writer for the Signal Journal (event/outcome research dataset).
 * Separate from the scan cache and the Phase-3 signals-store. Append-only JSONL. NOT in public/,
 * NOT in research/ (so the production server can import it without breaking the server→research
 * boundary). Analysis + forward-return resolution live offline in research/ and read these files.
 *
 * GUARANTEES (reqs 6, 9, 10):
 *  - Reads the already-built production signal; NEVER recomputes or changes it.
 *  - Fire-and-forget: every path is wrapped so a logging failure can never break the request.
 *  - Nothing fabricated; unavailable data is written as null / status flags.
 *
 * SOURCE DISTINCTION (req 7) — three explicitly separated buckets per record:
 *   scored[]            (A) values actually used in production scoring (incl. chain-computed GEX)
 *   displayedNotScored  (B) values computed/overridden for display but NOT used in the score
 *                            (PVE GEX override, gamma-flip/walls override, IV-rank, max-pain)
 *   shadowOnly          (C) experimental shadow classification (sweep/flow) — never used in scoring
 */
import fs from 'node:fs';
import path from 'node:path';
import { OPTIONS_FEATURE_DEFS } from '../public/options-engine.js';
import { explainSignal, reasonCodes, JOURNAL_MIN_SCORE, CHECKPOINTS } from './journal.js';
import { computeFlowQuality } from '../shadow/engine.js';

export const SIGNAL_LOG_SCHEMA = 'signal-log-1.0.0';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const DIR_KEYS = Object.entries(OPTIONS_FEATURE_DEFS).filter(([, d]) => d.directional).map(([k]) => k);

function logDir() { return process.env.SIGNAL_LOG_DIR || path.join(path.resolve(new URL('..', import.meta.url).pathname), 'research-data', 'signal-log'); }
// spec §12 time buckets, computed in US Eastern from the fire timestamp
function timeBucket(d) {
  try {
    const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const m = et.getHours() * 60 + et.getMinutes();
    if (m < 570) return 'premarket';
    if (m < 585) return '09:30-09:45';
    if (m < 630) return '09:45-10:30';
    if (m < 690) return '10:30-11:30';
    if (m < 780) return '11:30-13:00';
    if (m < 870) return '13:00-14:30';
    if (m < 930) return '14:30-15:30';
    if (m <= 960) return '15:30-16:00';
    return 'afterhours';
  } catch { return null; }
}
function bucket5min(d) { const t = d.getTime(); return new Date(Math.floor(t / 300000) * 300000).toISOString(); }

// In-memory dedupe: one record per ticker per 5-min bucket, safe across repeated dashboard/scan calls
// in the same process. Deterministic id also lets the offline resolver/report dedupe across restarts.
const _seen = new Map(); // id -> ts
function _dedupe(id) {
  const now = Date.now();
  if (_seen.size > 5000) for (const [k, ts] of _seen) if (now - ts > 900000) _seen.delete(k);
  if (_seen.has(id)) return false;
  _seen.set(id, now); return true;
}

/**
 * Fire-and-forget. Call as: void logSignal({ provider, ticker, sig, scoredAgg, prevHadSnapshot, now }).
 * @param {{provider?:object, ticker:string, sig:object, scoredAgg:object, underlying?:object, prevHadSnapshot?:boolean, now?:Date}} args
 *   scoredAgg = snapshot of sig.agg taken BEFORE the PVE gex/iv overrides (so we log the values the
 *   score actually used, immune to the later display override).
 */
export async function logSignal({ provider, ticker, sig, scoredAgg = {}, underlying = null, prevHadSnapshot = false, now, entryOption = null, shadowScore = null, vsVwapPct = null, changePct = null, atr = null, vwap = null, rvol = null, marketRegime = null, earningsWithin2Days = null, v2 = null } = {}) {
  try {
    if (!sig || !ticker) return;
    const dir = sig.dir;
    if (dir === 'neutral' || dir == null) return;              // req 3: dir != neutral only
    if (!isNum(sig.finalScore) || sig.finalScore < JOURNAL_MIN_SCORE) return;   // Signal Journal: only calls rated >= 70
    const firedAt = (now instanceof Date ? now : new Date());
    const id = `${String(ticker).toUpperCase()}:${bucket5min(firedAt)}`;
    if (!_dedupe(id)) return;                                   // req 3: 5-min/ticker dedupe

    const a = sig.agg || {};
    const under = underlying && typeof underlying === 'object' ? underlying : null;
    const price = under && isNum(under.price) ? under.price : (isNum(scoredAgg.spot) ? scoredAgg.spot : (isNum(a.spot) ? a.spot : null));

    // (A) production-scored components, verbatim from the engine (captured at scoring time).
    const components = Array.isArray(sig.features) ? sig.features.map((f) => ({
      key: f.key, scored: true, directional: !!(OPTIONS_FEATURE_DEFS[f.key] && OPTIONS_FEATURE_DEFS[f.key].directional),
      weight: OPTIONS_FEATURE_DEFS[f.key] ? OPTIONS_FEATURE_DEFS[f.key].weight : null,
      avail: f.avail, dir: f.dir, strength: f.strength, value: f.value,
    })) : [];
    const activeScored = components.filter((c) => c.directional && c.avail && isNum(c.strength) && c.strength > 0 && (c.dir === 1 && dir === 'bull' || c.dir === -1 && dir === 'bear')).map((c) => c.key);

    // (C) shadow-only sweep/flow classification — experimental; off the response path; best-effort.
    let shadowFlow = null;
    try { if (provider && typeof provider.getFlowDetailed === 'function') { const flow = await provider.getFlowDetailed(ticker).catch(() => null); if (flow) { const fq = computeFlowQuality(flow); shadowFlow = { available: !!fq.available, quality: isNum(fq.score) ? Math.round(fq.score) : null, direction: fq.direction, netSignedPremium: fq.netSignedPremium, goldenCount: fq.goldenCount, sweepSampleSize: fq.sampleSize }; } } } catch { shadowFlow = null; }

    const rec = {
      schemaVersion: SIGNAL_LOG_SCHEMA, id, firedAt: firedAt.toISOString(), ticker: String(ticker).toUpperCase(),
      signalType: 'options', optionsEngineVersion: sig.optionsEngineVersion || null,
      composite: { finalScore: sig.finalScore, dir, tier: sig.tier, primary: sig.primary, optionsScore: sig.optionsScore, stockScore: sig.stockScore, dataQuality: sig.dataQuality },
      pve: { predictionMarketScore: sig.predictionMarketScore ?? null, pveState: sig.pveState ?? null, pveFactor: sig.pveFactor ?? null }, // currently inert (~1.0); see store/SIGNAL_LOG.md
      scored: {                                                 // (A) used in production scoring
        gexChainComputed: isNum(scoredAgg.gex) ? scoredAgg.gex : null,
        atmIV: isNum(scoredAgg.atmIV) ? scoredAgg.atmIV : null,
        cpVolRatio: isNum(scoredAgg.cpVolRatio) ? scoredAgg.cpVolRatio : null,
        cpOIRatio: isNum(scoredAgg.cpOIRatio) ? scoredAgg.cpOIRatio : null,
        volOIRatio: isNum(scoredAgg.volOIRatio) ? scoredAgg.volOIRatio : null,
        strikeConcentration: isNum(scoredAgg.strikeConcentration) ? scoredAgg.strikeConcentration : null,
        avgSpread: isNum(scoredAgg.avgSpread) ? scoredAgg.avgSpread : null,
        oiChangeAvailable: !!prevHadSnapshot,                   // false at cold start (documented)
        components, activeComponents: activeScored,
      },
      displayedNotScored: {                                     // (B) computed/overridden, NOT scored
        gexPveOverride: isNum(a.gex) ? a.gex : null, gexSource: sig.gexSource || null,
        gammaFlip: isNum(a.gammaFlip) ? a.gammaFlip : null,
        callWall: sig.walls ? (sig.walls.call ?? null) : null, putWall: sig.walls ? (sig.walls.put ?? null) : null,
        ivRank: isNum(sig.ivRank) ? sig.ivRank : null, ivPercentile: isNum(sig.ivPercentile) ? sig.ivPercentile : null,
        maxPain: isNum(scoredAgg.maxPain) ? scoredAgg.maxPain : null,
        price: isNum(price) ? price : null,
        prevClose: under && isNum(under.prevClose) ? under.prevClose : null,
      },
      shadowOnly: { flow: shadowFlow, note: 'experimental; NOT used in production scoring' },   // (C)
      entryPrice: isNum(price) ? price : null,
      shadowScore: isNum(shadowScore) ? shadowScore : null,
      // Signal Journal: exact state at generation time (never rewritten by later analysis)
      entry: {
        stockPrice: isNum(price) ? price : null,
        optionPrice: isNum(entryOption) ? entryOption : null,
        vsVwapPct: isNum(vsVwapPct) ? vsVwapPct : null,
        changePct: isNum(changePct) ? changePct : null,
        capturedAt: firedAt.toISOString(),
      },
      // Context captured at signal time (spec §21 signal_context). Unknown => null, never 0.
      context: {
        atr: isNum(atr) ? atr : null,
        vwap: isNum(vwap) ? vwap : null,
        vsVwapPct: isNum(vsVwapPct) ? vsVwapPct : null,
        rvol: isNum(rvol) ? rvol : null,
        gammaRegime: isNum(a.gex) ? (a.gex > 0 ? 'positive' : 'negative') : null,
        gammaFlip: isNum(a.gammaFlip) ? a.gammaFlip : null,
        gammaFlipDistanceAtr: (isNum(a.gammaFlip) && isNum(price) && isNum(atr) && atr > 0) ? Math.round(((price - a.gammaFlip) / atr) * 100) / 100 : null,
        timeOfDayBucket: timeBucket(firedAt),
        marketRegime: marketRegime || null,
        earningsWithin2Days: earningsWithin2Days === true ? true : (earningsWithin2Days === false ? false : null),
        signalVersion: sig.optionsEngineVersion || null,
      },
      outcomes: CHECKPOINTS.reduce((o, h) => { o[h] = { status: 'pending' }; return o; }, {}),
      v2: v2 || null,       // shadow scorer output (spec phases 2-5); never affects production
      postAnalysis: null,   // written only after outcomes resolve; never modifies the fields above
      forward: {
        '1h': { price: null, ret: null, status: 'unavailable', note: 'OPTIONS_PROVIDER has no intraday historical data' }, // req 1
        '1d': { price: null, ret: null, status: 'pending' },
        '1w': { price: null, ret: null, status: 'pending' },
      },
      resolved: false,
    };

    try { rec.explain = explainSignal(rec); } catch { rec.explain = null; }
    try { rec.reasons = reasonCodes(rec); } catch { rec.reasons = []; }   // generated ONCE, from signal-time data only

    const dir_ = logDir();
    await fs.promises.mkdir(dir_, { recursive: true });
    await fs.promises.appendFile(path.join(dir_, `signal-log-${firedAt.toISOString().slice(0, 10)}.jsonl`), JSON.stringify(rec) + '\n');
  } catch { /* req 10: logging must never break the request */ }
}
