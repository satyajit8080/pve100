// @ts-check
/*
 * shadow/cross-sectional.js — PHASE 2 (SHADOW ONLY). Pure, deterministic, no I/O, no deps.
 *
 * Cross-sectional intelligence across the S&P 500 universe: percentile ranking of supported
 * features, sector-cluster confirmation, market-regime conditioning, and earnings awareness.
 * NEVER used by the live deterministic score (finalScore/dir/tier) and cannot write back to it.
 * Ranks ONLY values that are actually present; missing data stays null (never fabricated).
 */

export const CROSS_SECTIONAL_VERSION = 'xsec-1.0.0';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const round1 = (x) => (isNum(x) ? Math.round(x * 10) / 10 : null);

/** Percentile rank of x within values (0..100), tie-fair: (below + 0.5*equal)/n. Nulls ignored. */
export function percentileRank(values, x) {
  if (!isNum(x)) return null;
  const v = (values || []).filter(isNum);
  if (v.length === 0) return null;
  let below = 0, equal = 0;
  for (const y of v) { if (y < x) below++; else if (y === x) equal++; }
  return round1(((below + 0.5 * equal) / v.length) * 100);
}

const getField = (rec, k) => {
  if (!rec) return null;
  if (rec.features && typeof rec.features === 'object' && k in rec.features) return rec.features[k];
  return k in rec ? rec[k] : null;
};

/**
 * Rank each record against the population for every feature in `featureKeys`.
 * @param {Array<object>} records  each has a `ticker` and either flat feature fields or a `features` object
 * @param {string[]} featureKeys   numeric features to rank (e.g. ['netPremium','flowQuality','ivRank',...])
 * @param {{absKeys?:string[], compositeKeys?:string[]}} [opts]
 *   absKeys: rank by |value| (magnitude) instead of signed value (e.g. netPremium notability).
 *   compositeKeys: subset averaged into a provisional composite "notability" percentile.
 * @returns {{version:string, populationSize:number, features:object, perTicker:object}}
 */
export function computeCrossSectional(records, featureKeys, opts = {}) {
  const recs = Array.isArray(records) ? records.filter((r) => r && r.ticker) : [];
  const absKeys = new Set(opts.absKeys || []);
  const compositeKeys = opts.compositeKeys || featureKeys;
  const valueFor = (rec, k) => { const raw = getField(rec, k); if (!isNum(raw)) return null; return absKeys.has(k) ? Math.abs(raw) : raw; };

  const pop = {};                                   // feature -> value array
  for (const k of featureKeys) pop[k] = recs.map((r) => valueFor(r, k)).filter(isNum);

  const features = {};
  for (const k of featureKeys) { const arr = pop[k]; features[k] = { count: arr.length, min: arr.length ? Math.min(...arr) : null, max: arr.length ? Math.max(...arr) : null, abs: absKeys.has(k) }; }

  const perTicker = {};
  for (const r of recs) {
    const ranks = {};
    for (const k of featureKeys) ranks[k] = percentileRank(pop[k], valueFor(r, k));
    const compVals = compositeKeys.map((k) => ranks[k]).filter(isNum);
    perTicker[String(r.ticker).toUpperCase()] = { ranks, composite: compVals.length ? round1(mean(compVals)) : null };
  }
  return { version: CROSS_SECTIONAL_VERSION, populationSize: recs.length, features, perTicker };
}

/**
 * Sector-cluster confirmation from per-ticker {sector, direction}.
 * direction ∈ 'bullish'|'bearish'|'neutral' (or 'bull'/'bear').
 */
export function computeSectorBreadth(records) {
  const norm = (d) => (d === 'bull' || d === 'bullish' ? 'bullish' : d === 'bear' || d === 'bearish' ? 'bearish' : 'neutral');
  const sectors = {};
  for (const r of records || []) {
    const sec = r && r.sector ? String(r.sector) : null; if (!sec) continue;
    const s = sectors[sec] || (sectors[sec] = { sector: sec, total: 0, bullish: 0, bearish: 0, neutral: 0 });
    s.total++; s[norm(r.direction)]++;
  }
  for (const s of Object.values(sectors)) {
    const dom = s.bullish === s.bearish ? 'neutral' : (s.bullish > s.bearish ? 'bullish' : 'bearish');
    s.dominant = dom;
    s.breadthPct = s.total ? round1((Math.max(s.bullish, s.bearish) / s.total) * 100) : null;
  }
  const perTicker = {};
  for (const r of records || []) {
    if (!r || !r.ticker || !r.sector) continue;
    const s = sectors[String(r.sector)]; const d = norm(r.direction);
    perTicker[String(r.ticker).toUpperCase()] = { sector: r.sector, dominant: s.dominant, breadthPct: s.breadthPct, aligned: d !== 'neutral' && d === s.dominant, sectorCount: s.total };
  }
  return { sectors, perTicker };
}

/** Market regime from index GEX + index momentum + market tide + DIX. Conditioning, NOT direction. */
export function marketRegimeState({ indexGex, indexMomentumRet, tideNet, dix } = {}) {
  const gexRegime = !isNum(indexGex) ? 'neutral' : indexGex > 0 ? 'positive' : indexGex < 0 ? 'negative' : 'neutral';
  const trend = !isNum(indexMomentumRet) ? 'neutral' : indexMomentumRet > 0.005 ? 'bullish' : indexMomentumRet < -0.005 ? 'bearish' : 'neutral';
  const tide = !isNum(tideNet) ? 'neutral' : tideNet > 0 ? 'bullish' : tideNet < 0 ? 'bearish' : 'neutral';
  let state;
  if (gexRegime === 'positive') state = 'positive-gamma (mean-reverting / pinning)';
  else if (gexRegime === 'negative') state = 'negative-gamma (expansion / trend-prone)';
  else state = 'neutral-gamma';
  if (gexRegime !== 'neutral' && trend !== 'neutral') state += ` · ${trend} trend`;
  return { gexRegime, trend, tide, dix: isNum(dix) ? dix : null, state };
}

/** Earnings proximity bucket from signed days-to-earnings (negative = already reported). */
export function classifyEarningsProximity(daysToEarnings) {
  if (!isNum(daysToEarnings)) return 'unknown';
  if (daysToEarnings < 0) return daysToEarnings >= -3 ? 'post' : 'far';
  if (daysToEarnings <= 1) return 'imminent';
  if (daysToEarnings <= 7) return 'approaching';
  return 'far';
}
