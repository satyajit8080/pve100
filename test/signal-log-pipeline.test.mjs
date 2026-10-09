// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecord, tradingBarsAfter } from '../research/resolve-forward-returns.js';
import { attribute } from '../research/signal-log-report.js';
import { mulberry32 } from '../research/stats.js';

const rec = (over = {}) => ({
  id: over.id || 'X:1', firedAt: '2026-03-10T14:00:00Z', ticker: 'X', entryPrice: 100,
  composite: { finalScore: 70, dir: 'bull', tier: 'Moderate' },
  scored: { activeComponents: [] }, shadowOnly: { flow: null },
  forward: { '1h': { status: 'unavailable' }, '1d': { status: 'pending' }, '1w': { status: 'pending' } },
  resolved: false, ...over,
});

test('LEAKAGE GUARD: only bars strictly after the fire date are used', () => {
  const bars = [
    { date: '2026-03-10', close: 999 },  // fire-day bar — MUST be ignored
    { date: '2026-03-09', close: 888 },  // earlier — MUST be ignored
    { date: '2026-03-11', close: 105 },  // +1 trading day
    { date: '2026-03-12', close: 106 }, { date: '2026-03-13', close: 107 }, { date: '2026-03-16', close: 108 }, { date: '2026-03-17', close: 110 }, // +5th = 03-17
  ];
  const after = tradingBarsAfter(bars, '2026-03-10');
  assert.ok(after.every((b) => b.date > '2026-03-10'));      // strict
  assert.equal(after[0].date, '2026-03-11');                 // never the fire-day 999 bar
  const r = resolveRecord(rec(), bars);
  assert.equal(r.forward['1d'].barDate, '2026-03-11');
  assert.equal(r.forward['1d'].price, 105);
  assert.ok(Math.abs(r.forward['1d'].ret - 0.05) < 1e-9);    // (105-100)/100
  assert.equal(r.forward['1w'].barDate, '2026-03-17');       // 5th trading day after fire
  assert.ok(Math.abs(r.forward['1w'].ret - 0.10) < 1e-9);
  assert.equal(r.forward['1h'].status, 'unavailable');       // untouched
  assert.equal(r.resolved, true);
});

test('no fabrication: horizons with no future bar yet stay pending', () => {
  const bars = [{ date: '2026-03-11', close: 105 }];         // only +1 exists
  const r = resolveRecord(rec(), bars);
  assert.equal(r.forward['1d'].status, 'resolved');
  assert.equal(r.forward['1w'].status, 'pending');           // not enough bars → stays pending
  assert.equal(r.resolved, false);
});

// ---- attribution proves it separates a real component from noise, and gates thin samples ----
function syntheticResolved(n = 400, seed = 5) {
  const rng = mulberry32(seed); const out = [];
  for (let i = 0; i < n; i++) {
    const dir = rng() > 0.5 ? 'bull' : 'bear'; const s = dir === 'bull' ? 1 : -1;
    const plantedActive = rng() > 0.4;                        // "cpVolume" present ~60%
    const noiseActive = rng() > 0.5;                          // "liquidity" present ~50%, unpredictive
    // planted component: when active, forward return follows direction (predictive); else random
    const base = (rng() - 0.5) * 0.04;
    const ret1d = plantedActive ? s * (0.01 + rng() * 0.02) : base;
    const active = []; if (plantedActive) active.push('cpVolume'); if (noiseActive) active.push('liquidity');
    out.push({
      id: 'S:' + i, firedAt: '2026-03-10T14:00:00Z', ticker: 'S' + (i % 10), entryPrice: 100,
      composite: { finalScore: 70, dir, tier: 'Moderate' },
      scored: { activeComponents: active },
      shadowOnly: { flow: plantedActive ? { available: true, goldenCount: 1, sweepSampleSize: 3 } : { available: true, goldenCount: 0, sweepSampleSize: 0 } },
      forward: { '1h': { status: 'unavailable' }, '1d': { status: 'resolved', ret: ret1d }, '1w': { status: 'resolved', ret: ret1d * 1.5 } },
      resolved: true,
    });
  }
  return out;
}

test('attribution: planted component beats noise; thin samples gated as INSUFFICIENT DATA', () => {
  const a = attribute(syntheticResolved(400), { minSample: 30 });
  const planted = a.byComponent.cpVolume['1d'];
  const noise = a.byComponent.liquidity['1d'];
  assert.ok(planted.hitRate > noise.hitRate, `planted ${planted.hitRate} !> noise ${noise.hitRate}`);
  assert.ok(planted.hitRate > 0.6, 'planted component should show a real edge');
  assert.equal(planted.verdict, 'ok');
  // shadow sweep bucket should also separate (planted ⇒ sweep_present)
  assert.ok(a.shadowFlow.sweep_present['1d'].hitRate > a.shadowFlow.no_sweep['1d'].hitRate);
  assert.match(a.shadowFlow.note, /not used in production/i);
  // sample-size gating
  const thin = attribute(syntheticResolved(20), { minSample: 30 });
  assert.equal(thin.overall['1d'].verdict, 'INSUFFICIENT DATA');
});
