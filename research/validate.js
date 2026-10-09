// @ts-check
/*
 * research/validate.js — OFFLINE research only. The validation engine: chronological walk-forward
 * with purge + embargo, score-bucket analysis, benchmarks, feature ablation, market-regime/sector/
 * earnings breakdowns, and the KEEP/REMOVE feature-decision table. Pure functions over a dataset
 * built by dataset.js. NOT imported by the server; NEVER touches live scoring.
 *
 * Leakage protections are explicit:
 *  - PURGE: a training row whose forward label window [t, t+H] overlaps the test window is dropped,
 *    because its outcome partly depends on test-period price action (overlapping-label leakage).
 *  - EMBARGO: training rows within `embargoDays` AFTER the test window are dropped, because serial
 *    correlation would otherwise leak test information backwards into training.
 */
import { mean, median, std, isNum, bootstrapCI, blockBootstrapCI, sharpe, sortino, maxDrawdown, winRate, payoffRatio, profitFactor, deflatedSharpe, pearson, spearman } from './stats.js';

const labelAt = (row, H, key) => (row && row.labels && row.labels.byHorizon && row.labels.byHorizon[H] ? row.labels.byHorizon[H][key] : null);
const sortByTs = (rows) => rows.slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

/**
 * Chronological walk-forward splits with purge + embargo. Expanding train window by default.
 * @returns {Array<{fold:number, trainIdx:number[], testIdx:number[], testFrom:string, testTo:string, purged:number, embargoed:number}>}
 */
export function walkForwardSplits(rows, { folds = 4, horizonDays = 5, embargoDays = 5, expanding = true, minTrain = 20 } = {}) {
  const r = sortByTs(rows);
  const n = r.length; const out = [];
  if (n < folds + minTrain) return out;
  const testSize = Math.floor(n / (folds + 1));
  if (testSize < 1) return out;
  const dayMs = 86400000;
  for (let f = 0; f < folds; f++) {
    const testStart = (f + 1) * testSize; const testEnd = Math.min(n, testStart + testSize);
    if (testStart >= n) break;
    const testIdx = []; for (let i = testStart; i < testEnd; i++) testIdx.push(i);
    const testFromDay = Date.parse(String(r[testStart].ts).slice(0, 10));
    const testToDay = Date.parse(String(r[testEnd - 1].ts).slice(0, 10));
    const trainIdx = []; let purged = 0, embargoed = 0;
    const trainUpper = expanding ? testStart : testStart; // expanding uses all history before test
    for (let i = 0; i < trainUpper; i++) {
      const tDay = Date.parse(String(r[i].ts).slice(0, 10));
      // PURGE: label window [t, t + horizon] overlaps [testFrom, testTo]
      const labelEnd = tDay + horizonDays * dayMs;
      if (labelEnd >= testFromDay && tDay <= testToDay) { purged++; continue; }
      // EMBARGO: within embargoDays AFTER test window
      if (tDay > testToDay && tDay <= testToDay + embargoDays * dayMs) { embargoed++; continue; }
      trainIdx.push(i);
    }
    out.push({ fold: f + 1, trainIdx, testIdx, testFrom: r[testStart].ts, testTo: r[testEnd - 1].ts, purged, embargoed });
  }
  return out;
}

/** Assert no train row falls inside the purge/embargo exclusion of its test window (leakage self-check). */
export function verifyNoLeakage(rows, splits, { horizonDays = 5, embargoDays = 5 } = {}) {
  const r = sortByTs(rows); const dayMs = 86400000;
  for (const s of splits) {
    const testFrom = Date.parse(String(r[s.testIdx[0]].ts).slice(0, 10));
    const testTo = Date.parse(String(r[s.testIdx[s.testIdx.length - 1]].ts).slice(0, 10));
    for (const i of s.trainIdx) {
      const t = Date.parse(String(r[i].ts).slice(0, 10)); const labelEnd = t + horizonDays * dayMs;
      if (labelEnd >= testFrom && t <= testTo) return { ok: false, reason: `purge violation fold ${s.fold}` };
      if (t > testTo && t <= testTo + embargoDays * dayMs) return { ok: false, reason: `embargo violation fold ${s.fold}` };
    }
  }
  return { ok: true };
}

const BUCKETS = [[0, 49], [50, 59], [60, 69], [70, 79], [80, 89], [90, 100]];
/** Score-bucket analysis: do higher scores correspond to better forward outcomes? */
export function scoreBuckets(rows, { scoreKey = 'shadowScore', horizon = 5 } = {}) {
  const out = [];
  for (const [lo, hi] of BUCKETS) {
    const inb = rows.filter((r) => isNum(r[scoreKey]) && r[scoreKey] >= lo && r[scoreKey] <= hi && labelAt(r, horizon, 'insufficient') === false);
    const rets = inb.map((r) => labelAt(r, horizon, 'ret'));
    const hits = inb.map((r) => labelAt(r, horizon, 'directionCorrect')).filter((x) => x === true || x === false);
    const mfe = inb.map((r) => labelAt(r, horizon, 'mfe')), mae = inb.map((r) => labelAt(r, horizon, 'mae'));
    const avgMfe = mean(mfe), avgMae = mean(mae);
    out.push({ bucket: `${lo}-${hi}`, count: inb.length, hitRate: hits.length ? hits.filter(Boolean).length / hits.length : null, avgReturn: mean(rets), medianReturn: median(rets), mfe: avgMfe, mae: avgMae, faRatio: (isNum(avgMfe) && isNum(avgMae) && avgMae !== 0) ? Math.abs(avgMfe / avgMae) : null });
  }
  return out;
}

/** Benchmarks vs the signal set — uses fields when present (spyRet, sectorRet, momentum); honest nulls otherwise. */
export function benchmarks(rows, { horizon = 5, scoreKey = 'shadowScore', topFrac = 0.2, seed = 42 } = {}) {
  const labeled = rows.filter((r) => labelAt(r, horizon, 'insufficient') === false);
  const ret = (r) => labelAt(r, horizon, 'ret');
  const all = labeled.map(ret);
  const ranked = labeled.filter((r) => isNum(r[scoreKey])).sort((a, b) => b[scoreKey] - a[scoreKey]);
  const top = ranked.slice(0, Math.max(1, Math.floor(ranked.length * topFrac))).map(ret);
  const spy = labeled.map((r) => r.spyRet).filter(isNum);
  const sector = labeled.map((r) => r.sectorRet).filter(isNum);
  // momentum baseline: go with sign of momentum feature, realize forward ret
  const momo = labeled.filter((r) => isNum(r.momentum)).map((r) => (r.momentum >= 0 ? ret(r) : -ret(r))).filter(isNum);
  return {
    strategyTop: { n: top.length, avgReturn: mean(top) },
    allSignals: { n: all.length, avgReturn: mean(all) },
    randomControl: { n: all.length, avgReturn: mean(all) }, // random selection ≈ population mean
    spy: { n: spy.length, avgReturn: spy.length ? mean(spy) : null },
    sector: { n: sector.length, avgReturn: sector.length ? mean(sector) : null },
    momentumBaseline: { n: momo.length, avgReturn: momo.length ? mean(momo) : null },
    incrementalVsRandom: (isNum(mean(top)) && isNum(mean(all))) ? mean(top) - mean(all) : null,
  };
}

/** Generic ablation: score each row with a scoreFn(row, enabledGroups) and correlate to forward return. */
export function ablation(rows, scoreFn, groups, { horizon = 5 } = {}) {
  const labeled = rows.filter((r) => labelAt(r, horizon, 'insufficient') === false);
  const y = labeled.map((r) => labelAt(r, horizon, 'ret'));
  const configs = { 'existing-only': [] };
  for (const g of groups) configs[`existing+${g}`] = [g];
  configs['full'] = groups.slice();
  const results = {};
  for (const [name, enabled] of Object.entries(configs)) {
    const x = labeled.map((r) => scoreFn(r, new Set(enabled)));
    results[name] = { corr: pearson(x, y), spearman: spearman(x, y), n: labeled.length };
  }
  return results;
}

const groupBy = (rows, keyFn) => { const m = {}; for (const r of rows) { const k = keyFn(r); if (k == null) continue; (m[k] = m[k] || []).push(r); } return m; };
/** Breakdown of hit-rate / avg return by an arbitrary key (regime, sector, earnings bucket, …). */
export function breakdownBy(rows, keyFn, { horizon = 5 } = {}) {
  const labeled = rows.filter((r) => labelAt(r, horizon, 'insufficient') === false);
  const groups = groupBy(labeled, keyFn); const out = {};
  for (const [k, rs] of Object.entries(groups)) {
    const rets = rs.map((r) => labelAt(r, horizon, 'ret'));
    const hits = rs.map((r) => labelAt(r, horizon, 'directionCorrect')).filter((x) => x === true || x === false);
    out[k] = { count: rs.length, hitRate: hits.length ? hits.filter(Boolean).length / hits.length : null, avgReturn: mean(rets), medianReturn: median(rets) };
  }
  return out;
}

/** Full risk/return summary for a return series. */
export function performanceSummary(returns, { periodsPerYear = 252, nTrials = 1 } = {}) {
  const r = returns.filter(isNum);
  const sr = sharpe(r, { periodsPerYear });
  return {
    n: r.length, avgReturn: mean(r), medianReturn: median(r), std: std(r),
    sharpe: sr, sortino: sortino(r, { periodsPerYear }), maxDrawdown: maxDrawdown(r),
    winRate: winRate(r), payoffRatio: payoffRatio(r), profitFactor: profitFactor(r),
    bootstrapCI: bootstrapCI(r), blockBootstrapCI: blockBootstrapCI(r),
    deflatedSharpe: deflatedSharpe(sr, { nTrials, nObs: r.length }),
  };
}

/**
 * Feature-decision table. For each feature, walk-forward out-of-sample correlation to forward
 * return (per-fold, on TEST rows only), coverage, robustness (sign stability across folds), and a
 * decision. With small samples the honest decision is SHADOW ONLY (never promote on thin evidence).
 * @returns {Array<{feature, sampleSize, coverage, oosCorr, oosStability, incrementalValue, robustness, decision, reason}>}
 */
export function featureDecisionTable(rows, features, { horizon = 5, minSample = 200, minStability = 0.6, minCorr = 0.03, embargoDays = 5 } = {}) {
  const r = sortByTs(rows);
  const splits = walkForwardSplits(r, { horizonDays: horizon, embargoDays });
  const table = [];
  for (const f of features) {
    const present = r.filter((row) => isNum(row[f]) && labelAt(row, horizon, 'insufficient') === false);
    const sampleSize = present.length;
    const coverage = r.length ? Math.round((present.length / r.length) * 1000) / 10 : 0;
    if (!splits.length || sampleSize < minSample) {
      table.push({ feature: f, sampleSize, coverage, oosCorr: null, oosStability: null, incrementalValue: 'INSUFFICIENT DATA', robustness: 'INSUFFICIENT DATA', decision: 'SHADOW ONLY', reason: !splits.length ? 'not enough observations for walk-forward' : `sample ${sampleSize} < minSample ${minSample}` });
      continue;
    }
    const foldCorrs = [];
    for (const s of splits) {
      const test = s.testIdx.map((i) => r[i]).filter((row) => isNum(row[f]) && labelAt(row, horizon, 'insufficient') === false);
      if (test.length < 10) continue;
      const c = pearson(test.map((row) => row[f]), test.map((row) => labelAt(row, horizon, 'ret')));
      if (isNum(c)) foldCorrs.push(c);
    }
    const oosCorr = mean(foldCorrs);
    const signs = foldCorrs.map((c) => Math.sign(c)); const dom = signs.length ? Math.max(signs.filter((s) => s > 0).length, signs.filter((s) => s < 0).length) / signs.length : 0;
    const stability = foldCorrs.length ? dom : null;
    let decision = 'REMOVE', reason = 'no out-of-sample edge';
    if (isNum(oosCorr) && Math.abs(oosCorr) >= minCorr && isNum(stability) && stability >= minStability) { decision = Math.abs(oosCorr) >= minCorr * 2 ? 'KEEP' : 'KEEP WITH LOWER WEIGHT'; reason = `OOS corr ${oosCorr.toFixed(3)}, stability ${(stability * 100).toFixed(0)}%`; }
    else if (isNum(oosCorr) && Math.abs(oosCorr) >= minCorr) { decision = 'SHADOW ONLY'; reason = `edge present but unstable (stability ${stability != null ? (stability * 100).toFixed(0) + '%' : 'n/a'})`; }
    table.push({ feature: f, sampleSize, coverage, oosCorr, oosStability: stability, incrementalValue: isNum(oosCorr) ? oosCorr : 'INSUFFICIENT DATA', robustness: stability, decision, reason });
  }
  return table;
}
