// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelMultiHorizon } from '../research/labeler.js';
import { buildDataset, DATASET_FEATURES } from '../research/dataset.js';
import { walkForwardSplits, verifyNoLeakage, scoreBuckets, featureDecisionTable, performanceSummary, breakdownBy } from '../research/validate.js';
import { permutationImportance, univariateCorrelations } from '../research/importance.js';
import { mulberry32, sharpe, maxDrawdown, bootstrapCI } from '../research/stats.js';

test('labelMultiHorizon: per-horizon MFE/MAE + target/adverse timing, no look-ahead', () => {
  const bars = [
    { date: '2026-08-17', high: 101, low: 98, close: 100 },   // entry
    { date: '2026-08-18', high: 104, low: 99, close: 103 },   // +4% high (target 3% hit at step1)
    { date: '2026-08-19', high: 106, low: 102, close: 105 },
    { date: '2026-08-20', high: 105, low: 95, close: 97 },    // -5% low (adverse 3% hit at step3)
  ];
  const r = labelMultiHorizon({ bars, entryIndex: 0, direction: 'bull', horizons: [1, 3], targetPct: 0.03, adversePct: 0.03 });
  assert.equal(r.byHorizon[1].targetReached, true);
  assert.equal(r.byHorizon[1].timeToTargetDays, 1);
  assert.equal(r.byHorizon[1].adverseReached, false);          // day1 low 99 = -1%, not -3%
  assert.equal(r.byHorizon[3].adverseReached, true);
  assert.equal(r.byHorizon[3].timeToAdverseDays, 3);
  assert.ok(r.byHorizon[3].mfePct > 5);
});

// ---- synthetic dataset with a PLANTED edge + pure noise features (pipeline correctness ONLY) ----
function syntheticRows(n = 600, seed = 7) {
  const rng = mulberry32(seed); const rows = [];
  const start = Date.parse('2024-01-01');
  for (let i = 0; i < n; i++) {
    const edge = rng() * 2 - 1;                 // planted feature in [-1,1]
    const noise = rng() * 2 - 1;                // irrelevant feature
    // forward return truly depends on `edge` plus noise; build 12 daily bars so all horizons label
    const drift = 0.02 * edge;                  // signal
    const day = new Date(start + i * 86400000).toISOString().slice(0, 10);
    let px = 100; const bars = [{ date: day, high: px * 1.005, low: px * 0.995, close: px }];
    for (let d = 1; d <= 12; d++) { const step = drift / 6 + (rng() - 0.5) * 0.01; px = px * (1 + step); const dt = new Date(start + i * 86400000 + d * 86400000).toISOString().slice(0, 10); bars.push({ date: dt, high: px * 1.006, low: px * 0.994, close: px }); }
    rows.push({ ts: day + 'T15:00:00Z', ticker: 'T' + (i % 20), direction: edge >= 0 ? 'bull' : 'bear', shadowScore: Math.round((edge + 1) * 50), plantedEdge: edge, noiseFeature: noise, __bars: bars });
  }
  return rows;
}
function datasetFromSynthetic(rows) {
  const ohlc = {}; for (const r of rows) ohlc[r.ticker] = ohlc[r.ticker] || { bars: [] };
  // each row carries its own forward bars; build a per-row dataset by labeling directly
  const built = rows.map((r) => ({ ...r, labels: labelMultiHorizon({ bars: r.__bars, entryIndex: 0, direction: r.direction, horizons: [1, 3, 5, 10] }) }));
  return { rows: built };
}

test('walkForwardSplits: chronological, purge+embargo, zero leakage', () => {
  const rows = syntheticRows(300);
  const splits = walkForwardSplits(rows, { folds: 4, horizonDays: 5, embargoDays: 5 });
  assert.ok(splits.length >= 2);
  for (const s of splits) { assert.ok(s.trainIdx.length > 0 && s.testIdx.length > 0); assert.ok(Math.max(...s.trainIdx) < Math.min(...s.testIdx)); } // train strictly before test
  assert.equal(verifyNoLeakage(rows, splits, { horizonDays: 5, embargoDays: 5 }).ok, true);
});

test('scoreBuckets: higher planted score → better outcomes (monotone-ish)', () => {
  const { rows } = datasetFromSynthetic(syntheticRows(600));
  const b = scoreBuckets(rows, { scoreKey: 'shadowScore', horizon: 5 });
  const hi = b.find((x) => x.bucket === '80-89' || x.bucket === '90-100');
  const lo = b.find((x) => x.bucket === '0-49');
  assert.ok(hi && lo && hi.count > 0 && lo.count > 0);
  assert.ok(hi.avgReturn > lo.avgReturn, `hi ${hi.avgReturn} !> lo ${lo.avgReturn}`);
});

test('featureDecisionTable: planted feature earns edge, noise does not; thin sample → SHADOW ONLY', () => {
  const { rows } = datasetFromSynthetic(syntheticRows(800));
  const table = featureDecisionTable(rows, ['plantedEdge', 'noiseFeature'], { horizon: 5, minSample: 200, minCorr: 0.03 });
  const planted = table.find((t) => t.feature === 'plantedEdge');
  const noise = table.find((t) => t.feature === 'noiseFeature');
  assert.ok(Math.abs(planted.oosCorr) > Math.abs(noise.oosCorr || 0), 'planted must out-correlate noise OOS');
  // thin-sample honesty: below minSample everything is SHADOW ONLY
  const thin = featureDecisionTable(rows.slice(0, 50), ['plantedEdge'], { horizon: 5, minSample: 200 });
  assert.equal(thin[0].decision, 'SHADOW ONLY');
  assert.equal(thin[0].incrementalValue, 'INSUFFICIENT DATA');
});

test('permutationImportance: planted feature ranks above noise (offline ML)', () => {
  const { rows } = datasetFromSynthetic(syntheticRows(600));
  const withRet = rows.filter((r) => r.labels.byHorizon[5].insufficient === false).map((r) => ({ plantedEdge: r.plantedEdge, noiseFeature: r.noiseFeature, __ret: r.labels.byHorizon[5].ret }));
  const imp = permutationImportance(withRet, ['plantedEdge', 'noiseFeature'], (r) => r.__ret);
  assert.equal(imp.insufficient, false);
  const p = imp.importances.find((x) => x.feature === 'plantedEdge').importance;
  const nz = imp.importances.find((x) => x.feature === 'noiseFeature').importance;
  assert.ok(p >= nz, `planted importance ${p} !>= noise ${nz}`);
});

test('buildDataset: coverage reporting + null-safety (never fabricates)', () => {
  const rows = [
    { ts: '2026-08-17T15:00:00Z', ticker: 'AAA', direction: 'bull', shadowScore: 70, flowQuality: 80 },
    { ts: '2026-08-18T15:00:00Z', ticker: 'AAA', direction: 'bull', shadowScore: 60 },  // flowQuality missing
  ];
  const ohlc = { AAA: { bars: [{ date: '2026-08-17', high: 101, low: 99, close: 100 }, { date: '2026-08-18', high: 103, low: 100, close: 102 }, { date: '2026-08-19', high: 104, low: 101, close: 103 }] } };
  const ds = buildDataset(rows, ohlc, { horizons: [1] });
  assert.equal(ds.size, 2);
  assert.equal(ds.coverage.flowQuality, 50);          // 1 of 2 present
  assert.equal(ds.coverage.shadowScore, 100);
  assert.ok(ds.dateRange.from === '2026-08-17' && ds.dateRange.to === '2026-08-18');
});

test('stats: sharpe/maxDrawdown/bootstrap deterministic + sane', () => {
  const rets = [0.01, -0.005, 0.02, 0.0, -0.01, 0.015, 0.005, -0.002];
  assert.ok(isFinite(sharpe(rets)));
  assert.ok(maxDrawdown(rets) <= 0);
  const a = bootstrapCI(rets, { iters: 500, seed: 1 }); const b = bootstrapCI(rets, { iters: 500, seed: 1 });
  assert.deepEqual(a, b);                               // seeded → reproducible
  assert.ok(a.lo <= a.mean && a.mean <= a.hi);
});

test('breakdownBy: groups produce per-group hit-rate/return', () => {
  const { rows } = datasetFromSynthetic(syntheticRows(200));
  const byDir = breakdownBy(rows, (r) => r.direction, { horizon: 5 });
  assert.ok(byDir.bull && byDir.bull.count > 0);
});
