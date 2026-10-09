// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeRvol, MarketContext, IvSkewTracker, EarningsCalendar, eventFlags, crossSectionalRank } from '../engine/context.js';
import { BaselineStore } from '../store/normalize.js';

const intraday = (vols) => ({ available: true, rawBars: vols.map((v, i) => ({ t: i, price: 100, volume: v })) });

test('RVOL needs real history and never fakes 1.0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-'));
  const b = new BaselineStore(dir);
  const thin = await computeRvol({ baselines: b, ticker: 'X', intraday: intraday([100, 100]), at: '2026-08-24T14:00:00Z' });
  assert.equal(thin.available, false);
  assert.equal(thin.rvol, null);
  assert.equal(thin.reason, 'insufficient_history');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('RVOL computes vs the same-time-of-day baseline once history exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv2-'));
  const b = new BaselineStore(dir);
  for (let i = 1; i <= 12; i++) await b.record('X', 'sessionVolume', 1000, `2026-08-${String(i).padStart(2, '0')}T14:00:00.000Z`);
  const r = await computeRvol({ baselines: b, ticker: 'X', intraday: intraday([1000, 1000]), at: '2026-08-20T14:00:00.000Z', record: false });
  assert.equal(r.available, true);
  assert.equal(r.rvol, 2);                       // 2000 session vs 1000 mean
  assert.equal(r.observations, 12);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('RVOL reports missing volume rather than assuming zero', async () => {
  const r = await computeRvol({ baselines: new BaselineStore('/tmp/none'), ticker: 'X', intraday: { available: false }, at: '2026-08-24T14:00:00Z' });
  assert.equal(r.available, false);
  assert.equal(r.reason, 'no_intraday_volume');
});

test('MarketContext derives SPY/QQQ trend and caches the fetch', async () => {
  let calls = 0;
  const provider = { getIntraday: async (sym) => { calls++; return { available: true, vwap: 100, last: sym === 'SPY' ? 101 : 99 }; } };
  const m = new MarketContext(provider);
  const a = await m.get();
  assert.equal(a.spyTrend, 'up');
  assert.equal(a.qqqTrend, 'down');
  await m.get();
  assert.equal(calls, 2);                        // cached: still only the first pair of calls
});

test('MarketContext degrades gracefully when the provider fails', async () => {
  const m = new MarketContext({ getIntraday: async () => { throw new Error('rate limit'); } });
  const r = await m.get();
  assert.equal(r.available, false);
  assert.equal(r.spyTrend, null);
});

test('IV skew requires a prior snapshot and then reports CHANGES', () => {
  const t = new IvSkewTracker();
  const cs = [{ type: 'call', strike: 100, iv: 0.30 }, { type: 'put', strike: 100, iv: 0.32 }, { type: 'put', strike: 90, iv: 0.40 }, { type: 'call', strike: 110, iv: 0.28 }];
  assert.equal(t.update('X', cs, 100).available, false);
  const next = cs.map((c) => ({ ...c, iv: c.iv + (c.type === 'call' ? 0.02 : -0.01) }));
  const u = t.update('X', next, 100);
  assert.equal(u.available, true);
  assert.ok(Math.abs(u.callIvChange - 0.02) < 1e-9);
  assert.ok(Math.abs(u.putIvChange + 0.01) < 1e-9);
});

test('IV skew refuses thin chains', () => {
  const t = new IvSkewTracker();
  assert.equal(t.update('X', [{ type: 'call', strike: 100, iv: 0.3 }], 100).reason, 'insufficient_iv_data');
});

test('EarningsCalendar returns days away and caches; null when unknown', async () => {
  let calls = 0;
  const soon = new Date(Date.now() + 86400000).toISOString();
  const e = new EarningsCalendar({ getEarnings: async () => { calls++; return { nextEarningsDate: soon }; } });
  assert.equal(await e.daysAway('X'), 1);
  await e.daysAway('X');
  assert.equal(calls, 1);                        // cached
  const none = new EarningsCalendar({ getEarnings: async () => ({}) });
  assert.equal(await none.daysAway('Y'), null);  // unknown => null, not 0
});

test('eventFlags detects monthly OPEX (third Friday) and the time bucket', () => {
  const opex = eventFlags(new Date('2026-08-21T14:00:00Z'));   // 3rd Friday
  assert.equal(opex.isOpex, true);
  const notOpex = eventFlags(new Date('2026-08-24T14:00:00Z'));
  assert.equal(notOpex.isOpex, false);
  assert.equal(notOpex.timeBucket, '09:45-10:30');
});

test('cross-sectional ranking produces ranks, deciles and top lists', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ ticker: 'T' + i, productionScore: i * 5, dir: i > 10 ? 'bull' : 'bear', signal: i > 10 ? 'CALL' : 'PUT' }));
  const r = crossSectionalRank(rows);
  assert.equal(r.available, true);
  assert.equal(r.universe, 20);
  const best = r.ranked.find((x) => x.ticker === 'T19');
  assert.equal(best.scoreRank, 1);
  assert.equal(best.topDecile, true);
  assert.equal(r.topBullish[0], 'T19');
  assert.ok(r.topDecileTickers.length >= 1);
});

test('cross-sectional ranking handles an empty universe', () => {
  const r = crossSectionalRank([{ ticker: 'A', productionScore: null }]);
  assert.equal(r.available, false);
});
