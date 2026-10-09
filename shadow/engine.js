// @ts-check
/*
 * shadow/engine.js — PHASE 1 SHADOW ENGINE. Pure, deterministic, no I/O, no network, no deps.
 *
 * Computes an options-derived SHADOW feature vector + SHADOW score for research/observation only.
 * It is NEVER used by the live deterministic score (finalScore/dir/tier) and cannot write back to it.
 * Implements ONLY PVE-supported features; anything PVE cannot supply is left null (never fabricated).
 *
 * The shadow weights below are PROVISIONAL placeholders pending Phase 3 validation — they are NOT
 * claimed to be predictive and MUST NOT be copied into production scoring without validation.
 */

export const SHADOW_ENGINE_VERSION = 'shadow-1.0.0';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sign3 = (x, dead = 0) => (!isNum(x) ? 0 : x > dead ? 1 : x < -dead ? -1 : 0);
const labelOf = (s) => (s > 0 ? 'bullish' : s < 0 ? 'bearish' : 'neutral');

// ---------- price-derived helpers (daily OHLC only; PVE has no intraday underlying bars) ----------
function barsAsc(bars) {
  if (!Array.isArray(bars)) return [];
  const copy = bars.filter((b) => b && isNum(b.close));
  const parseable = copy.every((b) => b.date && !Number.isNaN(Date.parse(b.date)));
  if (parseable) copy.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return copy;
}
/** Annualized realized volatility from daily closes (log returns, sample stdev × √252). */
export function realizedVol(bars, window = 20) {
  const b = barsAsc(bars);
  if (b.length < 3) return null;
  const slice = b.slice(-(window + 1));
  const r = [];
  for (let i = 1; i < slice.length; i++) { const a = slice[i - 1].close, c = slice[i].close; if (a > 0 && c > 0) r.push(Math.log(c / a)); }
  if (r.length < 2) return null;
  const m = mean(r); const v = r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}
/** Simple daily momentum over `lookback` closes: return + above-SMA flag + label. */
export function momentum(bars, lookback = 20) {
  const b = barsAsc(bars);
  if (b.length < 2) return { available: false, ret: null, aboveSMA: null, label: 'neutral' };
  const closes = b.map((x) => x.close);
  const last = closes[closes.length - 1];
  const refIdx = Math.max(0, closes.length - 1 - lookback);
  const ref = closes[refIdx];
  const ret = isNum(ref) && ref > 0 ? (last - ref) / ref : null;
  const sma = mean(closes.slice(-lookback));
  const aboveSMA = isNum(sma) ? last > sma : null;
  return { available: isNum(ret), ret, aboveSMA, label: labelOf(sign3(ret, 0.005)) };
}
/** ATM call IV − put IV from the chain (Cremers–Weinbaum: relatively expensive calls ⇒ bullish). */
export function atmIvSpread(chain, spot) {
  const contracts = (chain && chain.contracts) || [];
  if (!isNum(spot) || !contracts.length) return { available: false, spread: null, callIv: null, putIv: null, label: 'neutral' };
  const nearest = (type) => {
    let best = null, bestD = Infinity;
    for (const c of contracts) { if ((c.type || '') !== type || !isNum(c.iv) || !isNum(c.strike)) continue; const d = Math.abs(c.strike - spot); if (d < bestD) { bestD = d; best = c; } }
    return best;
  };
  const call = nearest('call'), put = nearest('put');
  if (!call || !put) return { available: false, spread: null, callIv: null, putIv: null, label: 'neutral' };
  const spread = call.iv - put.iv;
  return { available: true, spread, callIv: call.iv, putIv: put.iv, label: labelOf(sign3(spread, 0.005)) };
}

// ---------- GEX / regime ----------
/** Regime from net GEX sign, overridden to 'neutral' at the gamma-flip pivot. */
export function classifyGexRegime(netGex, flipDistancePct) {
  if (isNum(flipDistancePct) && Math.abs(flipDistancePct) < 0.005) return 'neutral';   // sitting on the flip
  if (!isNum(netGex) || netGex === 0) return 'neutral';
  return netGex > 0 ? 'positive' : 'negative';
}
function deltaGex(currentNetGex, prevSnapshot) {
  const prev = prevSnapshot && isNum(prevSnapshot.net_gex) ? prevSnapshot.net_gex : null;
  if (!isNum(currentNetGex) || prev == null) return { available: false, pct: null, label: 'unknown' };
  const denom = Math.abs(prev) > 0 ? Math.abs(prev) : null;
  const pct = denom ? (currentNetGex - prev) / denom : null;
  const a = isNum(pct) ? Math.abs(pct) : 0;
  const label = !isNum(pct) ? 'unknown' : a >= 0.25 ? 'strong' : a >= 0.08 ? 'moderate' : 'flat';
  return { available: isNum(pct), pct, label };
}

// ---------- flow quality (deterministic; NOT "unusual = bullish") ----------
function tradeQuality(t) {
  let q = 0;
  const prem = isNum(t.premium) ? t.premium : 0;
  q += 0.35 * clamp(Math.log10(Math.max(prem, 1)) / 7, 0, 1);        // premium size (log-scaled; $10M→~1)
  if (isNum(t.size) && isNum(t.openInterest) && t.openInterest > 0) q += 0.20 * clamp(t.size / t.openInterest, 0, 1); // new money vs standing OI
  if (t.isOpening === true) q += 0.15;
  if (t.golden) q += 0.15;
  const type = (t.type || '').toLowerCase();
  if (type.includes('sweep')) q += 0.10; else if (type.includes('block')) q += 0.05;
  if (isNum(t.dte)) { if (t.dte <= 1 && !t.golden) q -= 0.10; else if (t.dte >= 7 && t.dte <= 60) q += 0.05; } // 0DTE noise vs swing
  if (isNum(t.otm)) { const a = Math.abs(t.otm); if (a <= 5) q += 0.05; else if (a >= 20) q -= 0.05; }           // near-money vs lottery
  return clamp(q, 0, 1);
}
/** Bullish: buy calls / sell puts. Bearish: buy puts / sell calls. Unknown aggressor ⇒ unsigned. */
function tradeSign(t) {
  const d = (t.direction || '').toLowerCase(); const r = t.right;
  if (d !== 'buy' && d !== 'sell') return 0;
  if (r === 'call') return d === 'buy' ? 1 : -1;
  if (r === 'put') return d === 'buy' ? -1 : 1;
  return 0;
}
export function computeFlowQuality(flow) {
  const trades = (flow && flow.trades) || [];
  if (!trades.length) return { available: false, score: null, direction: 'neutral', netSignedPremium: null, callPremium: null, putPremium: null, openingRatio: null, goldenCount: 0, sampleSize: 0 };
  let wq = 0, wsum = 0, net = 0, callP = 0, putP = 0, opening = 0, openKnown = 0, golden = 0;
  for (const t of trades) {
    const prem = isNum(t.premium) ? t.premium : 0;
    const q = tradeQuality(t);
    wq += q * prem; wsum += prem;                       // premium-weighted mean quality
    net += tradeSign(t) * prem;
    if (t.right === 'call') callP += prem; else if (t.right === 'put') putP += prem;
    if (t.isOpening === true) opening++; if (t.isOpening === true || t.isOpening === false) openKnown++;
    if (t.golden) golden++;
  }
  const total = callP + putP;
  const score = wsum > 0 ? clamp((wq / wsum) * 100, 0, 100) : null;
  const dir = total > 0 && Math.abs(net) / total > 0.1 ? labelOf(sign3(net)) : 'neutral';
  return { available: score != null, score, direction: dir, netSignedPremium: net, callPremium: callP, putPremium: putP, openingRatio: openKnown ? opening / openKnown : null, goldenCount: golden, sampleSize: trades.length };
}

/** Flow vs price: confirming when aligned; divergence-* when flow opposes the tape. */
export function flowPriceRelation(flowDir, momentumLabel) {
  const f = sign3(flowDir === 'bullish' ? 1 : flowDir === 'bearish' ? -1 : 0);
  const m = sign3(momentumLabel === 'bullish' ? 1 : momentumLabel === 'bearish' ? -1 : 0);
  if (f === 0 || m === 0) return { relation: 'neutral', conflict: false };
  if (f === m) return { relation: 'confirming', conflict: false };
  return { relation: f > 0 ? 'divergence-bullish' : 'divergence-bearish', conflict: true };
}

// ---------- provisional shadow weights (PENDING PHASE 3 VALIDATION) ----------
const W = { flow: 0.40, ivSpread: 0.20, skew: 0.20, momentum: 0.20 }; // directional bias mix (sum 1.0)
const REGIME_MULT = { positive: 0.85, neutral: 1.0, negative: 1.10 }; // gate conviction, not direction

/**
 * Compute the full shadow block from normalized PVE inputs. Any input may be null/unavailable.
 * PURE: does not mutate inputs; never throws. Returns feature values + a provisional shadowScore.
 */
export function computeShadow(inp = {}) {
  const { gex, byStrike, ivRank, skew, termStructure, flow, netPremium, underlying, ohlc, chain, market = {}, prevSnapshot = null } = inp;
  const spot = underlying && isNum(underlying.price) ? underlying.price : null;

  // regime + structure
  const flip = gex && isNum(gex.gamma_flip) ? gex.gamma_flip : null;
  const cw = gex && isNum(gex.call_wall) ? gex.call_wall : null;
  const pw = gex && isNum(gex.put_wall) ? gex.put_wall : null;
  const flipDist = isNum(flip) && isNum(spot) && spot !== 0 ? (spot - flip) / spot : null;
  const cwDist = isNum(cw) && isNum(spot) && spot !== 0 ? (cw - spot) / spot : null;
  const pwDist = isNum(pw) && isNum(spot) && spot !== 0 ? (pw - spot) / spot : null;
  const nsg = nearSpotGexFromStrikes(byStrike, spot);
  const gexReg = classifyGexRegime(gex && gex.net_gex, flipDist);
  const dGex = deltaGex(gex && gex.net_gex, prevSnapshot);

  // IV structure
  const skew25 = skew && isNum(skew.skew25) ? skew.skew25 : null;
  const skewPct = skew && isNum(skew.percentile) ? skew.percentile : null;
  // steep positive put skew ⇒ bearish tilt (Xing–Zhang–Zhao). Prefer percentile if present.
  const skewSign = isNum(skewPct) ? sign3(50 - skewPct, 15) : (isNum(skew25) ? sign3(-skew25, 0.005) : 0);
  const ivSpread = atmIvSpread(chain, spot);
  const termSlope = termStructure && isNum(termStructure.slope3090) ? termStructure.slope3090 : null;
  const termLabel = !isNum(termSlope) ? 'neutral' : termSlope < 0 ? 'backwardation' : 'contango';

  // VRP (daily OHLC only)
  const ivForVrp = ivRank && isNum(ivRank.current_iv) ? ivRank.current_iv : (ivSpread.available ? mean([ivSpread.callIv, ivSpread.putIv]) : null);
  const rv = realizedVol(ohlc && ohlc.bars ? ohlc.bars : ohlc);
  const vrp = isNum(ivForVrp) && isNum(rv) ? ivForVrp - rv : null;
  const vrpLabel = !isNum(vrp) ? 'neutral' : vrp > 0.05 ? 'rich' : vrp < -0.05 ? 'cheap' : 'neutral';

  // momentum + flow
  const mom = momentum(ohlc && ohlc.bars ? ohlc.bars : ohlc);
  const fq = computeFlowQuality(flow);
  // prefer aggressor-aware net-premium endpoint for direction when available
  let flowDir = fq.direction;
  if (netPremium && isNum(netPremium.total_bullish_premium) && isNum(netPremium.total_bearish_premium)) {
    const nb = netPremium.total_bullish_premium - netPremium.total_bearish_premium;
    const tot = netPremium.total_bullish_premium + netPremium.total_bearish_premium;
    if (tot > 0 && Math.abs(nb) / tot > 0.1) flowDir = labelOf(sign3(nb));
  }
  const fp = flowPriceRelation(flowDir, mom.label);

  // ---- directional bias (each in −1..+1) ----
  const flowSign = sign3(flowDir === 'bullish' ? 1 : flowDir === 'bearish' ? -1 : 0);
  const ivSpreadSign = sign3(ivSpread.spread, 0.005);
  const momSign = sign3(mom.ret, 0.005);
  const dirParts = [
    { name: 'flow', sign: flowSign, w: W.flow, has: flowDir !== 'neutral' },
    { name: 'ivSpread', sign: ivSpreadSign, w: W.ivSpread, has: ivSpread.available },
    { name: 'skew', sign: skewSign, w: W.skew, has: skewSign !== 0 || isNum(skew25) },
    { name: 'momentum', sign: momSign, w: W.momentum, has: mom.available },
  ];
  const activeW = dirParts.filter((p) => p.has).reduce((s, p) => s + p.w, 0);
  const bias = activeW > 0 ? dirParts.filter((p) => p.has).reduce((s, p) => s + p.sign * p.w, 0) / activeW : 0; // −1..+1

  // ---- conviction (0..1) ----
  const qualityC = isNum(fq.score) ? fq.score / 100 : 0.4;
  const deltaC = dGex.available ? (dGex.label === 'strong' ? 1 : dGex.label === 'moderate' ? 0.6 : 0.3) : 0.5;
  const componentsPresent = [gex && gex.available, fq.available, ivSpread.available, isNum(skew25), mom.available, isNum(vrp)].filter(Boolean).length;
  const dataQuality = componentsPresent / 6;
  let conviction = clamp(0.5 * qualityC + 0.3 * deltaC + 0.2 * dataQuality, 0, 1);
  const regimeMult = REGIME_MULT[gexReg] != null ? REGIME_MULT[gexReg] : 1.0;
  conviction = clamp(conviction * regimeMult, 0, 1);

  // divergence nudge: smart-money fading the tape → small bias toward the flow side, lower conviction
  let divergenceNudge = 0;
  if (fp.relation === 'divergence-bullish') { divergenceNudge = 0.1; conviction *= 0.9; }
  else if (fp.relation === 'divergence-bearish') { divergenceNudge = -0.1; conviction *= 0.9; }

  const rawDir = clamp(bias + divergenceNudge, -1, 1);
  const shadowScore = Math.round(clamp(50 + rawDir * conviction * 45, 0, 100));
  const shadowDirection = shadowScore > 55 ? 'bull' : shadowScore < 45 ? 'bear' : 'neutral';

  const components = [
    { name: 'flowDirection', value: flowDir, contribution: round2((dirParts[0].has ? flowSign * W.flow : 0)) },
    { name: 'ivSpread', value: ivSpread.label, contribution: round2((dirParts[1].has ? ivSpreadSign * W.ivSpread : 0)) },
    { name: 'skew', value: labelOf(skewSign), contribution: round2((dirParts[2].has ? skewSign * W.skew : 0)) },
    { name: 'momentum', value: mom.label, contribution: round2((dirParts[3].has ? momSign * W.momentum : 0)) },
    { name: 'gexRegimeGate', value: gexReg, contribution: round2(regimeMult) },
    { name: 'flowQuality', value: isNum(fq.score) ? Math.round(fq.score) : null, contribution: round2(qualityC) },
    { name: 'deltaGex', value: dGex.label, contribution: round2(deltaC) },
    { name: 'flowPrice', value: fp.relation, contribution: round2(divergenceNudge) },
  ];

  return {
    version: SHADOW_ENGINE_VERSION,
    status: 'shadow — not used in live score',
    regime: {
      gex: gexReg, netGex: gex && isNum(gex.net_gex) ? gex.net_gex : null,
      flipDistancePct: flipDist, callWallDistancePct: cwDist, putWallDistancePct: pwDist,
      nearSpotGex: nsg, deltaGex: dGex,
    },
    greeks: { vanna: gex && isNum(gex.net_vanna) ? gex.net_vanna : null, charm: gex && isNum(gex.net_charm) ? gex.net_charm : null },
    iv: { ivRank: ivRank && isNum(ivRank.iv_rank) ? ivRank.iv_rank : null, ivPercentile: ivRank && isNum(ivRank.iv_percentile) ? ivRank.iv_percentile : null, skew25, skewLabel: labelOf(skewSign), ivSpread: ivSpread.spread, ivSpreadLabel: ivSpread.label, termSlope, termLabel },
    vrp: { iv: isNum(ivForVrp) ? ivForVrp : null, realizedVol: rv, value: vrp, label: vrpLabel },
    momentum: { ret: mom.ret, aboveSMA: mom.aboveSMA, label: mom.label },
    flow: { quality: isNum(fq.score) ? Math.round(fq.score) : null, direction: flowDir, netSignedPremium: fq.netSignedPremium, callPremium: fq.callPremium, putPremium: fq.putPremium, openingRatio: fq.openingRatio, goldenCount: fq.goldenCount, sampleSize: fq.sampleSize },
    flowPrice: fp,
    market: { gexRegime: market.gexRegime != null ? market.gexRegime : null, tideDirection: market.tideDirection != null ? market.tideDirection : null, dix: isNum(market.dix) ? market.dix : null },
    shadowScore, shadowDirection, components, dataQuality: round2(dataQuality),
  };
}

function nearSpotGexFromStrikes(byStrike, spot, pct = 0.05) {
  if (!byStrike || !Array.isArray(byStrike.strikes) || !isNum(spot) || spot === 0) return null;
  const lo = spot * (1 - pct), hi = spot * (1 + pct);
  let sum = 0, seen = false;
  for (const s of byStrike.strikes) { if (isNum(s.strike) && isNum(s.netGex) && s.strike >= lo && s.strike <= hi) { sum += s.netGex; seen = true; } }
  return seen ? sum : null;
}
function round2(x) { return isNum(x) ? Math.round(x * 100) / 100 : x; }
