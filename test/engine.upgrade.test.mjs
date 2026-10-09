// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreTier, anomalyRatio, acceleration, persistence, regimeFromFlow, flowDiagnostics,
  buildSignal, captureSnapshot, replaySignal, FEATURE_DEFS, ENGINE_VERSION,
} from '../public/engine.js';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);

test('tiers: boundaries map correctly', () => {
  assert.equal(scoreTier(95), 'Exceptional'); assert.equal(scoreTier(90), 'Exceptional');
  assert.equal(scoreTier(89), 'Very Strong'); assert.equal(scoreTier(80), 'Very Strong');
  assert.equal(scoreTier(79), 'Strong'); assert.equal(scoreTier(70), 'Strong');
  assert.equal(scoreTier(69), 'Moderate'); assert.equal(scoreTier(60), 'Moderate');
  assert.equal(scoreTier(59), 'Weak'); assert.equal(scoreTier(0), 'Weak');
});

test('volume anomaly: ratio vs median baseline (hand-computed)', () => {
  assert.equal(anomalyRatio(300, [100, 100, 100]).score, 1);       // ratio 3 → clamp((3-1)/2)=1
  near(anomalyRatio(150, [100, 100, 100]).score, 0.25);            // ratio 1.5 → 0.25
  assert.equal(anomalyRatio(50, []).score, 0);                     // no baseline → 0
  assert.equal(anomalyRatio(50, [100, 100, 100]).score, 0);        // below median → clamped 0
});

test('flow acceleration: recent window vs prior window', () => {
  near(acceleration([10, 10, 10, 20, 20, 20]).accel, 1);           // 20 vs 10 → +1
  assert.equal(acceleration([10, 10]).accel, 0);                   // too few → 0
});

test('persistence: fraction + trailing streak above threshold', () => {
  const p = persistence([2, 2, 0, 2], 1.8);
  near(p.frac, 0.75); assert.equal(p.streak, 1);
});

test('regime: sentiment thresholds', () => {
  assert.equal(regimeFromFlow({ sentiment: 0.3 }).regime, 'risk-on');
  assert.equal(regimeFromFlow({ sentiment: -0.3 }).regime, 'risk-off');
  assert.equal(regimeFromFlow({ sentiment: 0 }).regime, 'neutral');
  assert.equal(regimeFromFlow({}).regime, 'unknown');
});

const now = 1_000_000_000_000;
const market = { slug: 'm1', title: 'AAPL market', tags: ['AAPL'], volume: 10000, liquidity: 5000, asset_type: 'US_EQUITY', ticker: 'AAPL', outcomes: [{ tokenId: 'm1__YES', price: 0.6, volume: 6000 }, { tokenId: 'm1__NO', price: 0.4, volume: 4000 }] };
const deep = { series: [{ t: 1, price: 0.50 }, { t: 2, price: 0.52 }, { t: 3, price: 0.54 }, { t: 4, price: 0.56 }, { t: 5, price: 0.58 }, { t: 6, price: 0.60 }, { t: 7, price: 0.60 }], ob: { bidDepth: 6500, askDepth: 3500, imbalance: 0.3, mid: 0.6 } };
const ctx = { spikes: [{ slug: 'm1', tokenId: 'm1__YES', direction: 1, magnitude: 4 }], traders: [], volMed: 5000, liqMed: 5000, snapshotTs: now, flow: { sentiment: 0.3 }, marketHist: { m1: { vols: [4000, 4500, 5000], spikeMags: [2, 2, 3] } } };

test('flowDiagnostics: anomaly/regime/persistence from history', () => {
  const d = flowDiagnostics(market, ctx);
  assert.equal(d.spikeMagnitude, 4);
  near(d.flowAnomaly, anomalyRatio(4, [2, 2, 3]).score);
  near(d.volAnomaly, anomalyRatio(10000, [4000, 4500, 5000]).score); // vol vs median 4500 → ratio 2.22

  assert.equal(d.regime, 'risk-on');
  near(d.persistence, persistence([2, 2, 3], 1.8).frac);
});

test('buildSignal: carries assetType, ticker, tier, proxies, diagnostics, version', () => {
  const { signal } = buildSignal(market, deep, ctx, now);
  assert.equal(signal.assetType, 'US_EQUITY'); assert.equal(signal.ticker, 'AAPL');
  assert.equal(signal.tier, scoreTier(signal.score));
  assert.equal(signal.engineVersion, ENGINE_VERSION);
  assert.equal(signal.dir, 'bull');
  // proxy labeling: outcome + liquidity are proxies; price/volume/flow/smart are not
  assert.ok(signal.proxies.includes('outcome')); assert.ok(signal.proxies.includes('liquidity'));
  assert.ok(!signal.proxies.includes('price')); assert.ok(!signal.proxies.includes('flow'));
  assert.equal(FEATURE_DEFS.outcome.proxy, true); assert.equal(FEATURE_DEFS.price.proxy, false);
});

test('forward-outcome separation: a built signal exposes no outcome/label fields', () => {
  const { signal } = buildSignal(market, deep, ctx, now);
  for (const k of ['win', 'favPts', 'deltaPct', 'mfe', 'mae']) assert.equal(k in signal, false);
});

test('replay determinism: snapshot reproduces the identical signal without PVE', () => {
  const { signal } = buildSignal(market, deep, ctx, now);
  const snap = captureSnapshot(market, deep, ctx, now, undefined, { version: 'clf-1.0.0' });
  const replayed = replaySignal(snap);
  const view = (s) => JSON.stringify({ score: s.score, dir: s.dir, net: s.net, coverage: s.coverage, tier: s.tier, comps: s.comps, proxies: s.proxies, diagnostics: s.diagnostics, ts: s.ts_created });
  assert.equal(view(replayed), view(signal));
  assert.equal(snap.engineVersion, ENGINE_VERSION);
});
