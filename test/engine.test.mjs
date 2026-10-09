// Run: node --test
// Seams under test = the engine's public functions. Expected values are hand-computed from
// an independent worked example (never recomputed the same way the code does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSnapshot, extractFeatures, scoreFeatures, buildSignal,
  evaluateOutcome, updateExcursion, emitDecision,
  bucketPerformance, featurePerformance, combinationPerformance, splitByTime, walkForward,
  DEFAULT_CONFIG,
} from '../public/engine.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const feat = (over) => COMPS.map((k) => ({ key: k, label: k, avail: 0, dir: 0, strength: 0, value: null, note: '', ...(over[k] || {}) }));
const COMPS = ['flow', 'outcome', 'liquidity', 'volume', 'price', 'smart'];
const now = 1_000_000_000_000;
const ctxOK = { spikes: [], traders: [], volMed: 5000, liqMed: 5000, snapshotTs: now };

// ---------------- scoring (isolated, hand-computed) ----------------
test('score: single directional feature → net=1, score=weight×100', () => {
  const r = scoreFeatures({ features: feat({ flow: { avail: 1, dir: 1, strength: 1 } }), asOf: now });
  near(r.net, 1); near(r.coverage, 0.28); assert.equal(r.score, 28); assert.equal(r.dir, 'bull'); assert.equal(r.confidence, 28);
});

test('score: confirmation feature (volume, dir 0) raises coverage but NOT net', () => {
  const base = scoreFeatures({ features: feat({ flow: { avail: 1, dir: 1, strength: 1 }, price: { avail: 1, dir: 1, strength: 0.5 } }), asOf: now });
  const withVol = scoreFeatures({ features: feat({ flow: { avail: 1, dir: 1, strength: 1 }, price: { avail: 1, dir: 1, strength: 0.5 }, volume: { avail: 1, dir: 0, strength: 1 } }), asOf: now });
  near(base.net, 0.38 / 0.48); near(withVol.net, 0.38 / 0.48);         // net identical
  assert.ok(withVol.coverage > base.coverage);                          // coverage up
  assert.equal(base.score, 38); assert.equal(withVol.score, 51);        // 38 → 51 via coverage only
});

test('score: conflicting features net toward the heavier side', () => {
  const r = scoreFeatures({ features: feat({ flow: { avail: 1, dir: 1, strength: 1 }, outcome: { avail: 1, dir: -1, strength: 1 } }), asOf: now });
  near(r.net, 0.12 / 0.44); assert.equal(r.score, 12); assert.equal(r.dir, 'bull');
});

test('score: tilt inside epsilon band → neutral', () => {
  const r = scoreFeatures({ features: feat({ flow: { avail: 1, dir: 1, strength: 0.5 }, outcome: { avail: 1, dir: -1, strength: 0.7 } }), asOf: now });
  near(r.net, 0.028 / 0.44); assert.equal(r.dir, 'neutral');           // 0.0636 < 0.08
});

test('score: no directional data → neutral, score 0', () => {
  const r = scoreFeatures({ features: feat({ volume: { avail: 1, dir: 0, strength: 1 } }), asOf: now });
  assert.equal(r.dir, 'neutral'); assert.equal(r.score, 0); near(r.coverage, 0.16);
});

// ---------------- feature extraction (snapshot-only) ----------------
const market = {
  slug: 'm1', title: 'M', status: 'open', tags: ['X'], volume: 10000, liquidity: 5000, endDate: '2030-01-01',
  outcomes: [{ tokenId: 'm1__YES', name: 'YES', price: 0.6, volume: 6000 }, { tokenId: 'm1__NO', name: 'NO', price: 0.4, volume: 4000 }],
};
const deep = { series: [{ t: 1, price: 0.50 }, { t: 2, price: 0.52 }, { t: 3, price: 0.54 }, { t: 4, price: 0.56 }, { t: 5, price: 0.58 }, { t: 6, price: 0.60 }, { t: 7, price: 0.60 }], ob: { bidDepth: 6500, askDepth: 3500, imbalance: 0.3, mid: 0.6 } };
const ctx = { ...ctxOK, spikes: [{ slug: 'm1', tokenId: 'm1__YES', direction: 1, magnitude: 3.0 }] };

test('extract: each feature matches an independent hand calc', () => {
  const f = extractFeatures(market, deep, ctx).features;
  const g = (k) => f.find((x) => x.key === k);
  near(g('flow').strength, (3 - 1.5) / 3); assert.equal(g('flow').dir, 1);        // 0.5
  near(g('outcome').value, 0.2); near(g('outcome').strength, 0.4); assert.equal(g('outcome').dir, 1);
  assert.equal(g('liquidity').dir, 1); near(g('liquidity').strength, 0.6);        // 0.3/0.5
  near(g('price').value, 0.10); assert.equal(g('price').strength, 1); assert.equal(g('price').dir, 1); // clamped
  assert.equal(g('volume').dir, 0); near(g('volume').strength, (2 - 1) / 3);      // rel 2.0, confirmation
  assert.equal(g('smart').avail, 0);
});

test('extract: spike on the NO leg flips flow bearish', () => {
  const c = { ...ctxOK, spikes: [{ slug: 'm1', tokenId: 'm1__NO', direction: 1, magnitude: 3 }] };
  assert.equal(extractFeatures(market, deep, c).features.find((x) => x.key === 'flow').dir, -1);
});

test('extract: bare liquidity (no orderbook) is confirmation-only (dir 0)', () => {
  const f = extractFeatures(market, { series: deep.series, ob: null }, ctx).features.find((x) => x.key === 'liquidity');
  assert.equal(f.avail, 1); assert.equal(f.dir, 0);
});

// ---------------- LEAKAGE GUARD ----------------
test('leakage: future fields on the snapshot cannot change features', () => {
  const clean = JSON.stringify(extractFeatures(market, deep, ctx).features);
  const pMarket = JSON.parse(JSON.stringify(market)); pMarket.__futurePrice = 0.99; pMarket.futureLabel = 'win'; pMarket.outcomes[0].__future = 0.99;
  const pDeep = JSON.parse(JSON.stringify(deep)); pDeep.__futureSeries = [{ t: 99, price: 0.99 }]; pDeep.outcomeLabel = 1;
  const pCtx = { ...ctx, __futureFlow: 999, label: 'win' };
  assert.equal(JSON.stringify(extractFeatures(pMarket, pDeep, pCtx).features), clean);
});

test('leakage: a FeatureVector carries no outcome/label fields', () => {
  for (const f of extractFeatures(market, deep, ctx).features)
    for (const k of ['win', 'favPts', 'deltaPct', 'outcome5m', 'mfe', 'mae', 'futurePrice']) assert.equal(k in f, false);
});

// ---------------- validation / data quality ----------------
test('quality: complete fresh snapshot → ok, 100', () => {
  const q = validateSnapshot(market, deep, ctxOK, now);
  assert.equal(q.level, 'ok'); assert.equal(q.score, 100);
});
test('quality: missing slug → reject', () => assert.equal(validateSnapshot({ ...market, slug: '' }, deep, ctxOK, now).level, 'reject'));
test('quality: impossible price (>1) → reject', () => assert.equal(validateSnapshot({ ...market, outcomes: [{ price: 1.2, volume: 1 }] }, deep, ctxOK, now).level, 'reject'));
test('quality: no liquidity/depth → low', () => {
  const q = validateSnapshot({ ...market, liquidity: null }, { series: deep.series, ob: null }, ctxOK, now);
  assert.equal(q.level, 'low'); assert.ok(q.reasons.includes('no liquidity/depth'));
});
test('quality: stale snapshot → low', () => {
  const q = validateSnapshot(market, deep, { ...ctxOK, snapshotTs: now - 5 * 60000 }, now);
  assert.equal(q.level, 'low'); assert.ok(q.reasons.includes('stale snapshot'));
});

// ---------------- buildSignal ----------------
test('buildSignal: bullish snapshot → non-null bullish signal, entry = YES price', () => {
  const { signal, quality } = buildSignal(market, deep, ctx, now);
  assert.equal(quality.level, 'ok'); assert.equal(signal.dir, 'bull');
  assert.equal(signal.entryPrice, 0.6); assert.equal(signal.leadTokenId, 'm1__YES');
  assert.ok(signal.score > 0 && signal.score <= 100); assert.equal(signal.id, 'm1:bull');
});
test('buildSignal: rejected snapshot → null signal', () => {
  const { signal } = buildSignal({ ...market, slug: '' }, deep, ctx, now);
  assert.equal(signal, null);
});

// ---------------- outcomes / excursion (labels) ----------------
test('outcome: bull win vs bear loss on the same up-move', () => {
  const up = evaluateOutcome(0.50, 0.55, 'bull'); near(up.favPts, 0.05); near(up.deltaPct, 10); assert.equal(up.win, true);
  const dn = evaluateOutcome(0.50, 0.55, 'bear'); near(dn.favPts, -0.05); assert.equal(dn.win, false);
});
test('outcome: non-numeric price → not done', () => assert.equal(evaluateOutcome(0.5, NaN, 'bull').done, false));
test('excursion: tracks max favorable / adverse', () => {
  let e = updateExcursion(0, 0, 0.5, 0.53, 'bull'); near(e.mfe, 0.03); near(e.mae, 0);
  e = updateExcursion(e.mfe, e.mae, 0.5, 0.48, 'bull'); near(e.mfe, 0.03); near(e.mae, -0.02);
});

// ---------------- dedup / cooldown ----------------
test('emitDecision: create / update / cooldown / flip-margin / flip', () => {
  const cfg = DEFAULT_CONFIG;
  assert.equal(emitDecision(null, { dir: 'bull', score: 80 }, cfg, now).action, 'create');
  assert.equal(emitDecision({ dir: 'bull', score: 70, ts_created: now - 10000 }, { dir: 'bull', score: 82 }, cfg, now).action, 'update');
  assert.equal(emitDecision({ dir: 'bull', score: 70, ts_created: now - 10000 }, { dir: 'bear', score: 90 }, cfg, now).action, 'suppress'); // cooldown
  assert.equal(emitDecision({ dir: 'bull', score: 70, ts_created: now - 120000 }, { dir: 'bear', score: 74 }, cfg, now).action, 'suppress'); // < +8 margin
  assert.equal(emitDecision({ dir: 'bull', score: 70, ts_created: now - 120000 }, { dir: 'bear', score: 85 }, cfg, now).action, 'flip');
});

// ---------------- research aggregation ----------------
const H = [30, 60];
const rows = [
  { ts: 1, score: 85, dir: 'bull', entryPrice: 0.5, mfe: 0.04, mae: -0.01, comps: [{ key: 'flow', avail: 1, dir: 1, strength: 0.9 }, { key: 'price', avail: 1, dir: 1, strength: 0.5 }, { key: 'volume', avail: 1, dir: 0, strength: 0.8 }], evals: { 30: { done: true, favPts: 0.03, win: true }, 60: { done: true, favPts: 0.02, win: true } } },
  { ts: 2, score: 72, dir: 'bull', entryPrice: 0.5, mfe: 0.02, mae: 0, comps: [{ key: 'flow', avail: 1, dir: 1, strength: 0.5 }], evals: { 30: { done: true, favPts: 0.01, win: true } } },
  { ts: 3, score: 55, dir: 'bear', entryPrice: 0.5, mfe: 0.01, mae: -0.03, comps: [{ key: 'flow', avail: 1, dir: -1, strength: 0.9 }], evals: {} },
  { ts: 4, score: 88, dir: 'bull', entryPrice: 0.5, mfe: 0.05, mae: -0.02, comps: [{ key: 'flow', avail: 1, dir: 1, strength: 0.9 }, { key: 'price', avail: 1, dir: 1, strength: 0.6 }], evals: { 30: { done: true, favPts: -0.02, win: false }, 60: { done: true, favPts: 0.04, win: true } } },
];

test('bucketPerformance: counts + win rate per bucket (hand-checked)', () => {
  const b = bucketPerformance(rows, { horizons: H });
  const by = (lo) => b.find((x) => x.lo === lo);
  assert.equal(by(80).n, 2); assert.equal(by(80).byHorizon[30].n, 2); near(by(80).byHorizon[30].winRate, 0.5); near(by(80).byHorizon[30].avgFav, 0.005);
  assert.equal(by(70).n, 1); near(by(70).byHorizon[30].winRate, 1);
  assert.equal(by(50).n, 1); assert.equal(by(50).byHorizon[30].n, 0); assert.equal(by(50).byHorizon[30].winRate, null); // sample size honesty
});

test('featurePerformance: flow fires on aligned rows only, win rate hand-checked', () => {
  const f = featurePerformance(rows, { horizons: H });
  const flow = f.perFeature.find((x) => x.key === 'flow');
  assert.equal(flow.fired, 4);                 // all four rows have flow aligned with their own dir & strong
  assert.equal(flow.byHorizon[30].n, 3);       // r1,r2,r4 evaluated at 30m (r3 not done)
  near(flow.byHorizon[30].winRate, 2 / 3);     // r1,r2 win, r4 loss
  const vol = f.perFeature.find((x) => x.key === 'volume');
  assert.equal(vol.fired, 1);                  // confirmation: presence-based, only r1
});

test('combinationPerformance: flow+price only where BOTH fired', () => {
  const c = combinationPerformance(rows, [['flow', 'price']], { horizons: H });
  assert.equal(c[0].n, 2);                      // r1 and r4
  assert.equal(c[0].byHorizon[60].n, 2); near(c[0].byHorizon[60].winRate, 1);
});

test('splitByTime: later rows are the out-of-sample set', () => {
  const s = splitByTime(rows, 0.5);
  assert.equal(s.train.length, 2); assert.equal(s.test.length, 2);
  assert.deepEqual(s.train.map((r) => r.ts), [1, 2]); assert.deepEqual(s.test.map((r) => r.ts), [3, 4]);
});

test('walkForward: sequential folds validate a metric over time', () => {
  const w = walkForward(rows, 1, 30);
  assert.equal(w.length, 1); assert.equal(w[0].trainN, 2); assert.equal(w[0].test.n <= 2, true);
});
