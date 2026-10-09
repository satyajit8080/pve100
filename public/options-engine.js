// @ts-check
/*
 * options-engine.js — PRIMARY signal engine over REAL US options + stock data.
 *
 * Deterministic and pure. Consumes a normalized options chain from an OptionsDataProvider
 * (see providers/options.js). PVE prediction-market data is SECONDARY confirmation only and is
 * applied in combineScores() — it can raise or lower confidence but NEVER reverses direction.
 *
 * HARD RULE: nothing here fabricates OI, Greeks, IV, GEX, PCR, option volume, sweeps, blocks,
 * NBBO, or chain data. Every feature carries an `available` flag; missing inputs => unavailable,
 * which lowers coverage/data-quality rather than inventing a value. Derived analytics (GEX,
 * gamma flip, max pain, volume/OI anomaly) are computed ONLY from real chain fields that are present.
 *
 * IV-rank and OI-change require history Polygon does not return in one call; they are computed from
 * OUR captured snapshots and are `available:false` until enough snapshots exist.
 */

export const OPTIONS_ENGINE_VERSION = 'opt-1.1.0';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sum = (a) => a.reduce((s, x) => s + (isNum(x) ? x : 0), 0);
const mean = (a) => (a.length ? sum(a) / a.filter(isNum).length || 0 : 0);
function median(a) { const b = a.filter(isNum).slice().sort((x, y) => x - y); if (!b.length) return 0; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
function hhi(vals) { const t = sum(vals); if (!(t > 0)) return 0; return sum(vals.map((v) => (v / t) ** 2)); } // 0..1 concentration

export const SCORE_TIERS = [[90, 'Exceptional'], [80, 'Very Strong'], [70, 'Strong'], [60, 'Moderate'], [0, 'Weak']];
export function scoreTier(s) { for (const [m, l] of SCORE_TIERS) if (s >= m) return l; return 'Weak'; }

/**
 * Options feature registry. `weight` used by scoreOptions (documented, configurable via cfg.optionsWeights).
 * `directional`: contributes to bull/bear net. `proxy` is false — these are REAL options metrics.
 */
export const OPTIONS_FEATURE_DEFS = {
  cpVolume: { name: 'Call/Put volume pressure', weight: 0.22, directional: true, source: 'chain.day.volume', explain: 'Call vs put contract volume (real)' },
  volOIAnomaly: { name: 'Volume/OI anomaly', weight: 0.16, directional: false, source: 'chain.volume vs open_interest', explain: 'Total volume relative to open interest — new positioning' },
  oiChange: { name: 'OI change', weight: 0.14, directional: true, source: 'derived from captured snapshots', explain: 'Net call vs put OI change vs prior snapshot' },
  ivBehavior: { name: 'IV behavior', weight: 0.12, directional: false, source: 'chain.implied_volatility', explain: 'ATM IV level / change (real)' },
  gexContext: { name: 'Gamma / GEX context', weight: 0.12, directional: false, source: 'computed from chain gamma×OI', explain: 'Dealer gamma regime (computed from real chain)' },
  largePremium: { name: 'Large premium activity', weight: 0.10, directional: true, source: 'options flow (if provider supplies)', explain: 'Directional premium in large trades' },
  strikeConc: { name: 'Strike concentration', weight: 0.07, directional: false, source: 'computed HHI of OI', explain: 'Concentration of open interest across strikes' },
  liquidity: { name: 'Liquidity quality', weight: 0.07, directional: false, source: 'chain.last_quote spread + OI', explain: 'Bid/ask tightness and depth (real)' },
};

// ---- chain aggregation (all from REAL fields; availability tracked) ----
/** @param {*} chain normalized chain from provider @returns {*} aggregate metrics */
export function aggregateChain(chain) {
  const cs = (chain && chain.contracts) || [];
  const calls = cs.filter((c) => c.type === 'call');
  const puts = cs.filter((c) => c.type === 'put');
  const spot = chain && chain.underlying && isNum(chain.underlying.price) ? chain.underlying.price : null;
  const fa = (chain && chain.fieldsAvailable) || {};

  const callVol = sum(calls.map((c) => c.volume)), putVol = sum(puts.map((c) => c.volume));
  const callOI = sum(calls.map((c) => c.openInterest)), putOI = sum(puts.map((c) => c.openInterest));
  const totVol = callVol + putVol, totOI = callOI + putOI;
  const cpVolRatio = putVol > 0 ? callVol / putVol : (callVol > 0 ? Infinity : null);
  const cpOIRatio = putOI > 0 ? callOI / putOI : (callOI > 0 ? Infinity : null);
  const volOIRatio = totOI > 0 ? totVol / totOI : null;

  // ATM IV: contracts nearest to spot (avg of nearest call+put IV)
  let atmIV = null;
  if (spot !== null && fa.iv) {
    const withIV = cs.filter((c) => isNum(c.iv) && isNum(c.strike));
    if (withIV.length) { const nearest = withIV.slice().sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, 4); atmIV = mean(nearest.map((c) => c.iv)); }
  }

  // GEX (computed from real gamma×OI): dealer long calls, short puts convention (per gex-tracker/OptionsHacker).
  // GEX_contract = gamma * OI * 100 * spot^2 * 0.01 ; puts negative.
  let gex = null, gexByStrike = null;
  if (spot !== null && fa.greeks && fa.oi) {
    gexByStrike = {};
    for (const c of cs) {
      if (!isNum(c.gamma) || !isNum(c.openInterest) || !isNum(c.strike)) continue;
      const g = c.gamma * c.openInterest * 100 * spot * spot * 0.01 * (c.type === 'put' ? -1 : 1);
      gexByStrike[c.strike] = (gexByStrike[c.strike] || 0) + g;
    }
    gex = sum(Object.values(gexByStrike));
  }
  // gamma flip: lowest strike where cumulative GEX (ascending strikes) turns non-negative
  let gammaFlip = null;
  if (gexByStrike) {
    const strikes = Object.keys(gexByStrike).map(Number).sort((a, b) => a - b);
    let cum = 0; for (const k of strikes) { cum += gexByStrike[k]; if (cum >= 0) { gammaFlip = k; break; } }
  }
  // max pain: strike minimizing total intrinsic payout to option holders (classic OI-weighted)
  let maxPain = null;
  if (fa.oi) {
    const strikes = [...new Set(cs.map((c) => c.strike).filter(isNum))].sort((a, b) => a - b);
    let best = null;
    for (const K of strikes) {
      let pay = 0;
      for (const c of cs) { if (!isNum(c.openInterest)) continue; pay += c.type === 'call' ? Math.max(0, K - c.strike) * c.openInterest : Math.max(0, c.strike - K) * c.openInterest; }
      if (best === null || pay < best.pay) best = { K, pay };
    }
    maxPain = best ? best.K : null;
  }

  // spreads / liquidity
  let avgSpread = null;
  if (fa.quotes) { const sp = cs.filter((c) => isNum(c.bid) && isNum(c.ask) && c.ask > 0 && c.mid > 0).map((c) => (c.ask - c.bid) / c.mid); if (sp.length) avgSpread = median(sp); }

  // concentration
  const strikeOI = {}; for (const c of cs) if (isNum(c.strike) && isNum(c.openInterest)) strikeOI[c.strike] = (strikeOI[c.strike] || 0) + c.openInterest;
  const expOI = {}; for (const c of cs) if (c.expiration && isNum(c.openInterest)) expOI[c.expiration] = (expOI[c.expiration] || 0) + c.openInterest;
  const strikeConcentration = hhi(Object.values(strikeOI));
  const expirationConcentration = hhi(Object.values(expOI));

  // unusual (real): contracts with volume > 1.5× their own OI
  const unusual = cs.filter((c) => isNum(c.volume) && isNum(c.openInterest) && c.openInterest > 0 && c.volume > 1.5 * c.openInterest)
    .map((c) => ({ type: c.type, strike: c.strike, expiration: c.expiration, volume: c.volume, oi: c.openInterest, ratio: c.volume / c.openInterest }))
    .sort((a, b) => b.ratio - a.ratio).slice(0, 10);

  return {
    spot, calls: calls.length, puts: puts.length, callVol, putVol, callOI, putOI, totVol, totOI,
    cpVolRatio, cpOIRatio, volOIRatio, atmIV, gex, gexByStrike, gammaFlip, maxPain, avgSpread,
    strikeConcentration, expirationConcentration, unusual,
    fieldsAvailable: fa,
  };
}

// ---- features ----
const feat = (key, avail, dir, strength, value, note) => ({ key, label: OPTIONS_FEATURE_DEFS[key].name, avail: avail ? 1 : 0, dir, strength: clamp(strength || 0, 0, 1), value: isNum(value) ? value : null, note: note || '', proxy: false, source: OPTIONS_FEATURE_DEFS[key].source });

/**
 * @param {*} chain normalized chain @param {*} [ctx] { prevAgg?, flow? } prior snapshot aggregate for change features
 * @returns {{features:*[], agg:*}}
 */
export function extractOptionsFeatures(chain, ctx = {}) {
  const agg = aggregateChain(chain); const fa = agg.fieldsAvailable; const prev = ctx.prevAgg || null; const flow = ctx.flow || null;
  const features = [];

  // 1) Call/Put volume pressure (directional): log-ratio → [-1,1]
  {
    const ok = isNum(agg.callVol) && isNum(agg.putVol) && (agg.callVol + agg.putVol) > 0;
    const r = agg.cpVolRatio; const s = (ok && isNum(r) && r > 0) ? clamp(Math.log(r) / Math.log(3), -1, 1) : 0;
    features.push(feat('cpVolume', ok, ok ? Math.sign(s) : 0, Math.abs(s), isNum(r) ? r : null, ok ? `C/P vol ${isNum(r) ? r.toFixed(2) : '∞'}` : 'no volume'));
  }
  // 2) Volume/OI anomaly (confirmation): >0.5 notable, clamp
  {
    const ok = isNum(agg.volOIRatio); const s = ok ? clamp((agg.volOIRatio - 0.3) / 0.7, 0, 1) : 0;
    features.push(feat('volOIAnomaly', ok, 0, s, agg.volOIRatio, ok ? `vol/OI ${agg.volOIRatio.toFixed(2)}` : 'no OI'));
  }
  // 3) OI change (directional; needs prev snapshot)
  {
    const ok = !!prev && isNum(prev.callOI) && isNum(prev.putOI) && isNum(agg.callOI) && isNum(agg.putOI);
    let s = 0, val = null;
    if (ok) { const dCall = agg.callOI - prev.callOI, dPut = agg.putOI - prev.putOI; const net = dCall - dPut; const base = Math.max(1, prev.callOI + prev.putOI); val = net / base; s = clamp(net / base / 0.2, -1, 1); }
    features.push(feat('oiChange', ok, ok ? Math.sign(s) : 0, Math.abs(s), val, ok ? `ΔOI net ${(val * 100).toFixed(1)}%` : 'no prior snapshot'));
  }
  // 4) IV behavior (confirmation): change if prev, else level context vs 0.5
  {
    const ok = isNum(agg.atmIV);
    let s = 0, val = agg.atmIV;
    if (ok && prev && isNum(prev.atmIV) && prev.atmIV > 0) { const ch = (agg.atmIV - prev.atmIV) / prev.atmIV; val = ch; s = clamp(Math.abs(ch) / 0.25, 0, 1); }
    else if (ok) { s = clamp(agg.atmIV / 1.0, 0, 1); }
    features.push(feat('ivBehavior', ok, 0, s, val, ok ? (prev && isNum(prev.atmIV) ? `ATM IV Δ` : `ATM IV ${(agg.atmIV * 100).toFixed(0)}%`) : 'no IV'));
  }
  // 5) Gamma/GEX context (confirmation): magnitude normalized (sign shown, not directional for price)
  {
    const ok = isNum(agg.gex);
    const s = ok ? clamp(Math.abs(agg.gex) / (Math.abs(agg.gex) + 5e8), 0, 1) : 0;
    features.push(feat('gexContext', ok, 0, s, agg.gex, ok ? `GEX ${agg.gex >= 0 ? '+' : ''}${(agg.gex / 1e6).toFixed(1)}M` : 'no greeks/OI'));
  }
  // 6) Large premium activity (directional; only if provider supplies flow)
  {
    const lt = flow && flow.available && Array.isArray(flow.largeTrades) ? flow.largeTrades : null;
    const ok = !!lt && lt.length > 0;
    let s = 0, val = null;
    if (ok) { const net = sum(lt.map((t) => (t.side === 'call' ? 1 : t.side === 'put' ? -1 : 0) * (t.premium || 0))); const tot = sum(lt.map((t) => Math.abs(t.premium || 0))) || 1; val = net / tot; s = clamp(Math.abs(val), 0, 1); }
    features.push(feat('largePremium', ok, ok ? Math.sign(s) : 0, Math.abs(s), val, ok ? `net premium ${(val * 100).toFixed(0)}%` : 'no flow feed'));
  }
  // 7) Strike concentration (confirmation)
  {
    const ok = isNum(agg.strikeConcentration) && agg.totOI > 0;
    features.push(feat('strikeConc', ok, 0, ok ? clamp(agg.strikeConcentration * 2, 0, 1) : 0, agg.strikeConcentration, ok ? `HHI ${agg.strikeConcentration.toFixed(2)}` : 'no OI'));
  }
  // 8) Liquidity quality (confirmation): tighter spread + more OI → higher
  {
    const ok = isNum(agg.avgSpread) || agg.totOI > 0;
    let s = 0;
    if (isNum(agg.avgSpread)) s = clamp(1 - agg.avgSpread, 0, 1);
    else if (agg.totOI > 0) s = clamp(Math.log10(agg.totOI + 1) / 6, 0, 1);
    features.push(feat('liquidity', ok, 0, s, agg.avgSpread, isNum(agg.avgSpread) ? `spread ${(agg.avgSpread * 100).toFixed(1)}%` : `OI ${agg.totOI}`));
  }
  return { features, agg };
}

// ---- scoring ----
/** documented default weights (configurable via cfg.optionsWeights) */
export const DEFAULT_OPTIONS_WEIGHTS = Object.fromEntries(Object.entries(OPTIONS_FEATURE_DEFS).map(([k, d]) => [k, d.weight]));
export const DEFAULT_COMBINE = { wOptions: 0.6, wStock: 0.25, wPredMkt: 0.15, pveAgreeBoost: 0.12, pveDisagreePenalty: 0.15, pveFactorFloor: 0.8, pveFactorCap: 1.15, epsilon: 0.03 };

/** @param {*[]} features @param {*} [cfg] @returns {{optionsScore:number, dir:string, net:number, coverage:number, comps:*[]}} */
export function scoreOptions(features, cfg = {}) {
  const w = cfg.optionsWeights || DEFAULT_OPTIONS_WEIGHTS;
  const totalW = Object.values(w).reduce((a, b) => a + Math.max(0, b), 0) || 1;
  let signed = 0, dirW = 0, availW = 0;
  const comps = features.map((f) => {
    const wn = Math.max(0, w[f.key] || 0) / totalW;
    const contribution = wn * f.avail * f.dir * f.strength;
    signed += contribution; availW += wn * f.avail; if (f.avail && f.dir !== 0) dirW += wn;
    return { ...f, weight: wn, contribution };
  });
  const net = dirW > 0 ? signed / dirW : 0;
  const coverage = availW;
  const eps = cfg.epsilon ?? DEFAULT_COMBINE.epsilon;
  const optionsScore = Math.round(100 * Math.abs(net) * coverage);
  const dir = dirW === 0 ? 'neutral' : net > eps ? 'bull' : net < -eps ? 'bear' : 'neutral';
  return { optionsScore, dir, net, coverage, comps };
}

/** Stock score from underlying momentum/volume (real). ctx.underlyingHist = prior close prices. */
export function scoreStock(chain, ctx = {}) {
  const u = chain && chain.underlying; const hist = ctx.underlyingHist || [];
  if (!u || !u.available || !isNum(u.price)) return { stockScore: 0, dir: 'neutral', coverage: 0, note: 'no underlying data' };
  let mom = 0, cov = 0.5;
  if (hist.length >= 2 && isNum(hist[0]) && hist[0] > 0) { mom = clamp((u.price - hist[0]) / hist[0] / 0.05, -1, 1); cov = 1; }
  const dir = mom > 0.05 ? 'bull' : mom < -0.05 ? 'bear' : 'neutral';
  return { stockScore: Math.round(100 * Math.abs(mom) * cov), dir, coverage: cov, mom, note: hist.length >= 2 ? 'return vs prior close' : 'insufficient history' };
}

/** Data quality 0..100 from availability of critical options fields. */
export function dataQualityScore(chain) {
  const fa = (chain && chain.fieldsAvailable) || {};
  const critical = ['chain', 'oi', 'greeks', 'iv', 'quotes', 'underlying'];
  const present = critical.filter((k) => fa[k]).length;
  const status = fa.chain ? (present >= 5 ? 'AVAILABLE' : present >= 3 ? 'PARTIAL' : 'PARTIAL') : 'UNAVAILABLE';
  return { score: Math.round((present / critical.length) * 100), status, present, critical: critical.length, fieldsAvailable: fa };
}

/**
 * Combine PRIMARY (options+stock) with SECONDARY (PVE). PVE adjusts confidence, never reverses direction.
 * @param {*} parts { optionsScore, optionsDir, stockScore, stockDir, predictionMarketScore, predictionMarketDir, dataQuality }
 * @param {*} [cfg]
 */
export function combineScores(parts, cfg = {}) {
  const c = { ...DEFAULT_COMBINE, ...cfg };
  const { optionsScore = 0, optionsDir = 'neutral', stockScore = 0, stockDir = 'neutral', predictionMarketScore = null, predictionMarketDir = null, dataQuality = 0 } = parts;
  // PRIMARY blend (options-weighted), direction from options (fallback stock)
  const wp = c.wOptions + c.wStock || 1;
  // Stock momentum is a SIGNED confirmation: agrees with options → boost, disagrees → penalty.
  // (Previously stockScore added its magnitude regardless of sign, so a falling stock inflated a CALL.)
  const stockConfirm = (stockDir === 'neutral' || optionsDir === 'neutral') ? 0 : (stockDir === optionsDir ? 1 : -1);
  const primary = clamp((c.wOptions * optionsScore + c.wStock * stockScore * stockConfirm) / wp, 0, 100);
  const dir = optionsDir !== 'neutral' ? optionsDir : stockDir;
  // PVE confirmation factor (secondary): agree → boost, disagree → penalty, never flips direction
  let pveState = 'unavailable', factor = 1;
  if (isNum(predictionMarketScore) && predictionMarketDir && predictionMarketDir !== 'neutral' && dir !== 'neutral') {
    if (predictionMarketDir === dir) { pveState = 'agree'; factor = 1 + c.pveAgreeBoost * (predictionMarketScore / 100); }
    else { pveState = 'disagree'; factor = 1 - c.pveDisagreePenalty * (predictionMarketScore / 100); }
  } else if (isNum(predictionMarketScore)) { pveState = 'neutral'; }
  factor = clamp(factor, c.pveFactorFloor, c.pveFactorCap);
  const dqFactor = clamp(dataQuality / 100, 0, 1);
  const finalScore = Math.round(clamp(primary * factor * dqFactor, 0, 100));
  return { finalScore, tier: scoreTier(finalScore), dir, primary: Math.round(primary), stockConfirm, pveState, pveFactor: +factor.toFixed(3), dqFactor: +dqFactor.toFixed(2), weights: { wOptions: c.wOptions, wStock: c.wStock, wPredMkt: c.wPredMkt } };
}

/**
 * Build a full options-primary signal. predictionMarket is the SECONDARY sub-score (from PVE engine).
 * Returns null-ish signal with insufficient flag if options data is unavailable (caller must not emit a normal signal).
 */
export function buildOptionsSignal(chain, ctx = {}, cfg = {}) {
  const dq = dataQualityScore(chain);
  const { features, agg } = extractOptionsFeatures(chain, ctx);
  const opt = scoreOptions(features, cfg);
  const stk = scoreStock(chain, ctx);
  const pm = ctx.predictionMarket || null; // { score, dir } from PVE engine, or null
  const combined = combineScores({
    optionsScore: opt.optionsScore, optionsDir: opt.dir, stockScore: stk.stockScore, stockDir: stk.dir,
    predictionMarketScore: pm ? pm.score : null, predictionMarketDir: pm ? pm.dir : null, dataQuality: dq.score,
  }, cfg);
  const insufficient = !dq.fieldsAvailable.chain; // no real chain → not a real options signal
  return {
    ticker: chain && chain.ticker, asOf: chain && chain.asOf, insufficient,
    finalScore: combined.finalScore, tier: combined.tier, dir: combined.dir,
    optionsScore: opt.optionsScore, stockScore: stk.stockScore, predictionMarketScore: pm ? pm.score : null,
    dataQuality: dq.score, dataQualityStatus: dq.status, dataAvailability: dq.fieldsAvailable,
    pveState: combined.pveState, pveFactor: combined.pveFactor, primary: combined.primary,
    features: opt.comps, agg, stock: stk, weights: combined.weights,
    optionsEngineVersion: OPTIONS_ENGINE_VERSION,
  };
}

// ---- replay (deterministic; reproduces from persisted snapshot, no live API) ----
export function captureOptionsSnapshot(chain, ctx, cfg, now) {
  return { optionsEngineVersion: OPTIONS_ENGINE_VERSION, now, ticker: chain && chain.ticker, chain, ctx: { prevAgg: ctx && ctx.prevAgg, flow: ctx && ctx.flow, underlyingHist: ctx && ctx.underlyingHist, predictionMarket: ctx && ctx.predictionMarket }, cfg: cfg || null };
}
export function replayOptionsSignal(snap) { return buildOptionsSignal(snap.chain, snap.ctx || {}, snap.cfg || {}); }
