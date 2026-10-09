// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaselineStore, zScore, timeBucket, ewma, MIN_HISTORY } from '../store/normalize.js';
import { signedFlow, flowAcceleration, gammaRegime, priceConfirmation, rvolMultiplier, marketRegime, ivSkewChange, eventGates, GAMMA_DEADBAND_ATR } from '../engine/features.js';
import { step, targetState, isActionable, DEFAULT_CONFIG } from '../engine/state.js';
import { scoreV2 } from '../engine/v2.js';

// ---------------------------------------------------------------- Phase 2
test('zScore requires minimum history and never fabricates', () => {
  assert.equal(zScore(5, [1, 2, 3]).available, false);
  assert.equal(zScore(5, [1, 2, 3]).z, null);
  assert.equal(zScore(5, [1, 2, 3]).reason, 'insufficient_history');
  const h = Array.from({ length: MIN_HISTORY }, (_, i) => i);
  const r = zScore(20, h);
  assert.ok(r.available && r.z > 0);
  assert.equal(r.percentile, 100);
});

test('zScore flags zero variance instead of dividing by zero', () => {
  const flat = new Array(15).fill(7);
  const r = zScore(7, flat);
  assert.equal(r.z, null);
  assert.equal(r.reason, 'zero_variance');
});

test('INTEGRITY: normalization is strictly backward-looking (no future leakage)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-'));
  const s = new BaselineStore(dir);
  const day = (n) => `2026-08-${String(n).padStart(2, '0')}T14:00:00.000Z`;   // same clock bucket
  for (let i = 1; i <= 12; i++) await s.record('NVDA', 'flow', 100, day(i));
  // a huge value recorded LATER must not affect an EARLIER normalization
  await s.record('NVDA', 'flow', 999999, day(20));
  const early = s.normalize('NVDA', 'flow', 150, day(13));
  assert.equal(early.n, 12);                       // only the 12 prior observations
  assert.ok(!s.history('NVDA', timeBucket(day(13)), 'flow', day(13)).includes(999999));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('baselines are keyed per ticker AND time-of-day bucket', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl2-'));
  const s = new BaselineStore(dir);
  for (let i = 1; i <= 12; i++) await s.record('AAPL', 'flow', 10, `2026-08-${String(i).padStart(2, '0')}T13:35:00.000Z`); // 09:35 ET
  const sameBucket = s.normalize('AAPL', 'flow', 10, '2026-08-20T13:35:00.000Z');
  const otherBucket = s.normalize('AAPL', 'flow', 10, '2026-08-20T17:00:00.000Z');                                        // 13:00 ET
  assert.equal(sameBucket.n, 12);
  assert.equal(otherBucket.n, 0);                  // different clock bucket => own baseline
  assert.equal(otherBucket.available, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ewma smooths and tolerates gaps', () => {
  assert.equal(ewma(null, 10), 10);
  assert.equal(ewma(10, 20, 0.5), 15);
  assert.equal(ewma(10, null), 10);
});

// ---------------------------------------------------------------- Phase 2 flow
test('signed flow: ask-side minus bid-side, delta-weighted', () => {
  const f = signedFlow([
    { side: 'call', premium: 100000, askPremium: 100000, bidPremium: 0, delta: 0.5, isOpening: true },
    { side: 'put', premium: 50000, askPremium: 0, bidPremium: 50000, delta: -0.5 },
  ]);
  assert.equal(f.available, true);
  assert.equal(f.callAskPremium, 100000);
  assert.equal(f.putBidPremium, 50000);
  assert.equal(f.signedPremium, 150000);           // (100000-0) - (0-50000)
  assert.ok(f.deltaWeightedSignedFlow > 0);
  assert.equal(f.openingTrades, 1);
});

test('far-OTM lottery tickets cannot dominate delta-weighted flow', () => {
  const real = { side: 'call', premium: 100000, askPremium: 100000, bidPremium: 0, delta: 0.6 };
  const lotto = { side: 'call', premium: 5000000, askPremium: 5000000, bidPremium: 0, delta: 0.01 };
  const withLotto = signedFlow([real, lotto]).deltaWeightedSignedFlow;
  const lottoOnly = signedFlow([lotto]).deltaWeightedSignedFlow;
  assert.ok(lottoOnly < withLotto);                 // 5M premium at delta .01 < 100k at delta .6
  assert.equal(signedFlow([real]).deltaWeightedSignedFlow, 60000);
  assert.equal(lottoOnly, 50000);
});

test('signed flow flags unclassifiable trades instead of assuming a side', () => {
  const f = signedFlow([{ side: 'call', premium: 100000 }]);   // no ask/bid, no direction
  assert.equal(f.available, false);
  assert.equal(f.reason, 'no_classifiable_trades');
  assert.equal(f.sideUnknown, 1);
});

test('flow acceleration needs two polls', () => {
  assert.equal(flowAcceleration(100, null).available, false);
  const a = flowAcceleration(150, 100);
  assert.equal(a.delta, 50); assert.equal(a.direction, 'increasing');
});

// ---------------------------------------------------------------- Phase 3 gamma
test('gamma regime is a GATE with a dead-band, not a direction', () => {
  const neg = gammaRegime({ spot: 100, gammaFlip: 110, atr: 2 });   // -5 ATR below flip
  assert.equal(neg.regime, 'negative');
  assert.equal(neg.mode, 'trend_following');
  assert.ok(neg.momentumMultiplier > 1);

  const pos = gammaRegime({ spot: 120, gammaFlip: 110, atr: 2 });
  assert.equal(pos.regime, 'positive');
  assert.equal(pos.mode, 'mean_reversion');
  assert.ok(pos.momentumMultiplier < 1);

  // neither regime encodes bull/bear
  assert.equal(neg.direction, undefined);
  assert.equal(pos.direction, undefined);
});

test('gamma dead-band holds the previous regime near the flip (anti-whipsaw)', () => {
  const inBand = gammaRegime({ spot: 110.2, gammaFlip: 110, atr: 4, previousRegime: 'negative' });
  assert.ok(Math.abs(inBand.distanceAtr) < GAMMA_DEADBAND_ATR);
  assert.equal(inBand.inDeadband, true);
  assert.equal(inBand.regime, 'negative');          // held, not flipped
  assert.equal(inBand.source, 'deadband_hold');
});

test('gamma unavailable reports so rather than defaulting to a regime', () => {
  const g = gammaRegime({});
  assert.equal(g.available, false);
  assert.equal(g.regime, null);
});

// ---------------------------------------------------------------- Phase 4
test('price confirmation wants price above a RISING vwap for bulls', () => {
  const good = priceConfirmation({ price: 102, vwap: 100, vwapSlope: 0.5, atr: 2 });
  assert.equal(good.bullConfirmed, true);
  assert.equal(good.vwapDistanceAtr, 1);
  const bad = priceConfirmation({ price: 98, vwap: 100, vwapSlope: -0.5, atr: 2 });
  assert.equal(bad.bullConfirmed, false);
  assert.equal(bad.bearConfirmed, true);
});

test('RVOL is a multiplier, not additive points', () => {
  assert.equal(rvolMultiplier(2.5).multiplier, 1.15);
  assert.equal(rvolMultiplier(1.0).multiplier, 1.0);
  assert.equal(rvolMultiplier(0.5).multiplier, 0.85);
  assert.equal(rvolMultiplier(null).multiplier, 1.0);
  assert.equal(rvolMultiplier(null).available, false);
});

test('market regime de-weights signals fighting the tape', () => {
  const m = marketRegime({ spyTrend: 'down', qqqTrend: 'down' });
  assert.equal(m.regime, 'bearish');
  assert.ok(m.multiplierFor('bull') < 1);
  assert.ok(m.multiplierFor('bear') > 1);
});

test('IV skew uses CHANGE and never generates direction alone', () => {
  const iv = ivSkewChange({ callIvChange: 0.03, putIvChange: -0.01 });
  assert.equal(iv.tilt, 'bullish');
  assert.match(iv.note, /never generates direction/i);
  assert.equal(ivSkewChange({}).available, false);
});

test('earnings within 2 days blocks the signal', () => {
  const g = eventGates({ earningsDaysAway: 1 });
  assert.equal(g.blocked, true);
  assert.ok(g.gates.includes('EARNINGS_RISK'));
  assert.equal(eventGates({ earningsDaysAway: 9 }).blocked, false);
  assert.equal(eventGates({ timeBucket: 'premarket' }).blocked, true);
});

// ---------------------------------------------------------------- Phase 5
test('state machine requires N consecutive confirmations before changing', () => {
  let s = null;
  for (let i = 0; i < DEFAULT_CONFIG.confirmPolls - 1; i++) {
    s = step(s, { score: 85, dir: 'bull' });
    assert.equal(s.state, 'NEUTRAL');                  // still confirming
    assert.match(s.reason, /confirming/);
  }
  s = step(s, { score: 85, dir: 'bull' });
  assert.equal(s.state, 'STRONG_BULL');
  assert.equal(s.changed, true);
});

test('one noisy poll cannot flip the state', () => {
  let s = null;
  for (let i = 0; i < 5; i++) s = step(s, { score: 85, dir: 'bull' });
  assert.equal(s.state, 'STRONG_BULL');
  s = step(s, { score: 90, dir: 'bear' });             // single opposing poll
  assert.equal(s.state, 'STRONG_BULL');                // unchanged
  assert.equal(s.changed, false);
});

test('side flips need the flip margin and then respect cooldown', () => {
  let s = null;
  for (let i = 0; i < 4; i++) s = step(s, { score: 85, dir: 'bull' });
  assert.equal(s.state, 'STRONG_BULL');
  // below signalThreshold + flipMargin => refused
  for (let i = 0; i < 4; i++) s = step(s, { score: 70, dir: 'bear' });
  assert.equal(s.reason, 'flip_margin_not_met');
  assert.ok(s.state.includes('BULL'));
  // clears the margin => flips after confirmations
  for (let i = 0; i < 4; i++) s = step(s, { score: 90, dir: 'bear' });
  assert.ok(s.state.includes('BEAR'));
  assert.ok(s.cooldown > 0);
});

test('targetState maps score bands to states; only real calls are actionable', () => {
  assert.equal(targetState(85, 'bull'), 'STRONG_BULL');
  assert.equal(targetState(70, 'bull'), 'BULL');
  assert.equal(targetState(58, 'bull'), 'WATCH_BULL');
  assert.equal(targetState(40, 'bull'), 'NEUTRAL');
  assert.equal(targetState(85, 'bear'), 'STRONG_BEAR');
  assert.equal(isActionable('WATCH_BULL'), false);
  assert.equal(isActionable('BULL'), true);
});

// ---------------------------------------------------------------- v2 scorer
test('v2 refuses to score without primary flow evidence', () => {
  const r = scoreV2({ ticker: 'X', trades: [], spot: 100 });
  assert.equal(r.available, false);
  assert.equal(r.score, null);
  assert.equal(r.reason, 'no_primary_flow_evidence');
});

test('v2: gamma regime gates rather than directs; conflicting price lowers score', () => {
  const base = {
    ticker: 'X', trades: [{ side: 'call', premium: 900000, askPremium: 880000, bidPremium: 20000, delta: 0.55, isOpening: true }],
    spot: 210, atr: 4, gex: -8e8, gammaFlip: 214, rvol: 1.9, market: { spyTrend: 'up', qqqTrend: 'up' }, events: { timeBucket: '09:45-10:30' },
  };
  const confirmed = scoreV2({ ...base, vwap: 208, vwapSlope: 0.3 });
  const conflicted = scoreV2({ ...base, vwap: 214, vwapSlope: -0.3 });
  assert.ok(confirmed.score > conflicted.score);
  assert.equal(confirmed.dir, 'bull');
  assert.equal(conflicted.dir, 'bull');               // flow still sets direction
  assert.ok(confirmed.reasons.some((r) => r.code === 'NEGATIVE_GAMMA_TREND_REGIME'));
  assert.ok(conflicted.reasons.some((r) => r.code === 'VWAP_CONFLICT'));
});

test('v2: combined multiplier is capped so confirmations cannot overpower flow', () => {
  const r = scoreV2({
    ticker: 'X', trades: [{ side: 'call', premium: 900000, askPremium: 880000, bidPremium: 20000, delta: 0.55 }],
    spot: 210, vwap: 208, vwapSlope: 1, atr: 4, gex: -8e8, gammaFlip: 214, rvol: 3,
    market: { spyTrend: 'up', qqqTrend: 'up' }, events: { timeBucket: '09:45-10:30' },
  });
  assert.ok(r.multipliers.combined <= 1.25);
  assert.equal(r.multipliers.capped, true);
});

test('v2: earnings gate zeroes the score and records the reason', () => {
  const r = scoreV2({
    ticker: 'X', trades: [{ side: 'call', premium: 900000, askPremium: 880000, bidPremium: 20000, delta: 0.55 }],
    spot: 210, vwap: 208, atr: 4, events: { earningsDaysAway: 1, timeBucket: '09:45-10:30' },
  });
  assert.equal(r.gated, true);
  assert.equal(r.score, 0);
  assert.ok(r.reasons.some((x) => x.code === 'EARNINGS_RISK'));
});

test('v2: missing inputs lower coverage and are flagged, never zero-filled', () => {
  const r = scoreV2({ ticker: 'X', trades: [{ side: 'call', premium: 500000, askPremium: 480000, bidPremium: 20000, delta: 0.5 }], spot: 100 });
  assert.ok(r.coverage < 100);
  assert.ok(r.quality.flags.includes('gamma_unavailable'));
  assert.ok(r.quality.flags.includes('rvol_unavailable'));
  assert.equal(r.components.gamma, null);
});

test('v2: per-ticker z-score is preferred over raw imbalance when history exists', () => {
  const trades = [{ side: 'call', premium: 500000, askPremium: 480000, bidPremium: 20000, delta: 0.5 }];
  const raw = scoreV2({ ticker: 'X', trades, spot: 100, vwap: 99, atr: 2 });
  const normed = scoreV2({ ticker: 'X', trades, spot: 100, vwap: 99, atr: 2, normalized: { deltaWeightedSignedFlow: { z: 2.5, available: true } } });
  assert.ok(raw.quality.flags.includes('no_baseline_history'));
  assert.ok(!normed.quality.flags.includes('no_baseline_history'));
  assert.ok(normed.reasons.some((r) => r.code === 'DELTA_FLOW_EXTREME'));
});

// ---------------------------------------------------------------- Phase 6 quality
import { validateContract, dedupeTrades, qualityReport } from '../engine/quality.js';

test('bad data is flagged and nulled, never coerced to zero', () => {
  const crossed = validateContract({ bid: 5, ask: 4, iv: 0.3, gamma: 0.01 });
  assert.ok(crossed.flags.includes('crossed_quote'));
  assert.equal(crossed.contract.bid, null);              // nulled, not 0
  const zg = validateContract({ bid: 1, ask: 1.1, iv: 0, gamma: 0 });
  assert.ok(zg.flags.includes('zero_gamma'));
  assert.ok(zg.flags.includes('invalid_iv'));
  assert.equal(zg.contract.gamma, null);
  assert.equal(zg.contract.iv, null);
  assert.ok(validateContract({ bid: 1, ask: 2, iv: 0.3 }).flags.includes('abnormal_spread'));
  assert.ok(validateContract({ bid: 1, ask: 1.01, iv: 0.3, quoteTime: Date.now() - 600000 }).flags.includes('stale_quote'));
});

test('duplicate and out-of-order trades are handled', () => {
  const d = dedupeTrades([{ id: 1, premium: 5 }, { id: 1, premium: 5 }, { id: 2, premium: 6 }]);
  assert.equal(d.trades.length, 2);
  assert.equal(d.dropped, 1);
  const o = dedupeTrades([{ id: 1, timestamp: '2026-08-24T14:05:00Z' }, { id: 2, timestamp: '2026-08-24T14:00:00Z' }]);
  assert.equal(o.outOfOrder, 1);
});

test('quality report aggregates flags and marks degradation', () => {
  const r = qualityReport({ flow: { available: false }, gamma: null, price: { available: true } });
  assert.ok(r.flags.includes('flow_unavailable'));
  assert.ok(r.flags.includes('gamma_missing'));
  assert.ok(r.score < 100);
});
