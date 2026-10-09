// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankIC, topDecilePrecision, calibration, baselineReport, toRows } from '../store/evaluation.js';
import { computeCheckpoint, reasonCodes } from '../store/journal.js';

test('rankIC: perfect monotone = 1, perfect inverse = -1, ties handled', () => {
  const up = [1, 2, 3, 4, 5].map((v) => ({ score: v, ret: v }));
  assert.equal(rankIC(up).ic, 1);
  const down = [1, 2, 3, 4, 5].map((v) => ({ score: v, ret: -v }));
  assert.equal(rankIC(down).ic, -1);
  const ties = [{ score: 1, ret: 1 }, { score: 1, ret: 2 }, { score: 2, ret: 3 }];
  assert.ok(Number.isFinite(rankIC(ties).ic));
});

test('rankIC gates low samples and flags suspiciously high IC', () => {
  assert.equal(rankIC([{ score: 1, ret: 1 }]).ic, null);
  const r = rankIC([1, 2, 3, 4, 5].map((v) => ({ score: v, ret: v })));
  assert.equal(r.gated, true);                                  // n < 30
  assert.match(r.note, /low sample/i);
  const many = Array.from({ length: 40 }, (_, i) => ({ score: i, ret: i }));
  assert.match(rankIC(many).note, /suspicious/i);               // IC 1.0 with n=40
});

test('topDecilePrecision compares against the base rate', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ score: i, ret: i >= 18 ? 1 : -1 }));
  const t = topDecilePrecision(rows);
  assert.equal(t.precision, 100);            // top 2 by score are the winners
  assert.equal(t.baseline, 10);
});

test('calibration buckets report hit rate per score band', () => {
  const rows = [
    { score: 72, ret: -1 }, { score: 75, ret: 1 },
    { score: 85, ret: 1 }, { score: 88, ret: 1 },
  ];
  const c = calibration(rows);
  const b70 = c.find((x) => x.range === '70-79'), b80 = c.find((x) => x.range === '80-89');
  assert.equal(b70.n, 2); assert.equal(b70.hitRate, 50);
  assert.equal(b80.n, 2); assert.equal(b80.hitRate, 100);
  assert.ok(c.every((x) => x.gated));         // all n < 30
});

test('ATR-normalized return and target/stop labels', () => {
  const bars = [{ t: 10, price: 101, high: 101, low: 100 }, { t: 20, price: 103, high: 103.5, low: 101 }];
  const r = computeCheckpoint({ entryStock: 100, bars, dir: 'bull', atr: 2, entryTs: 0 });   // ATR = 2% of price
  assert.equal(r.directionalReturnPct, 3);
  assert.equal(r.atrNormalizedReturn, 1.5);   // 3% / 2%
  assert.equal(r.targetReached, true);        // +3.5% high >= 1 ATR (2%)
  assert.equal(r.stopReached, false);
  assert.equal(r.timeToTargetMs, 20);
  assert.equal(r.outcome, 'TARGET');
});

test('ATR labels are null (not zero) when ATR is unavailable', () => {
  const r = computeCheckpoint({ entryStock: 100, bars: [{ t: 1, price: 102 }], dir: 'bull', atr: null });
  assert.equal(r.atrNormalizedReturn, null);
  assert.equal(r.targetReached, null);
  assert.equal(r.stopReached, null);
  assert.equal(r.outcome, 'POSITIVE');
});

test('bearish signal: falling price is favorable, target uses lows', () => {
  const bars = [{ t: 5, price: 97, high: 100, low: 96 }];
  const r = computeCheckpoint({ entryStock: 100, bars, dir: 'bear', atr: 2, entryTs: 0 });
  assert.equal(r.directionalReturnPct, 3);    // down 3% = +3 for a PUT
  assert.equal(r.maxFavorablePct, 4);         // low 96
  assert.equal(r.targetReached, true);
});

test('reason codes are evidence-backed and flag conflicts', () => {
  const rec = {
    composite: { dir: 'bull', stockConfirm: -1 },
    context: { gammaRegime: 'negative', rvol: 2.1, earningsWithin2Days: true },
    scored: { components: [
      { key: 'largePremium', directional: true, weight: 0.10, avail: 1, dir: -1, strength: 0.6 },
      { key: 'cpVolume', directional: true, weight: 0.22, avail: 1, dir: 1, strength: 0.9 },
      { key: 'liquidity', directional: false, weight: 0.07, avail: 1, dir: 0, strength: 0.1 },
    ] },
  };
  const codes = reasonCodes(rec).map((c) => c.code);
  assert.ok(codes.includes('FLOW_NOT_CONFIRMED'));            // largePremium opposes
  assert.ok(codes.includes('DELTA_FLOW_EXTREME'));
  assert.ok(codes.includes('NEGATIVE_GAMMA_TREND_REGIME'));
  assert.ok(codes.includes('MARKET_CONFLICT'));               // stock conflicts
  assert.ok(codes.includes('RVOL_CONFIRMED'));
  assert.ok(codes.includes('EARNINGS_RISK'));
  assert.ok(codes.includes('LOW_LIQUIDITY'));
});

test('baselineReport segments by gamma regime / time-of-day and never fabricates', () => {
  const mk = (score, ret, regime, tod) => ({
    id: 's' + score + ret, ticker: 'T', firedAt: '2026-08-24T14:00:00Z',
    composite: { finalScore: score, dir: 'bull' }, shadowScore: score - 5,
    context: { gammaRegime: regime, timeOfDayBucket: tod },
    outcomes: { '30m': { status: 'resolved', directionalReturnPct: ret, maxFavorablePct: Math.abs(ret), maxAdversePct: -0.3, atrNormalizedReturn: ret / 2, outcome: ret > 0 ? 'TARGET' : 'STOP' } },
  });
  const recs = [mk(72, -0.4, 'positive', '09:45-10:30'), mk(85, 1.2, 'negative', '09:45-10:30'), mk(90, 1.8, 'negative', '13:00-14:30')];
  const R = baselineReport(recs);
  assert.equal(R.totals.evaluated, 3);
  assert.equal(R.byGammaRegime.length, 2);
  assert.equal(R.byGammaRegime[0].key, 'negative');           // sorted by avg return
  assert.ok(R.byGammaRegime.every((x) => x.gated));           // n < 30
  assert.equal(R.byHorizon['15m'].n, 0);                      // no 15m data → zero, not invented
  assert.equal(R.byHorizon['15m'].rankIC.ic, null);
  assert.match(R.note, /gated/i);
});

test('toRows only includes resolved outcomes (no partial/fabricated rows)', () => {
  const recs = [
    { id: 'a', ticker: 'A', firedAt: 'x', composite: { finalScore: 80, dir: 'bull' }, outcomes: { '30m': { status: 'pending' } } },
    { id: 'b', ticker: 'B', firedAt: 'x', composite: { finalScore: 80, dir: 'bull' }, outcomes: { '30m': { status: 'unavailable' } } },
    { id: 'c', ticker: 'C', firedAt: 'x', composite: { finalScore: 80, dir: 'bull' }, outcomes: { '30m': { status: 'resolved', directionalReturnPct: 1 } } },
  ];
  assert.equal(toRows(recs, '30m').length, 1);
});
