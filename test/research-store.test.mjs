// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshotRecord, appendSnapshot, readSnapshots, nearSpotGex, SNAPSHOT_FIELDS } from '../research/snapshot-store.js';
import { buildSignalRecord, appendSignal, readSignals, backfillLabels } from '../research/signals-store.js';
import { captureSnapshots } from '../research/capture-snapshot.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'research-'));

test('nearSpotGex sums per-strike netGex within ±5% of spot', () => {
  const byStrike = { strikes: [{ strike: 96, netGex: 1 }, { strike: 100, netGex: 2 }, { strike: 104, netGex: 3 }, { strike: 130, netGex: 99 }] };
  assert.equal(nearSpotGex(byStrike, 100), 6);   // 96,100,104 in-band; 130 excluded
  assert.equal(nearSpotGex(null, 100), null);
  assert.equal(nearSpotGex(byStrike, null), null);
});

test('buildSnapshotRecord: only whitelisted keys, computes distances, never fabricates, no secrets', () => {
  const rec = buildSnapshotRecord({
    ticker: 'aapl', ts: '2026-08-20T14:00:00Z',
    gex: { net_gex: 1.2e9, call_gex: 2e9, put_gex: -8e8, net_dex: 5e8, gamma_flip: 448, call_wall: 460, put_wall: 440 },
    byStrike: { strikes: [{ strike: 449, netGex: 3 }, { strike: 451, netGex: 4 }] },
    ivRank: { iv_rank: 62, iv_percentile: 71, current_iv: 0.4 },
    skew: { skew25: 0.03 }, termStructure: { slope3090: -0.02 },
    netPremium: { total_net_premium: 5e6, total_bullish_premium: 9e6, total_bearish_premium: 4e6 },
    underlying: { price: 450 }, darkpool: { dix: 44.5 }, marketTide: { net_premium: 1.1e9 },
  });
  for (const k of Object.keys(rec)) assert.ok(SNAPSHOT_FIELDS.includes(k), `unexpected key ${k}`);
  assert.equal(rec.ticker, 'AAPL');
  assert.ok(Math.abs(rec.flip_distance - (450 - 448) / 450) < 1e-9);   // (spot−flip)/spot > 0 → long-gamma side
  assert.ok(Math.abs(rec.call_wall_distance - (460 - 450) / 450) < 1e-9);
  assert.equal(rec.near_spot_gex, 7);
  assert.equal(rec.dix, 44.5); assert.equal(rec.market_net_premium, 1.1e9);
  // never fabricated when absent
  const empty = buildSnapshotRecord({ ticker: 'X', ts: '2026-08-20T00:00:00Z' });
  assert.equal(empty.net_gex, null); assert.equal(empty.flip_distance, null); assert.equal(empty.skew25, null);
  // no secret-looking values anywhere
  assert.ok(!/sk-or-|pve_live_|Bearer/.test(JSON.stringify(rec)));
});

test('snapshot append/read roundtrip into a dated file', async () => {
  const dir = tmp();
  const rec = buildSnapshotRecord({ ticker: 'MSFT', ts: '2026-08-20T13:00:00Z', gex: { net_gex: 1 } });
  const res = await appendSnapshot(dir, rec);
  assert.equal(res.ok, true);
  assert.ok(res.path.endsWith('snapshots-2026-08-20.jsonl'));
  const rows = await readSnapshots(dir, { date: '2026-08-20' });
  assert.equal(rows.length, 1); assert.equal(rows[0].ticker, 'MSFT');
  assert.deepEqual(await readSnapshots(dir, { date: '1999-01-01' }), []);  // missing file → []
  fs.rmSync(dir, { recursive: true, force: true });
});

test('signals: build + append + read + label backfill (MFE/MAE from OHLC)', async () => {
  const dir = tmp();
  const rec = buildSignalRecord({ ts: '2026-08-17T20:00:00Z', ticker: 'AAPL', features: { net_gex: 1.2e9, skew25: 0.03 }, score: 72, dir: 'bull', tier: 'Strong', horizonDays: 3 });
  assert.equal(rec.label, null); assert.equal(rec.score, 72);
  const w = await appendSignal(dir, rec); assert.equal(w.ok, true);
  const rows = await readSignals(dir, { date: '2026-08-17' }); assert.equal(rows.length, 1);
  const bars = [
    { date: '2026-08-17', high: 101, low: 98, close: 100 },  // entry
    { date: '2026-08-18', high: 105, low: 99, close: 104 },  // +5% high
    { date: '2026-08-19', high: 106, low: 103, close: 105 },
    { date: '2026-08-20', high: 105, low: 100, close: 102 },
  ];
  const labeled = backfillLabels(rows, { AAPL: { bars } });
  assert.equal(labeled[0].label.insufficient, false);
  assert.ok(labeled[0].label.mfe > 0.05);            // saw >5% favorable
  assert.equal(labeled[0].label.hitDirection, true); // bull, exit 102 > entry 100
  // input rows not mutated
  assert.equal(rows[0].label, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('captureSnapshots writes one row per ticker using an injected fake provider; bad ticker isolated', async () => {
  const dir = tmp();
  const okData = {
    getGex: async () => ({ available: true, net_gex: 1e9, gamma_flip: 448, call_wall: 460, put_wall: 440 }),
    getByStrikeGex: async () => ({ available: true, strikes: [{ strike: 449, netGex: 2 }] }),
    getIvRank: async () => ({ available: true, iv_rank: 60, iv_percentile: 70 }),
    getSkew: async () => ({ available: true, skew25: 0.02 }),
    getTermStructure: async () => ({ available: true, slope3090: -0.01 }),
    getNetPremium: async () => ({ available: true, total_net_premium: 5e6 }),
    getUnderlying: async () => ({ available: true, underlying: { price: 450 } }),
    getDarkpool: async () => ({ available: true, dix: 45 }),
    getMarketTide: async () => ({ available: true, net_premium: 1e9 }),
  };
  const provider = {
    ...okData,
    // AAPL ok; BADX throws inside getGex to prove isolation
    getGex: async (t) => { if (t === 'BADX') throw new Error('boom'); return okData.getGex(t); },
  };
  const now = () => new Date('2026-08-20T15:00:00Z');
  const r = await captureSnapshots({ provider, tickers: ['aapl', 'BADX'], dir, now });
  assert.equal(r.count, 2);                 // both rows written (BADX still appends with null gex)
  const rows = await readSnapshots(dir, { date: '2026-08-20' });
  assert.equal(rows.length, 2);
  const aapl = rows.find((x) => x.ticker === 'AAPL'); const bad = rows.find((x) => x.ticker === 'BADX');
  assert.equal(aapl.net_gex, 1e9); assert.equal(aapl.market_net_premium, 1e9); assert.equal(aapl.dix, 45);
  assert.equal(bad.net_gex, null);          // failed fetch → null, not fabricated
  assert.equal(bad.skew25, 0.02);           // other fields still captured
  fs.rmSync(dir, { recursive: true, force: true });
});
