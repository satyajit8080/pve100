// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeShadow, classifyGexRegime, computeFlowQuality, flowPriceRelation, realizedVol, atmIvSpread, SHADOW_ENGINE_VERSION } from '../shadow/engine.js';

test('classifyGexRegime: sign of net GEX, neutral at the flip pivot', () => {
  assert.equal(classifyGexRegime(1e9, 0.02), 'positive');
  assert.equal(classifyGexRegime(-1e9, -0.02), 'negative');
  assert.equal(classifyGexRegime(1e9, 0.001), 'neutral');   // sitting on flip
  assert.equal(classifyGexRegime(null, null), 'neutral');
});

test('realizedVol: annualized, null on insufficient data', () => {
  const bars = Array.from({ length: 25 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, close: 100 * (1 + 0.01 * Math.sin(i)) }));
  const rv = realizedVol(bars, 20);
  assert.ok(rv > 0 && rv < 5);
  assert.equal(realizedVol([{ close: 1 }], 20), null);
});

test('computeFlowQuality: aggressor-signed direction; not "unusual = bullish"', () => {
  // buy PUTS (bearish) dominate by premium despite being "unusual"
  const flow = { trades: [
    { right: 'put', premium: 5e6, size: 2000, isOpening: true, golden: true, type: 'Sweep', direction: 'buy', dte: 20, otm: 3, openInterest: 1000 },
    { right: 'call', premium: 4e5, size: 100, isOpening: false, golden: false, type: 'Block', direction: 'buy', dte: 20, otm: 3, openInterest: 5000 },
  ] };
  const r = computeFlowQuality(flow);
  assert.equal(r.available, true);
  assert.equal(r.direction, 'bearish');       // buying puts ⇒ bearish, not "calls present ⇒ bullish"
  assert.ok(r.score > 0 && r.score <= 100);
  assert.equal(r.goldenCount, 1);
  assert.equal(computeFlowQuality({}).available, false);
});

test('flowPriceRelation: confirming vs divergence', () => {
  assert.deepEqual(flowPriceRelation('bullish', 'bullish'), { relation: 'confirming', conflict: false });
  assert.deepEqual(flowPriceRelation('bullish', 'bearish'), { relation: 'divergence-bullish', conflict: true });
  assert.deepEqual(flowPriceRelation('bearish', 'bullish'), { relation: 'divergence-bearish', conflict: true });
  assert.deepEqual(flowPriceRelation('neutral', 'bullish'), { relation: 'neutral', conflict: false });
});

test('atmIvSpread: call minus put IV at nearest-to-spot strikes', () => {
  const chain = { contracts: [
    { type: 'call', strike: 100, iv: 0.42 }, { type: 'put', strike: 100, iv: 0.38 },
    { type: 'call', strike: 120, iv: 0.5 },
  ] };
  const r = atmIvSpread(chain, 101);
  assert.equal(r.available, true);
  assert.ok(Math.abs(r.spread - 0.04) < 1e-9);
  assert.equal(r.label, 'bullish');           // calls richer
  assert.equal(atmIvSpread({ contracts: [] }, 100).available, false);
});

const fullInputs = () => ({
  gex: { available: true, net_gex: 1.2e9, net_vanna: 1e7, net_charm: -2e6, gamma_flip: 442, call_wall: 460, put_wall: 440 },
  byStrike: { strikes: [{ strike: 449, netGex: 3 }, { strike: 451, netGex: 4 }] },
  ivRank: { iv_rank: 60, iv_percentile: 70, current_iv: 0.45 },
  skew: { skew25: 0.02, percentile: 40 },
  termStructure: { slope3090: -0.02 },
  flow: { trades: [{ right: 'call', premium: 3e6, size: 1500, isOpening: true, golden: true, type: 'Sweep', direction: 'buy', dte: 25, otm: 4, openInterest: 1200 }] },
  netPremium: { total_net_premium: 5e6, total_bullish_premium: 9e6, total_bearish_premium: 3e6 },
  underlying: { price: 450 },
  ohlc: { bars: Array.from({ length: 30 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, high: 100 + i + 1, low: 99 + i, close: 100 + i })) },
  chain: { contracts: [{ type: 'call', strike: 450, iv: 0.46 }, { type: 'put', strike: 450, iv: 0.42 }] },
  market: { gexRegime: 'positive', tideDirection: 'bullish', dix: 45 },
});

test('computeShadow: full block, bounded score, explainable components, correct fields', () => {
  const s = computeShadow(fullInputs());
  assert.equal(s.version, SHADOW_ENGINE_VERSION);
  assert.equal(s.status, 'shadow — not used in live score');
  assert.ok(s.shadowScore >= 0 && s.shadowScore <= 100);
  assert.ok(['bull', 'bear', 'neutral'].includes(s.shadowDirection));
  assert.equal(s.regime.gex, 'positive');
  assert.ok(Math.abs(s.regime.flipDistancePct - (450 - 442) / 450) < 1e-9);
  assert.equal(s.regime.nearSpotGex, 7);
  assert.equal(s.greeks.vanna, 1e7); assert.equal(s.greeks.charm, -2e6);
  assert.equal(s.flow.direction, 'bullish');        // bullish net premium + buy-call flow
  assert.equal(s.iv.ivSpreadLabel, 'bullish');      // 0.46 vs 0.42
  assert.ok(isFinite(s.vrp.realizedVol));
  assert.ok(Array.isArray(s.components) && s.components.length >= 6);
  assert.ok(s.dataQuality > 0.5);
});

test('computeShadow: bullish setup scores above neutral; bearish below (direction sanity)', () => {
  const bull = computeShadow(fullInputs());
  const bearInputs = fullInputs();
  bearInputs.flow = { trades: [{ right: 'put', premium: 4e6, size: 2000, isOpening: true, golden: true, type: 'Sweep', direction: 'buy', dte: 25, otm: 4, openInterest: 1000 }] };
  bearInputs.netPremium = { total_net_premium: -4e6, total_bullish_premium: 2e6, total_bearish_premium: 8e6 };
  bearInputs.chain = { contracts: [{ type: 'call', strike: 450, iv: 0.4 }, { type: 'put', strike: 450, iv: 0.48 }] };
  bearInputs.skew = { skew25: 0.06, percentile: 85 };
  const bear = computeShadow(bearInputs);
  assert.ok(bull.shadowScore > bear.shadowScore, `bull ${bull.shadowScore} !> bear ${bear.shadowScore}`);
});

test('computeShadow: PURE (no input mutation) + deterministic (stable across calls)', () => {
  const inp = fullInputs();
  const snap = JSON.stringify(inp);
  const a = computeShadow(inp); const b = computeShadow(inp);
  assert.equal(JSON.stringify(inp), snap);          // inputs untouched
  assert.deepEqual(a, b);                            // deterministic
});

test('computeShadow: empty inputs never throw, never fabricate, score defined', () => {
  const s = computeShadow({});
  assert.equal(s.regime.gex, 'neutral');
  assert.equal(s.regime.netGex, null);
  assert.equal(s.flow.direction, 'neutral');
  assert.equal(s.iv.skew25, null);
  assert.equal(s.vrp.value, null);
  assert.ok(s.shadowScore >= 0 && s.shadowScore <= 100);
  assert.equal(s.dataQuality, 0);
});

test('computeShadow: ΔGEX only when a prior snapshot is supplied', () => {
  const noPrev = computeShadow(fullInputs());
  assert.equal(noPrev.regime.deltaGex.available, false);
  const withPrev = computeShadow({ ...fullInputs(), prevSnapshot: { net_gex: 0.6e9 } });
  assert.equal(withPrev.regime.deltaGex.available, true);
  assert.ok(withPrev.regime.deltaGex.pct > 0);      // 1.2e9 vs 0.6e9 → +100%
  assert.equal(withPrev.regime.deltaGex.label, 'strong');
});
