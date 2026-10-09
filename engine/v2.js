// v2 transparent scorer (spec §16, §17). Runs in SHADOW alongside the frozen production
// engine (opt-1.1.0) until the evaluation harness proves it out-of-sample (spec §3, §28).
//
// Structure — primary evidence is scored; regimes GATE; confirmations MULTIPLY.
// Weights are STARTING POINTS to be calibrated from our own data, not truths (spec §16).

import { signedFlow, flowAcceleration, gammaRegime, priceConfirmation, rvolMultiplier, marketRegime, ivSkewChange, eventGates } from './features.js';

export const V2_VERSION = 'v2-0.1.0';

export const WEIGHTS = { flow: 0.45, price: 0.20, gamma: 0.15, market: 0.10, context: 0.10 };

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : null);

// z-score -> 0..1 strength (saturating, so one extreme value cannot dominate)
const zStrength = (z) => (isNum(z) ? clamp(Math.abs(z) / 3, 0, 1) : null);

export function scoreV2({
  ticker, at = new Date().toISOString(),
  trades = [], normalized = {},          // normalized: per-feature {z, percentile, available}
  prevFlow = null,
  spot = null, vwap = null, vwapSlope = null, atr = null,
  ret5m = null, ret15m = null, ret30m = null, first30mReturn = null,
  gex = null, gammaFlip = null, callWall = null, putWall = null, previousRegime = null,
  rvol = null, market = {}, ivChanges = {}, events = {},
} = {}) {
  const reasons = [];
  const quality = { flags: [], degraded: false };
  const push = (code, contribution, explanation) => reasons.push({ code, contribution: r2(contribution), explanation });

  // ---------- PRIMARY DIRECTIONAL EVIDENCE: signed flow (45%) ----------
  const flow = signedFlow(trades, { spot });
  let flowScore = null, dir = null;
  if (flow.available) {
    if (flow.quality !== 'ok') { quality.flags.push(`flow_${flow.quality}`); quality.degraded = true; }
    // prefer the per-ticker normalized z-score; fall back to the raw imbalance
    const zDelta = normalized.deltaWeightedSignedFlow && normalized.deltaWeightedSignedFlow.available ? normalized.deltaWeightedSignedFlow.z : null;
    const zOpening = normalized.openingDeltaFlow && normalized.openingDeltaFlow.available ? normalized.openingDeltaFlow.z : null;
    const base = isNum(zDelta) ? zStrength(zDelta) : (isNum(flow.imbalance) ? Math.abs(flow.imbalance) : null);
    if (isNum(base)) {
      dir = (isNum(zDelta) ? zDelta : flow.imbalance) >= 0 ? 'bull' : 'bear';
      // opening trades carry more information than closing (Pan-Poteshman)
      let s = base;
      if (isNum(zOpening)) { s = 0.65 * base + 0.35 * zStrength(zOpening); push(dir === 'bull' ? 'OPENING_FLOW_BULLISH' : 'OPENING_FLOW_BEARISH', zStrength(zOpening), `Opening delta flow z=${zOpening}.`); }
      flowScore = clamp(s * 100, 0, 100);
      push(dir === 'bull' ? 'SIGNED_FLOW_BULLISH' : 'SIGNED_FLOW_BEARISH', base, `Delta-weighted signed premium ${flow.deltaWeightedSignedFlow}${isNum(zDelta) ? ` (z=${zDelta})` : ' (raw — no baseline yet)'}.`);
      if (isNum(zDelta) && Math.abs(zDelta) >= 2) push('DELTA_FLOW_EXTREME', 1, `Flow is ${Math.abs(zDelta).toFixed(1)}σ from this ticker's same-time-of-day norm.`);
      if (!isNum(zDelta)) quality.flags.push('no_baseline_history');
    }
  } else { quality.flags.push('flow_unavailable'); quality.degraded = true; }

  const accel = flowAcceleration(flow.available ? flow.deltaWeightedSignedFlow : null, prevFlow);
  if (accel.available && accel.direction !== 'flat') {
    const aligned = (dir === 'bull' && accel.delta > 0) || (dir === 'bear' && accel.delta < 0);
    if (aligned) push('FLOW_ACCELERATING', 0.1, `Flow is ${accel.direction} vs the previous poll.`);
  }

  // ---------- PRICE CONFIRMATION (20%) ----------
  const price = priceConfirmation({ price: spot, vwap, vwapSlope, atr, ret5m, ret15m, ret30m, first30mReturn });
  let priceScore = null;
  if (price.available && dir) {
    const confirmed = dir === 'bull' ? price.bullConfirmed : price.bearConfirmed;
    const mag = isNum(price.vwapDistanceAtr) ? clamp(Math.abs(price.vwapDistanceAtr) / 1.5, 0, 1) : (isNum(price.vsVwapPct) ? clamp(Math.abs(price.vsVwapPct) / 2, 0, 1) : 0);
    priceScore = confirmed === true ? mag * 100 : confirmed === false ? 0 : 50 * mag;
    if (confirmed === true) push('VWAP_CONFIRMED', mag, `Price ${price.vsVwapPct}% vs VWAP, ${isNum(price.vwapDistanceAtr) ? price.vwapDistanceAtr + ' ATR' : 'distance unnormalized'}.`);
    else if (confirmed === false) push('VWAP_CONFLICT', -mag, `Price is on the wrong side of VWAP for a ${dir} call.`);
  } else if (!price.available) quality.flags.push('price_unavailable');

  // ---------- GAMMA REGIME: a GATE, never a direction (15%) ----------
  const gamma = gammaRegime({ gex, spot, gammaFlip, atr, callWall, putWall, previousRegime });
  let gammaScore = null, regimeMultiplier = 1.0;
  if (gamma.available) {
    // Does the setup match what this regime supports? Momentum-aligned flow in negative
    // gamma is favoured; in positive gamma it is attenuated and fades are favoured.
    const momentumAligned = price.available && dir ? (dir === 'bull' ? price.bullConfirmed : price.bearConfirmed) === true : null;
    regimeMultiplier = momentumAligned === true ? gamma.momentumMultiplier : momentumAligned === false ? gamma.reversionMultiplier : 1.0;
    gammaScore = gamma.inDeadband ? 40 : (gamma.regime === 'negative' && momentumAligned === true ? 90 : gamma.regime === 'positive' && momentumAligned === true ? 55 : 60);
    push(gamma.regime === 'negative' ? 'NEGATIVE_GAMMA_TREND_REGIME' : gamma.regime === 'positive' ? 'POSITIVE_GAMMA_MEAN_REVERSION' : 'GAMMA_DEADBAND', null, gamma.note);
    if (isNum(gamma.callWallDistanceAtr) && Math.abs(gamma.callWallDistanceAtr) < 0.3) push('AT_CALL_WALL', null, 'Price is at the call wall — resistance in positive gamma, acceleration risk in negative.');
  } else quality.flags.push('gamma_unavailable');

  // ---------- MARKET / SECTOR (10%) ----------
  const mkt = marketRegime(market);
  let marketScore = null, marketMultiplier = 1.0;
  if (mkt.available && dir) {
    marketMultiplier = mkt.multiplierFor(dir);
    marketScore = marketMultiplier > 1 ? 85 : marketMultiplier < 1 ? 25 : 55;
    push(marketMultiplier > 1 ? 'MARKET_CONFIRMED' : marketMultiplier < 1 ? 'MARKET_CONFLICT' : 'MARKET_MIXED', null, `Market regime ${mkt.regime} vs a ${dir} signal.`);
  } else quality.flags.push('market_regime_unavailable');

  // ---------- CONTEXT (10%): RVOL, IV skew change, time-of-day ----------
  const rv = rvolMultiplier(rvol);
  const iv = ivSkewChange(ivChanges);
  const ev = eventGates(events);
  let contextScore = null;
  const ctxParts = [];
  if (rv.available) { ctxParts.push(rv.bucket === 'high' ? 90 : rv.bucket === 'normal' ? 60 : 25); push(rv.bucket === 'high' ? 'RVOL_CONFIRMED' : 'RVOL_LOW', null, `RVOL ${rv.rvol}x vs same-time-of-day baseline.`); }
  else quality.flags.push('rvol_unavailable');
  if (iv.available && dir) { const aligned = iv.tilt === (dir === 'bull' ? 'bullish' : 'bearish'); ctxParts.push(aligned ? 80 : 35); push(aligned ? 'IV_SKEW_CONFIRMS' : 'IV_SKEW_CONFLICTS', null, `Put/call IV spread change ${iv.putCallIvSpreadChange} (${iv.tilt}).`); }
  if (ctxParts.length) contextScore = ctxParts.reduce((a, b) => a + b, 0) / ctxParts.length;
  for (const g of ev.gates) push(g, null, `Event/time regime: ${g}.`);

  // ---------- COMBINE: weighted over AVAILABLE components only ----------
  const parts = [
    { k: 'flow', v: flowScore, w: WEIGHTS.flow },
    { k: 'price', v: priceScore, w: WEIGHTS.price },
    { k: 'gamma', v: gammaScore, w: WEIGHTS.gamma },
    { k: 'market', v: marketScore, w: WEIGHTS.market },
    { k: 'context', v: contextScore, w: WEIGHTS.context },
  ];
  const avail = parts.filter((p) => isNum(p.v));
  const coverage = avail.reduce((a, p) => a + p.w, 0);

  if (!isNum(flowScore) || !dir) {
    return { version: V2_VERSION, ticker, at, available: false, reason: 'no_primary_flow_evidence', score: null, dir: null, state: 'NEUTRAL', reasons, quality, components: Object.fromEntries(parts.map((p) => [p.k, p.v])), coverage: r2(coverage * 100) };
  }

  const weighted = avail.reduce((a, p) => a + p.w * p.v, 0) / (coverage || 1);
  // multipliers applied AFTER the weighted sum so weak confirmations cannot overpower flow (§17)
  // Cap the COMBINED multiplier so stacked confirmations cannot overpower primary flow
  // evidence or saturate the scale (spec §17).
  const rawMultiplier = regimeMultiplier * rv.multiplier * marketMultiplier * ev.multiplier;
  const totalMultiplier = clamp(rawMultiplier, 0.6, 1.25);
  let score = weighted * totalMultiplier;
  // coverage penalty: thin evidence must not score like complete evidence
  score = score * (0.7 + 0.3 * coverage);
  score = Math.round(clamp(score, 0, 100));

  const gated = ev.blocked;
  if (gated) push('SIGNAL_GATED', null, `Blocked by ${ev.reason}.`);

  return {
    version: V2_VERSION, ticker, at, available: true,
    score: gated ? 0 : score, rawScore: score, dir, gated, gateReason: ev.reason || null,
    components: Object.fromEntries(parts.map((p) => [p.k, r2(p.v)])),
    multipliers: { regime: regimeMultiplier, rvol: rv.multiplier, market: marketMultiplier, events: ev.multiplier, combined: r2(totalMultiplier), rawCombined: r2(rawMultiplier), capped: rawMultiplier !== totalMultiplier },
    coverage: r2(coverage * 100),
    flow, gamma, price, rvol: rv, ivSkew: iv, market: mkt.available ? { regime: mkt.regime, relativeStrength: mkt.relativeStrength } : null,
    acceleration: accel, reasons, quality,
    weights: WEIGHTS,
    note: 'Shadow score. Not used for live signals until the evaluation harness proves it out-of-sample.',
  };
}
