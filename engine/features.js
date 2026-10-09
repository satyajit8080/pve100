// Phases 2–4 — feature computation for the v2 signal path.
// PURE functions. Every feature carries a data-quality flag; missing data => null + flag,
// never silently 0 (spec §27).

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const r2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : null);
const r4 = (x) => (isNum(x) ? Math.round(x * 10000) / 10000 : null);

// ---------------------------------------------------------------------------
// PHASE 2 — SIGNED, AGGRESSOR-CLASSIFIED, DELTA-WEIGHTED OPTION FLOW (spec §5)
// ---------------------------------------------------------------------------
// trades: UW flow-alerts rows. Aggressor side is an ESTIMATE (spec §27) — flagged as such.
export function signedFlow(trades, { spot = null } = {}) {
  const rows = Array.isArray(trades) ? trades : [];
  if (!rows.length) return { available: false, reason: 'no_trades', quality: 'missing' };

  let callAsk = 0, callBid = 0, putAsk = 0, putBid = 0;
  let deltaFlow = 0, openingDeltaFlow = 0, openingSigned = 0;
  let counted = 0, sideUnknown = 0, deltaMissing = 0, openingKnown = 0;

  for (const t of rows) {
    const prem = isNum(t.premium) ? t.premium : null;
    if (!isNum(prem) || prem <= 0) continue;
    const right = (t.side || t.right || '').toLowerCase();
    if (right !== 'call' && right !== 'put') continue;

    // aggressor side: prefer explicit ask/bid premium split, else the direction hint
    const ask = isNum(t.askPremium) ? t.askPremium : null;
    const bid = isNum(t.bidPremium) ? t.bidPremium : null;
    let askShare = null;
    if (isNum(ask) && isNum(bid) && ask + bid > 0) askShare = ask / (ask + bid);
    else if (t.direction === 'ask' || t.direction === 'bullish') askShare = 1;
    else if (t.direction === 'bid' || t.direction === 'bearish') askShare = 0;
    if (askShare == null) { sideUnknown++; continue; }

    const askPrem = prem * askShare, bidPrem = prem * (1 - askShare);
    if (right === 'call') { callAsk += askPrem; callBid += bidPrem; } else { putAsk += askPrem; putBid += bidPrem; }

    // delta-weighting: converts premium into share-equivalent directional pressure (DEX).
    // Far-OTM lottery tickets have small |delta| so they cannot dominate (spec §5).
    const d = isNum(t.delta) ? Math.abs(t.delta) : null;
    if (d == null) deltaMissing++;
    const w = d == null ? 0.5 : d;                                   // neutral weight when delta unknown
    const dirSign = right === 'call' ? 1 : -1;
    const aggressorSign = (askShare - 0.5) * 2;                      // +1 all ask, -1 all bid
    const contribution = prem * w * dirSign * aggressorSign;
    deltaFlow += contribution;
    if (t.isOpening === true || t.is_opening === true || t.all_opening_trades === true) {
      openingDeltaFlow += contribution;
      openingSigned += (askPrem - bidPrem) * dirSign;
      openingKnown++;
    }
    counted++;
  }

  if (!counted) return { available: false, reason: 'no_classifiable_trades', quality: 'bad', sideUnknown };

  const totalAsk = callAsk + putAsk, totalBid = callBid + putBid;
  const signedPremium = (callAsk - callBid) - (putAsk - putBid);
  const gross = callAsk + callBid + putAsk + putBid;
  const quality = sideUnknown > counted ? 'degraded' : (deltaMissing > counted / 2 ? 'partial_delta' : 'ok');

  return {
    available: true, quality,
    callAskPremium: r2(callAsk), callBidPremium: r2(callBid), putAskPremium: r2(putAsk), putBidPremium: r2(putBid),
    totalAskPremium: r2(totalAsk), totalBidPremium: r2(totalBid),
    signedPremium: r2(signedPremium),
    deltaWeightedSignedFlow: r2(deltaFlow),
    openingSignedPremium: r2(openingSigned), openingDeltaFlow: r2(openingDeltaFlow),
    flowIntensity: r2(gross),
    // normalized -1..1 imbalance, robust to size
    imbalance: gross > 0 ? r4(signedPremium / gross) : null,
    trades: counted, sideUnknown, deltaMissing, openingTrades: openingKnown,
    aggressorNote: 'aggressor side inferred from trade-vs-quote; an estimate, not ground truth',
  };
}

// Incremental vs cumulative (spec §6): acceleration = change in flow rate between polls.
export function flowAcceleration(current, previous) {
  if (!isNum(current) || !isNum(previous)) return { available: false, reason: 'need_two_polls' };
  const delta = current - previous;
  const accel = previous !== 0 ? delta / Math.abs(previous) : null;
  return { available: true, delta: r2(delta), acceleration: r4(accel), direction: delta > 0 ? 'increasing' : delta < 0 ? 'decreasing' : 'flat' };
}

// ---------------------------------------------------------------------------
// PHASE 3 — GAMMA REGIME AS A GATE (spec §7, §8)
// ---------------------------------------------------------------------------
export const GAMMA_DEADBAND_ATR = 0.25;   // spec: don't flip regime within 0.25 ATR of the flip

export function gammaRegime({ gex = null, spot = null, gammaFlip = null, atr = null, callWall = null, putWall = null, previousRegime = null }) {
  const distance = (isNum(spot) && isNum(gammaFlip)) ? spot - gammaFlip : null;
  const distanceAtr = (isNum(distance) && isNum(atr) && atr > 0) ? r2(distance / atr) : null;

  let regime = null, source = null;
  if (isNum(distanceAtr)) {
    if (Math.abs(distanceAtr) < GAMMA_DEADBAND_ATR) {
      // inside the dead-band: hold the previous regime rather than flip-flopping
      regime = previousRegime || 'transitional'; source = 'deadband_hold';
    } else { regime = distanceAtr > 0 ? 'positive' : 'negative'; source = 'flip_distance'; }
  } else if (isNum(gex)) { regime = gex > 0 ? 'positive' : 'negative'; source = 'gex_sign'; }

  if (!regime) return { available: false, reason: 'no_gamma_data', regime: null };

  // Regime does NOT set direction — it selects how flow should be interpreted.
  const interpretation = regime === 'positive'
    ? { mode: 'mean_reversion', momentumMultiplier: 0.8, reversionMultiplier: 1.15, note: 'Dealers long gamma: hedging dampens moves; fade extensions toward walls.' }
    : regime === 'negative'
      ? { mode: 'trend_following', momentumMultiplier: 1.2, reversionMultiplier: 0.85, note: 'Dealers short gamma: hedging amplifies moves; breaks can accelerate.' }
      : { mode: 'neutral', momentumMultiplier: 1.0, reversionMultiplier: 1.0, note: 'Price sits inside the gamma-flip dead-band; regime is unreliable here.' };

  const nearWall = (w) => (isNum(w) && isNum(spot) && isNum(atr) && atr > 0 ? r2((spot - w) / atr) : null);
  return {
    available: true, regime, source, gex: isNum(gex) ? gex : null,
    gammaFlip: isNum(gammaFlip) ? gammaFlip : null, distanceAtr,
    callWallDistanceAtr: nearWall(callWall), putWallDistanceAtr: nearWall(putWall),
    inDeadband: isNum(distanceAtr) ? Math.abs(distanceAtr) < GAMMA_DEADBAND_ATR : null,
    ...interpretation,
  };
}

// ---------------------------------------------------------------------------
// PHASE 4 — UNDERLYING CONFIRMATION (spec §9, §10, §11, §12, §13, §14)
// ---------------------------------------------------------------------------
export function priceConfirmation({ price = null, vwap = null, vwapSlope = null, atr = null, ret5m = null, ret15m = null, ret30m = null, first30mReturn = null }) {
  if (!isNum(price)) return { available: false, reason: 'no_price' };
  const distAtr = (isNum(vwap) && isNum(atr) && atr > 0) ? r2((price - vwap) / atr) : null;
  const vsVwapPct = (isNum(vwap) && vwap > 0) ? r2(((price - vwap) / vwap) * 100) : null;
  const momentum = [ret5m, ret15m, ret30m].filter(isNum);
  const momAvg = momentum.length ? r4(momentum.reduce((a, b) => a + b, 0) / momentum.length) : null;
  const accel = (isNum(ret5m) && isNum(ret15m)) ? r4(ret5m - ret15m / 3) : null;   // short vs longer-run pace
  return {
    available: true, vsVwapPct, vwapDistanceAtr: distAtr,
    vwapSlope: isNum(vwapSlope) ? r4(vwapSlope) : null,
    momentum: momAvg, momentumAcceleration: accel, first30mReturn: isNum(first30mReturn) ? r2(first30mReturn) : null,
    // bullish confirmation wants price above a RISING vwap (spec §9)
    bullConfirmed: isNum(vsVwapPct) ? (vsVwapPct > 0 && (vwapSlope == null || vwapSlope >= 0)) : null,
    bearConfirmed: isNum(vsVwapPct) ? (vsVwapPct < 0 && (vwapSlope == null || vwapSlope <= 0)) : null,
  };
}

// RVOL as a CONFIDENCE MULTIPLIER, not additive points (spec §10)
export function rvolMultiplier(rvol) {
  if (!isNum(rvol)) return { available: false, multiplier: 1.0, reason: 'no_rvol' };
  const m = rvol >= 2 ? 1.15 : rvol >= 1.5 ? 1.10 : rvol >= 0.8 ? 1.0 : 0.85;
  return { available: true, rvol: r2(rvol), multiplier: m, bucket: rvol >= 1.5 ? 'high' : rvol >= 0.8 ? 'normal' : 'low' };
}

// Market/sector regime gate (spec §11)
export function marketRegime({ spyTrend = null, qqqTrend = null, sectorTrend = null, relativeStrength = null } = {}) {
  const votes = [spyTrend, qqqTrend].filter((x) => x === 'up' || x === 'down');
  if (!votes.length) return { available: false, regime: null, multiplierFor: () => 1.0 };
  const up = votes.filter((v) => v === 'up').length, down = votes.length - up;
  const regime = up > down ? 'bullish' : down > up ? 'bearish' : 'mixed';
  return {
    available: true, regime, sectorTrend: sectorTrend || null, relativeStrength: isNum(relativeStrength) ? r2(relativeStrength) : null,
    // a signal fighting the market gets de-weighted unless its own evidence is exceptional
    multiplierFor: (dir) => {
      if (regime === 'mixed') return 1.0;
      const aligned = (dir === 'bull' && regime === 'bullish') || (dir === 'bear' && regime === 'bearish');
      return aligned ? 1.10 : 0.85;
    },
  };
}

// IV skew CHANGE, not level (spec §14) — secondary confirmation only
export function ivSkewChange({ callIvChange = null, putIvChange = null, atmIvChange = null } = {}) {
  if (!isNum(callIvChange) && !isNum(putIvChange)) return { available: false, reason: 'no_iv_change' };
  const spread = (isNum(callIvChange) && isNum(putIvChange)) ? r4(callIvChange - putIvChange) : null;
  return {
    available: true, callIvChange: r4(callIvChange), putIvChange: r4(putIvChange), atmIvChange: r4(atmIvChange),
    putCallIvSpreadChange: spread,
    // calls bid up relative to puts = bullish tilt (Cremers-Weinbaum direction)
    tilt: isNum(spread) ? (spread > 0 ? 'bullish' : spread < 0 ? 'bearish' : 'flat') : null,
    note: 'secondary confirmation only; IV alone never generates direction',
  };
}

// Event gates (spec §12, §13)
export function eventGates({ earningsDaysAway = null, isOpex = false, isFomc = false, isCpi = false, timeBucket = null } = {}) {
  const gates = [];
  let blocked = false, multiplier = 1.0;
  if (isNum(earningsDaysAway) && earningsDaysAway <= 2) { gates.push('EARNINGS_RISK'); blocked = true; }
  if (isOpex) { gates.push('OPEX'); multiplier *= 0.9; }
  if (isFomc) { gates.push('FOMC'); multiplier *= 0.85; }
  if (isCpi) { gates.push('CPI'); multiplier *= 0.85; }
  if (timeBucket === '11:30-13:00') { gates.push('LUNCH_LULL'); multiplier *= 0.9; }
  if (timeBucket === '09:30-09:45') { gates.push('OPENING_VOLATILITY'); multiplier *= 0.95; }
  if (timeBucket === 'premarket' || timeBucket === 'afterhours') { gates.push('OUTSIDE_RTH'); blocked = true; }
  return { gates, blocked, multiplier: r4(multiplier), reason: blocked ? gates.find((g) => g === 'EARNINGS_RISK' || g === 'OUTSIDE_RTH') : null };
}
