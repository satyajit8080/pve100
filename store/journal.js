// Signal Journal — observation & learning layer.
//
// INTEGRITY RULES (enforced by tests):
//  1. `explain` is generated at signal time from ONLY what the engine saw. It is written once and
//     never rewritten. Post-trade analysis lives in a separate `postAnalysis` field.
//  2. Outcomes never modify the original score, explanation, factors, or entry data.
//  3. Nothing is fabricated: unavailable inputs stay null and are reported as unavailable.
//  4. This layer NEVER feeds back into live engine weights. Read-only observation.
//
// All functions here are PURE (no I/O, no clock, no network) so they are deterministic and testable.

export const JOURNAL_SCHEMA_VERSION = 'journal-1.0.0';
export const JOURNAL_MIN_SCORE = 70;              // spec: record every call rated >= 70
export const CHECKPOINTS = ['15m', '30m', '60m', 'close'];
export const CHECKPOINT_MS = { '15m': 15 * 60000, '30m': 30 * 60000, '60m': 60 * 60000 };  // 'close' resolved by session end
export const TARGET_ATR = 1.0;   // target/stop expressed in ATR multiples (Phase 1 labels)
export const STOP_ATR = 1.0;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const r2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : null);
const pct = (a, b) => (isNum(a) && isNum(b) && b !== 0 ? ((a - b) / b) * 100 : null);

// Human-readable labels for the engine's feature keys.
export const FACTOR_LABELS = {
  cpVolume: 'Call/put volume pressure', oiChange: 'Open-interest change', largePremium: 'Large premium flow',
  volOIAnomaly: 'Volume vs open-interest anomaly', ivBehavior: 'Implied-volatility behaviour',
  gexContext: 'Dealer gamma exposure', strikeConc: 'Strike concentration', liquidity: 'Options liquidity',
};
export const labelOf = (k) => FACTOR_LABELS[k] || k;

// ---------------------------------------------------------------------------
// WHY THIS CALL WAS GENERATED  (generated at signal time; immutable thereafter)
// ---------------------------------------------------------------------------
export function explainSignal(rec) {
  if (!rec || !rec.composite) return null;
  const dir = rec.composite.dir;
  const comps = (rec.scored && Array.isArray(rec.scored.components)) ? rec.scored.components : [];
  const dirBit = dir === 'bull' ? 1 : dir === 'bear' ? -1 : 0;

  const available = comps.filter((c) => c.avail && isNum(c.strength));
  const unavailable = comps.filter((c) => !c.avail).map((c) => c.key);
  // contribution ≈ weight × strength (how much this factor actually moved the score)
  const withContrib = available.map((c) => ({
    key: c.key, label: labelOf(c.key), directional: !!c.directional, weight: c.weight,
    strength: r2(c.strength), dir: c.dir, value: c.value,
    contribution: isNum(c.weight) ? r2(c.weight * c.strength) : null,
    agrees: c.directional ? (c.dir === dirBit) : null,
  }));

  const directional = withContrib.filter((c) => c.directional);
  const confirming = withContrib.filter((c) => !c.directional);
  const byContrib = [...withContrib].sort((a, b) => (b.contribution || 0) - (a.contribution || 0));

  const strongest = byContrib.slice(0, 3);
  const weakest = [...withContrib].filter((c) => isNum(c.strength)).sort((a, b) => (a.strength || 0) - (b.strength || 0)).slice(0, 3);
  const conflicting = directional.filter((c) => c.agrees === false && (c.strength || 0) > 0);

  // --- options-flow reasoning (from the three directional features) ---
  const f = (k) => withContrib.find((c) => c.key === k) || null;
  const cpv = f('cpVolume'), oic = f('oiChange'), lp = f('largePremium');
  const flowBits = [];
  if (cpv) flowBits.push(`call/put volume pressure ${cpv.dir === dirBit ? 'supports' : 'opposes'} the ${dir} read (strength ${cpv.strength})`);
  else flowBits.push('call/put volume pressure unavailable');
  if (oic) flowBits.push(`open-interest change ${oic.dir === dirBit ? 'confirms' : 'contradicts'} it (strength ${oic.strength})`);
  else flowBits.push('open-interest change unavailable (no prior snapshot)');
  if (lp) flowBits.push(`large-premium flow ${lp.dir === dirBit ? 'agrees' : 'disagrees'} (strength ${lp.strength})`);
  else flowBits.push('large-premium flow unavailable');

  // --- stock / momentum confirmation ---
  const stockScore = rec.composite.stockScore, confirm = rec.composite.stockConfirm;
  const entry = rec.entry || {};
  const stockConfirmation = confirm === 1
    ? `Stock price agrees with the options direction, which boosted the score (stock component ${stockScore}).`
    : confirm === -1
      ? `Stock price CONFLICTS with the options direction, which penalised the score (stock component ${stockScore}).`
      : `Stock direction was neutral or unavailable, so it neither boosted nor penalised the score (stock component ${stockScore}).`;
  const vwapTxt = isNum(entry.vsVwapPct)
    ? `At signal time price was ${entry.vsVwapPct >= 0 ? 'above' : 'below'} VWAP by ${Math.abs(entry.vsVwapPct)}% (intraday ${entry.vsVwapPct >= 0 ? 'strength' : 'weakness'}).`
    : 'VWAP position unavailable at signal time (fell back to previous close).';
  const momentum = [vwapTxt, isNum(entry.changePct) ? `Day change was ${entry.changePct >= 0 ? '+' : ''}${entry.changePct}%.` : 'Day change unavailable.'].join(' ');

  // --- risks / warnings (only real, evidence-based flags) ---
  const risks = [];
  if (conflicting.length) risks.push(`${conflicting.length} directional factor(s) disagree with the call: ${conflicting.map((c) => c.label).join(', ')}.`);
  if (unavailable.length) risks.push(`${unavailable.length} factor(s) had no data and contributed nothing: ${unavailable.map(labelOf).join(', ')}.`);
  if (isNum(rec.composite.dataQuality) && rec.composite.dataQuality < 100) risks.push(`Data quality was ${rec.composite.dataQuality}%, which scaled the final score down.`);
  const ivr = rec.displayedNotScored && rec.displayedNotScored.ivRank;
  if (isNum(ivr) && ivr > 70) risks.push(`IV rank ${Math.round(ivr)} is elevated — options are expensive, so premium decay works against the position.`);
  if (isNum(ivr) && ivr < 10) risks.push(`IV rank ${Math.round(ivr)} is very low — a volatility expansion could move against the position.`);
  if (confirm === -1) risks.push('Stock direction disagreed with options flow — historically the weakest configuration.');
  const liq = f('liquidity');
  if (liq && isNum(liq.strength) && liq.strength < 0.3) risks.push('Options liquidity is thin — fills may slip versus the quoted price.');

  const summary = `${rec.ticker} scored ${rec.composite.finalScore} (${rec.composite.tier}) ${dir === 'bull' ? 'BULLISH → CALL' : 'BEARISH → PUT'}. `
    + `Options score ${rec.composite.optionsScore} carried ${Math.round((0.6 / 0.85) * 100)}% of the weight; the stock component ${confirm === 1 ? 'confirmed' : confirm === -1 ? 'conflicted with' : 'was neutral to'} it. `
    + `${directional.filter((c) => c.agrees).length} of ${directional.length} available directional factors pointed ${dir}.`;

  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    summary,
    whyScoreReached: `Final ${rec.composite.finalScore} = primary ${rec.composite.primary} × data-quality ${rec.composite.dataQuality}%. `
      + `Primary blends options ${rec.composite.optionsScore} (weight .60) with stock ${stockScore} (weight .25, signed ${confirm === 1 ? '+1 agree' : confirm === -1 ? '-1 conflict' : '0 neutral'}). `
      + `It cleared the ${JOURNAL_MIN_SCORE}+ journal threshold and the 65+ signal threshold.`,
    strongestFactors: strongest,
    weakestFactors: weakest,
    conflictingFactors: conflicting,
    unavailableFactors: unavailable.map((k) => ({ key: k, label: labelOf(k) })),
    optionsFlowReasoning: flowBits.join('; ') + '.',
    stockConfirmation,
    momentumConfirmation: momentum,
    risks,
    directionalAgreement: { agree: directional.filter((c) => c.agrees).length, total: directional.length },
  };
}

// ---------------------------------------------------------------------------
// REASON CODES (spec §20) — deterministic; every code is backed by a computed value.
export function reasonCodes(rec) {
  const out = [];
  const push = (code, contribution, explanation) => out.push({ code, contribution: isNum(contribution) ? r2(contribution) : null, explanation });
  const c = rec.composite || {}, ctx = rec.context || {}, comps = (rec.scored && rec.scored.components) || [];
  const dirBit = c.dir === 'bull' ? 1 : -1;
  const f = (k) => comps.find((x) => x.key === k);
  const bull = c.dir === 'bull';

  const lp = f('largePremium');
  if (lp && lp.avail && lp.strength > 0) {
    if (lp.dir === dirBit) push(bull ? 'SIGNED_FLOW_BULLISH' : 'SIGNED_FLOW_BEARISH', lp.weight * lp.strength, `Large-premium flow agrees (strength ${r2(lp.strength)}).`);
    else push('FLOW_NOT_CONFIRMED', -(lp.weight * lp.strength), 'Large-premium flow opposes the signal direction.');
  }
  const cpv = f('cpVolume');
  if (cpv && cpv.avail && cpv.dir === dirBit && cpv.strength >= 0.8) push('DELTA_FLOW_EXTREME', cpv.weight * cpv.strength, `Call/put volume pressure is extreme (strength ${r2(cpv.strength)}).`);
  const oic = f('oiChange');
  if (oic && oic.avail && oic.dir === dirBit) push(bull ? 'OPENING_FLOW_BULLISH' : 'OPENING_FLOW_BEARISH', oic.weight * oic.strength, 'Open interest is building in the signal direction.');

  if (ctx.gammaRegime === 'negative') push('NEGATIVE_GAMMA_TREND_REGIME', null, 'Dealers short gamma — hedging is pro-cyclical, trend-supportive.');
  else if (ctx.gammaRegime === 'positive') push('POSITIVE_GAMMA_MEAN_REVERSION', null, 'Dealers long gamma — hedging dampens moves, favors mean reversion.');

  if (c.stockConfirm === 1) push('VWAP_CONFIRMED', null, 'Underlying price agrees with the options direction.');
  else if (c.stockConfirm === -1) push('MARKET_CONFLICT', null, 'Underlying price conflicts with the options direction.');
  if (isNum(ctx.rvol)) push(ctx.rvol >= 1.5 ? 'RVOL_CONFIRMED' : 'RVOL_LOW', null, `RVOL ${r2(ctx.rvol)}x vs same-time-of-day baseline.`);
  if (ctx.earningsWithin2Days) push('EARNINGS_RISK', null, 'Earnings within ~2 trading days — intraday labels may be distorted.');
  const liq = f('liquidity');
  if (liq && liq.avail && liq.strength < 0.3) push('LOW_LIQUIDITY', null, 'Thin options liquidity.');
  return out;
}

// ---------------------------------------------------------------------------
// OUTCOME MATH — pure; callers supply bars captured AFTER the signal.
// ---------------------------------------------------------------------------
// bars: [{ t: epochMs, price }] strictly AFTER entry time, up to the checkpoint.
export function computeCheckpoint({ entryStock, entryOption = null, bars = [], optionBars = [], dir = 'bull', atr = null, entryTs = null }) {
  const clean = bars.filter((b) => isNum(b.price));
  if (!isNum(entryStock) || !clean.length) return { status: 'unavailable', reason: 'no price data after signal' };
  const sign = dir === 'bear' ? -1 : 1;
  const last = clean[clean.length - 1].price;
  const highs = clean.map((b) => (isNum(b.high) ? b.high : b.price));
  const lows = clean.map((b) => (isNum(b.low) ? b.low : b.price));
  const maxUp = Math.max(...highs), maxDown = Math.min(...lows);
  const favorable = sign === 1 ? pct(maxUp, entryStock) : -pct(maxDown, entryStock);
  const adverse = sign === 1 ? pct(maxDown, entryStock) : -pct(maxUp, entryStock);
  const stockRet = pct(last, entryStock);
  const dirRet = isNum(stockRet) ? stockRet * sign : null;
  const optLast = optionBars.length && isNum(optionBars[optionBars.length - 1].price) ? optionBars[optionBars.length - 1].price : null;

  // ATR-normalized return + target/stop labels (never fabricated: null when ATR unavailable)
  const atrPct = (isNum(atr) && isNum(entryStock) && entryStock > 0) ? (atr / entryStock) * 100 : null;
  const atrRet = (isNum(dirRet) && isNum(atrPct) && atrPct > 0) ? r2(dirRet / atrPct) : null;
  let targetReached = null, stopReached = null, timeToTargetMs = null, timeToStopMs = null;
  if (isNum(atrPct) && atrPct > 0) {
    targetReached = false; stopReached = false;
    for (const b of clean) {
      const hi = isNum(b.high) ? b.high : b.price, lo = isNum(b.low) ? b.low : b.price;
      const fav = sign === 1 ? pct(hi, entryStock) : -pct(lo, entryStock);
      const adv = sign === 1 ? pct(lo, entryStock) : -pct(hi, entryStock);
      if (!targetReached && isNum(fav) && fav >= TARGET_ATR * atrPct) { targetReached = true; if (isNum(b.t) && isNum(entryTs)) timeToTargetMs = b.t - entryTs; }
      if (!stopReached && isNum(adv) && adv <= -STOP_ATR * atrPct) { stopReached = true; if (isNum(b.t) && isNum(entryTs)) timeToStopMs = b.t - entryTs; }
      if (targetReached && stopReached) break;
    }
  }
  const outcome = targetReached === true && stopReached !== true ? 'TARGET'
    : stopReached === true && targetReached !== true ? 'STOP'
      : targetReached === true && stopReached === true ? 'BOTH'
        : isNum(dirRet) ? (dirRet > 0 ? 'POSITIVE' : 'NEGATIVE') : 'UNKNOWN';

  return {
    status: 'resolved',
    stockPrice: r2(last), stockChangePct: r2(stockRet),
    optionPrice: r2(optLast), optionChangePct: isNum(entryOption) && isNum(optLast) ? r2(pct(optLast, entryOption)) : null,
    maxFavorablePct: r2(favorable), maxAdversePct: r2(adverse),
    directionalReturnPct: r2(dirRet), atrNormalizedReturn: atrRet,
    targetReached, stopReached, timeToTargetMs, timeToStopMs, outcome,
    samples: clean.length,
  };
}

// ---------------------------------------------------------------------------
// POST-TRADE ANALYSIS — separate field; never touches the original record.
// ---------------------------------------------------------------------------
export function analyzeOutcome(rec, horizon = '60m') {
  const oc = rec && rec.outcomes && rec.outcomes[horizon];
  const ex = rec && rec.explain;
  if (!oc || oc.status !== 'resolved' || !ex) return null;
  const ret = oc.directionalReturnPct;
  if (!isNum(ret)) return null;
  const won = ret > 0;
  const dirFactors = [...(ex.strongestFactors || [])].filter((f) => f.directional);
  const agreeing = dirFactors.filter((f) => f.agrees);
  const conflicting = ex.conflictingFactors || [];

  const base = {
    horizon, verdict: won ? 'WIN' : 'LOSS', directionalReturnPct: ret,
    maxFavorablePct: oc.maxFavorablePct, maxAdversePct: oc.maxAdversePct,
    analyzedAt: null,   // set by caller (kept out of pure fn)
  };

  if (won) {
    return {
      ...base,
      correctFactors: agreeing.map((f) => ({ key: f.key, label: f.label, contribution: f.contribution })),
      topContributor: agreeing.length ? { key: agreeing[0].key, label: agreeing[0].label, contribution: agreeing[0].contribution } : null,
      whatConfirmed: [
        ex.directionalAgreement && ex.directionalAgreement.agree > 0 ? `${ex.directionalAgreement.agree}/${ex.directionalAgreement.total} directional factors pointed the right way.` : null,
        rec.composite.stockConfirm === 1 ? 'Stock price confirmed the options direction at entry.' : null,
        isNum(oc.maxAdversePct) && oc.maxAdversePct > -0.5 ? 'The position saw almost no adverse move — entry timing was clean.' : null,
      ].filter(Boolean),
      notes: isNum(oc.maxFavorablePct) && isNum(ret) && oc.maxFavorablePct > ret * 1.5
        ? `Peak favorable move (${oc.maxFavorablePct}%) was well above the close (${ret}%) — the move faded before the checkpoint.` : null,
    };
  }
  return {
    ...base,
    wrongAssumptions: agreeing.map((f) => ({ key: f.key, label: f.label, note: `${f.label} pointed ${rec.composite.dir} with strength ${f.strength} but price went the other way.` })),
    failedFactors: agreeing.map((f) => f.key),
    reversedFactors: conflicting.map((f) => ({ key: f.key, label: f.label, note: 'This factor disagreed at signal time and was proved right.' })),
    stockOptionsDisagreed: rec.composite.stockConfirm === -1,
    missedWarnings: (ex.risks || []),
    likelyReason: conflicting.length
      ? `The strongest opposing evidence was ignored: ${conflicting.map((c) => c.label).join(', ')} disagreed at signal time.`
      : rec.composite.stockConfirm === -1
        ? 'Options flow was bullish but the stock was already weak — flow did not translate into price.'
        : (ex.unavailableFactors || []).length
          ? `Thin evidence: ${(ex.unavailableFactors || []).length} factor(s) had no data, so the score rested on fewer signals than usual.`
          : 'All available factors agreed, so this looks like normal signal variance rather than a specific failure.',
  };
}

// ---------------------------------------------------------------------------
// LEARNING DATASET — aggregates across completed signals. Observation only.
// ---------------------------------------------------------------------------
export function computeLearning(records, { horizon = '30m', minSample = 5 } = {}) {
  const all = Array.isArray(records) ? records : [];
  const done = all.filter((r) => r && r.outcomes && r.outcomes[horizon] && r.outcomes[horizon].status === 'resolved' && isNum(r.outcomes[horizon].directionalReturnPct));
  const ret = (r) => r.outcomes[horizon].directionalReturnPct;
  const avg = (xs) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

  const winners = done.filter((r) => ret(r) > 0), losers = done.filter((r) => ret(r) <= 0);
  const ret30 = all.filter((r) => r.outcomes && r.outcomes['30m'] && r.outcomes['30m'].status === 'resolved').map((r) => r.outcomes['30m'].directionalReturnPct).filter(isNum);

  // score buckets
  const buckets = [[70, 80], [80, 90], [90, 101]].map(([lo, hi]) => {
    const inB = done.filter((r) => r.composite.finalScore >= lo && r.composite.finalScore < hi);
    return { range: `${lo}-${hi === 101 ? 100 : hi - 1}`, n: inB.length, winRate: inB.length ? r2((inB.filter((r) => ret(r) > 0).length / inB.length) * 100) : null, avgReturn: avg(inB.map(ret)), gated: inB.length < minSample };
  });

  // per-factor performance: only when the factor was available AND agreed with the call
  const factorStats = {};
  for (const r of done) {
    const comps = (r.scored && r.scored.components) || [];
    const dirBit = r.composite.dir === 'bull' ? 1 : -1;
    for (const c of comps) {
      if (!c.avail || !isNum(c.strength) || c.strength <= 0) continue;
      const agreed = c.directional ? c.dir === dirBit : true;
      const k = c.key;
      factorStats[k] = factorStats[k] || { key: k, label: labelOf(k), n: 0, wins: 0, returns: [], agreedN: 0 };
      factorStats[k].n++; if (agreed) factorStats[k].agreedN++;
      if (ret(r) > 0) factorStats[k].wins++;
      factorStats[k].returns.push(ret(r));
    }
  }
  const factors = Object.values(factorStats).map((f) => ({
    key: f.key, label: f.label, n: f.n,
    winRate: f.n ? r2((f.wins / f.n) * 100) : null, avgReturn: avg(f.returns),
    gated: f.n < minSample,   // too few samples to trust
  })).sort((a, b) => (b.avgReturn || -999) - (a.avgReturn || -999));

  const trusted = factors.filter((f) => !f.gated);
  const shadowPairs = done.filter((r) => isNum(r.shadowScore)).map((r) => ({ shadow: r.shadowScore, ret: ret(r) }));

  const charac = (rs) => {
    if (!rs.length) return null;
    return {
      avgScore: avg(rs.map((r) => r.composite.finalScore)),
      avgOptionsScore: avg(rs.map((r) => r.composite.optionsScore)),
      stockConfirmRate: r2((rs.filter((r) => r.composite.stockConfirm === 1).length / rs.length) * 100),
      avgDirectionalAgreement: avg(rs.map((r) => (r.explain && r.explain.directionalAgreement ? r.explain.directionalAgreement.agree : null)).filter(isNum)),
    };
  };

  return {
    horizon, minSample,
    totals: { signals: all.length, resolved: done.length, winners: winners.length, losers: losers.length },
    winRate: done.length ? r2((winners.length / done.length) * 100) : null,
    avg30mReturn: avg(ret30), avg1hReturn: avg(done.map(ret)),
    avgMaxFavorable: avg(done.map((r) => r.outcomes[horizon].maxFavorablePct).filter(isNum)),
    avgMaxAdverse: avg(done.map((r) => r.outcomes[horizon].maxAdversePct).filter(isNum)),
    scoreBuckets: buckets,
    factorPerformance: factors,
    bestFactor: trusted.length ? trusted[0] : null,
    worstFactor: trusted.length ? trusted[trusted.length - 1] : null,
    shadowVsActual: shadowPairs.length >= minSample ? { n: shadowPairs.length, avgShadowWinners: avg(shadowPairs.filter((p) => p.ret > 0).map((p) => p.shadow)), avgShadowLosers: avg(shadowPairs.filter((p) => p.ret <= 0).map((p) => p.shadow)) } : { n: shadowPairs.length, gated: true },
    bestCharacteristics: charac(winners), worstCharacteristics: charac(losers),
    note: 'Observation only — these statistics never modify live engine weights. Buckets/factors with n < minSample are gated as unreliable.',
  };
}

// ---------------------------------------------------------------------------
// TABLE ROW + FILTERING for the dashboard
// ---------------------------------------------------------------------------
export function journalRow(r) {
  const oc = (h) => (r.outcomes && r.outcomes[h] && r.outcomes[h].status === 'resolved' ? r.outcomes[h].directionalReturnPct : null);
  const resolved30 = oc('30m'), resolved1h = oc('60m');
  return {
    id: r.id, ticker: r.ticker, firedAt: r.firedAt, dir: r.composite.dir,
    signal: r.composite.dir === 'bull' ? 'CALL' : 'PUT',
    score: r.composite.finalScore, shadowScore: isNum(r.shadowScore) ? r.shadowScore : null,
    entryStock: r.entry ? r.entry.stockPrice : null, entryOption: r.entry ? r.entry.optionPrice : null,
    r30m: resolved30, r1h: resolved1h,
    status: (resolved1h != null) ? (resolved1h > 0 ? 'WIN' : 'LOSS') : (resolved30 != null ? 'PARTIAL' : 'PENDING'),
  };
}

export function filterJournal(records, q = {}) {
  let rows = Array.isArray(records) ? [...records] : [];
  const s = (v) => (v == null || v === '' ? null : String(v));
  if (s(q.ticker)) rows = rows.filter((r) => r.ticker === String(q.ticker).toUpperCase());
  if (s(q.dir)) rows = rows.filter((r) => r.composite.dir === q.dir);
  if (s(q.status)) rows = rows.filter((r) => journalRow(r).status === q.status);
  if (isNum(Number(q.scoreMin)) && q.scoreMin !== '') rows = rows.filter((r) => r.composite.finalScore >= Number(q.scoreMin));
  if (isNum(Number(q.scoreMax)) && q.scoreMax !== '') rows = rows.filter((r) => r.composite.finalScore <= Number(q.scoreMax));
  if (s(q.from)) rows = rows.filter((r) => r.firedAt >= q.from);
  if (s(q.to)) rows = rows.filter((r) => r.firedAt <= q.to);
  const sort = q.sort || 'newest';
  const ret = (r) => { const o = r.outcomes || {}; for (const h of ['60m', '30m', '15m']) if (o[h] && isNum(o[h].directionalReturnPct)) return o[h].directionalReturnPct; return -Infinity; };
  rows.sort((a, b) => (sort === 'oldest' ? a.firedAt.localeCompare(b.firedAt)
    : sort === 'score_desc' ? b.composite.finalScore - a.composite.finalScore
      : sort === 'score_asc' ? a.composite.finalScore - b.composite.finalScore
        : sort === 'best' ? ret(b) - ret(a)
          : sort === 'worst' ? ret(a) - ret(b)
            : b.firedAt.localeCompare(a.firedAt)));
  const total = rows.length;
  const offset = Math.max(0, Number(q.offset) || 0), limit = Math.max(1, Math.min(200, Number(q.limit) || 50));
  return { total, offset, limit, rows: rows.slice(offset, offset + limit).map(journalRow) };
}
