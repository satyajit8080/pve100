// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logSignal, SIGNAL_LOG_SCHEMA } from '../store/signal-log.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'siglog-'));
process.env.SIGNAL_LOG_DIR = DIR;
const readAll = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).flatMap((f) => fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));

// a representative production signal object (as buildOptionsSignal returns), with agg already
// carrying the PVE display override (gex = pve value); scoredAgg carries the chain-computed value.
const makeSig = (over = {}) => ({
  finalScore: 72, dir: 'bull', tier: 'Moderate', primary: 75, optionsScore: 80, stockScore: 40,
  predictionMarketScore: null, pveState: 'none', pveFactor: 1.0, dataQuality: 100, gexSource: 'pve',
  ivRank: 55, ivPercentile: 60, walls: { call: 200, put: 180 },
  agg: { gex: 1_536_000_000, gammaFlip: 190, maxPain: 195 },      // (B) PVE-overridden display values
  features: [
    { key: 'cpVolume', avail: 1, dir: 1, strength: 0.6, value: 1.8 },
    { key: 'gexContext', avail: 1, dir: 0, strength: 0.4, value: 4_920_000 },
    { key: 'oiChange', avail: 0, dir: 0, strength: 0, value: null },
  ],
  optionsEngineVersion: 'opt-1.0.0', ...over,
});
const scoredAgg = { gex: 4_920_000, gammaFlip: 188, maxPain: 195, cpVolRatio: 1.8, cpOIRatio: 1.5, volOIRatio: 2.1, atmIV: 0.4, strikeConcentration: 0.12, avgSpread: 0.02, spot: 191.2 };
const underlying = { price: 191.2, prevClose: 188.0, volume: 5e6, available: true };
const providerNoFlow = { name: 'pve' }; // no getFlowDetailed → shadowOnly.flow stays null (honest)

test('separates A (scored) / B (displayed-not-scored) / C (shadow-only) with no ambiguous field', async () => {
  await logSignal({ provider: providerNoFlow, ticker: 'AAA', sig: makeSig(), scoredAgg, underlying, prevHadSnapshot: false, now: new Date('2026-08-24T14:03:00Z') });
  const [r] = readAll();
  assert.equal(r.schemaVersion, SIGNAL_LOG_SCHEMA);
  // (A) scored: chain-computed GEX is what the score used
  assert.equal(r.scored.gexChainComputed, 4_920_000);
  assert.equal(r.scored.oiChangeAvailable, false);           // cold start recorded honestly
  assert.ok(r.scored.components.find((c) => c.key === 'cpVolume').scored === true);
  assert.deepEqual(r.scored.activeComponents, ['cpVolume']); // directional + aligned with bull
  // (B) displayed-not-scored: PVE override is a SEPARATE field, not merged with the scored value
  assert.equal(r.displayedNotScored.gexPveOverride, 1_536_000_000);
  assert.equal(r.displayedNotScored.gexSource, 'pve');
  assert.equal(r.displayedNotScored.ivRank, 55);
  assert.equal(r.displayedNotScored.maxPain, 195);
  assert.notEqual(r.scored.gexChainComputed, r.displayedNotScored.gexPveOverride); // the whole point
  // (C) shadow-only present + labelled, null when no flow provider
  assert.equal(r.shadowOnly.flow, null);
  assert.match(r.shadowOnly.note, /not used in production/i);
  // req 1: 1h explicitly unavailable; 1d/1w pending
  assert.equal(r.forward['1h'].status, 'unavailable');
  assert.match(r.forward['1h'].note, /intraday/i);
  assert.equal(r.forward['1d'].status, 'pending');
  assert.equal(r.entryPrice, 191.2);
});

test('dedupe: one record per ticker per 5-min bucket', async () => {
  const t = 'BBB';
  await logSignal({ provider: providerNoFlow, ticker: t, sig: makeSig(), scoredAgg, underlying, now: new Date('2026-08-24T15:01:00Z') });
  await logSignal({ provider: providerNoFlow, ticker: t, sig: makeSig({ finalScore: 99 }), scoredAgg, underlying, now: new Date('2026-08-24T15:04:59Z') }); // same 5-min bucket → dropped
  const same = readAll().filter((r) => r.ticker === t);
  assert.equal(same.length, 1);
  await logSignal({ provider: providerNoFlow, ticker: t, sig: makeSig(), scoredAgg, underlying, now: new Date('2026-08-24T15:06:00Z') }); // next bucket → kept
  assert.equal(readAll().filter((r) => r.ticker === t).length, 2);
});

test('skips neutral signals (req 3: dir != neutral only)', async () => {
  await logSignal({ provider: providerNoFlow, ticker: 'CCC', sig: makeSig({ dir: 'neutral' }), scoredAgg, underlying, now: new Date('2026-08-24T16:00:00Z') });
  assert.equal(readAll().filter((r) => r.ticker === 'CCC').length, 0);
});

test('fire-and-forget safety: never throws, even with garbage input (req 10)', async () => {
  await assert.doesNotReject(logSignal({ ticker: 'DDD', sig: null }));
  await assert.doesNotReject(logSignal({}));
  // shadow flow provider that throws must not break logging
  const badProvider = { name: 'pve', getFlowDetailed: async () => { throw new Error('boom'); } };
  await logSignal({ provider: badProvider, ticker: 'EEE', sig: makeSig(), scoredAgg, underlying, now: new Date('2026-08-24T17:00:00Z') });
  const [r] = readAll().filter((x) => x.ticker === 'EEE');
  assert.equal(r.shadowOnly.flow, null);                     // flow fetch failed → null, record still written
});

test('logs shadow sweep/flow when the provider supplies it (C bucket populated)', async () => {
  const flowProvider = { name: 'pve', getFlowDetailed: async () => ({ available: true, trades: [{ premium: 3e6, size: 1500, right: 'call', direction: 'buy', golden: true, dte: 25, otm_percent: 4, isOpening: true }] }) };
  await logSignal({ provider: flowProvider, ticker: 'FFF', sig: makeSig(), scoredAgg, underlying, now: new Date('2026-08-24T18:00:00Z') });
  const [r] = readAll().filter((x) => x.ticker === 'FFF');
  assert.equal(r.shadowOnly.flow.available, true);
  assert.ok(r.shadowOnly.flow.goldenCount >= 1);
  assert.equal(r.scored.activeComponents.includes('gexContext'), false); // gexContext is non-directional → not "active"
});

test('no secret leakage in records', () => {
  const blob = JSON.stringify(readAll());
  assert.ok(!/pve_live_|SECRET|Bearer|sk-or-/.test(blob));
});
