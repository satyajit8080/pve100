// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentileRank, computeCrossSectional, computeSectorBreadth, marketRegimeState, classifyEarningsProximity, CROSS_SECTIONAL_VERSION } from '../shadow/cross-sectional.js';

test('percentileRank: tie-fair, bounds, null-safe', () => {
  assert.equal(percentileRank([10, 20, 30, 40], 40), 87.5);   // (3 + 0.5)/4 *100
  assert.equal(percentileRank([10, 20, 30, 40], 10), 12.5);
  assert.equal(percentileRank([10, 20, 20, 40], 20), 50);       // (1 below + 0.5*2 equal)/4
  assert.equal(percentileRank([], 5), null);
  assert.equal(percentileRank([1, 2, 3], null), null);
  assert.equal(percentileRank([1, 2, null, 3], 3), percentileRank([1, 2, 3], 3)); // nulls ignored
});

test('computeCrossSectional: per-feature percentiles + composite, nulls ignored, abs magnitude', () => {
  const records = [
    { ticker: 'AAA', features: { netPremium: 9e6, flowQuality: 90, ivRank: 80 } },
    { ticker: 'BBB', features: { netPremium: -8e6, flowQuality: 50, ivRank: 40 } },
    { ticker: 'CCC', features: { netPremium: 1e6, flowQuality: null, ivRank: 60 } },
  ];
  const r = computeCrossSectional(records, ['netPremium', 'flowQuality', 'ivRank'], { absKeys: ['netPremium'], compositeKeys: ['flowQuality', 'ivRank'] });
  assert.equal(r.version, CROSS_SECTIONAL_VERSION);
  assert.equal(r.populationSize, 3);
  // |netPremium|: AAA(9e6) highest, BBB(8e6) mid, CCC(1e6) lowest
  assert.ok(r.perTicker.AAA.ranks.netPremium > r.perTicker.BBB.ranks.netPremium);
  assert.ok(r.perTicker.BBB.ranks.netPremium > r.perTicker.CCC.ranks.netPremium);
  assert.equal(r.perTicker.CCC.ranks.flowQuality, null);       // null value → null rank
  assert.equal(r.features.flowQuality.count, 2);               // only 2 non-null
  // composite uses flowQuality+ivRank; CCC has only ivRank → composite = ivRank rank
  assert.ok(isFinite(r.perTicker.AAA.composite));
});

test('computeSectorBreadth: dominant direction + alignment + breadth %', () => {
  const records = [
    { ticker: 'NVDA', sector: 'Technology', direction: 'bullish' },
    { ticker: 'AMD', sector: 'Technology', direction: 'bullish' },
    { ticker: 'INTC', sector: 'Technology', direction: 'bearish' },
    { ticker: 'XOM', sector: 'Energy', direction: 'bearish' },
  ];
  const r = computeSectorBreadth(records);
  assert.equal(r.sectors.Technology.total, 3);
  assert.equal(r.sectors.Technology.dominant, 'bullish');
  assert.ok(Math.abs(r.sectors.Technology.breadthPct - 66.7) < 0.2);   // 2/3
  assert.equal(r.perTicker.NVDA.aligned, true);
  assert.equal(r.perTicker.INTC.aligned, false);
  assert.equal(r.perTicker.XOM.dominant, 'bearish');
});

test('marketRegimeState: gex sign + trend + tide → state; conditioning only', () => {
  const pos = marketRegimeState({ indexGex: 1e9, indexMomentumRet: 0.02, tideNet: 5e8, dix: 45 });
  assert.equal(pos.gexRegime, 'positive'); assert.equal(pos.trend, 'bullish'); assert.equal(pos.tide, 'bullish');
  assert.match(pos.state, /positive-gamma/);
  const neg = marketRegimeState({ indexGex: -1e9, indexMomentumRet: -0.03 });
  assert.equal(neg.gexRegime, 'negative'); assert.match(neg.state, /negative-gamma/);
  const nul = marketRegimeState({});
  assert.equal(nul.gexRegime, 'neutral'); assert.equal(nul.dix, null);
});

test('classifyEarningsProximity: buckets from signed days', () => {
  assert.equal(classifyEarningsProximity(null), 'unknown');
  assert.equal(classifyEarningsProximity(0), 'imminent');
  assert.equal(classifyEarningsProximity(1), 'imminent');
  assert.equal(classifyEarningsProximity(5), 'approaching');
  assert.equal(classifyEarningsProximity(30), 'far');
  assert.equal(classifyEarningsProximity(-1), 'post');
  assert.equal(classifyEarningsProximity(-10), 'far');
});
