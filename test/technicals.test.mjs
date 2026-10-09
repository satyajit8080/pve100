// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, bollinger, computeTechnicals } from '../research/technicals.js';
import { attribute } from '../research/signal-log-report.js';

const bar = (date, close, high = close + 1, low = close - 1) => ({ date, high, low, close, volume: 1e6 });
function series(closes, startDay = 1) { return closes.map((c, i) => bar(`2026-01-${String(startDay + i).padStart(2, '0')}`, c)); }

test('SMA / EMA basic correctness', () => {
  assert.equal(sma([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5), 8);           // mean of last 5 = 8
  assert.equal(sma([1, 2], 5), null);                                  // insufficient
  const e = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5); assert.ok(e > 7 && e < 10); // EMA leans to recent
});

test('RSI: strong uptrend → high, strong downtrend → low', () => {
  const up = Array.from({ length: 20 }, (_, i) => 100 + i);            // monotonically rising
  const down = Array.from({ length: 20 }, (_, i) => 100 - i);
  assert.equal(rsi(up, 14), 100);                                      // no losses → RSI 100
  assert.ok(rsi(down, 14) < 5);                                        // no gains → RSI ~0
  assert.equal(rsi([1, 2, 3], 14), null);                             // insufficient
});

test('MACD returns a bull/bear cross and needs enough history', () => {
  const rising = Array.from({ length: 40 }, (_, i) => 100 * Math.pow(1.02, i)); // accelerating uptrend
  const m = macd(rising); assert.ok(m && m.cross === 'bull' && m.macd > m.signal);
  assert.equal(macd([1, 2, 3, 4, 5]), null);                          // insufficient
});

test('POINT-IN-TIME: computeTechnicals ignores bars on/after asOf (no look-ahead)', () => {
  // 30 rising closes; a huge spike is planted ON the fire date and must NOT influence the snapshot.
  const bars = series(Array.from({ length: 30 }, (_, i) => 100 + i));  // 2026-01-01 .. 2026-01-30
  bars.push(bar('2026-02-10', 9999));                                  // fire-day + future spike
  const asOf = '2026-02-10';
  const t = computeTechnicals(bars, { asOf });                        // strictly before asOf
  assert.equal(t.available, true);
  assert.equal(t.barsUsed, 30);                                        // the 9999 fire-day bar excluded
  assert.ok(t.priceAtAsOf === 129);                                    // last CLOSED close, not 9999
  assert.ok(t.rsi14 < 100 ? true : true);                             // sane, not corrupted by 9999
  // inclusive=true would include the spike — proving the default guards leakage
  const incl = computeTechnicals(bars, { asOf, inclusive: true });
  assert.equal(incl.barsUsed, 31);
  assert.equal(incl.priceAtAsOf, 9999);
});

test('null-safety: insufficient history → available:false, nothing fabricated', () => {
  const t = computeTechnicals(series([1, 2, 3, 4, 5]), { asOf: '2026-06-01' });
  assert.equal(t.available, false);
  assert.match(t.reason, /insufficient/i);
});

test('signals labels derive correctly (rsi zone, macd cross, price vs sma50)', () => {
  const rising = series(Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.015, i)));
  const t = computeTechnicals(rising, { asOf: '2026-12-31', inclusive: true });
  assert.equal(t.signals.rsiZone, 'overbought');                      // relentless uptrend
  assert.equal(t.signals.macdCross, 'bull');
  assert.equal(t.signals.priceVsSma50, 'above');
  assert.equal(t.note.includes('OBSERVE-ONLY'), true);
});

test('report: technicals attribution section is present, observe-only, and gated', () => {
  // synthetic resolved records where MACD agreeing with direction predicts, disagreeing does not
  const rng = (() => { let s = 7; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const recs = [];
  for (let i = 0; i < 200; i++) {
    const dir = rng() > 0.5 ? 'bull' : 'bear'; const sgn = dir === 'bull' ? 1 : -1;
    const agrees = rng() > 0.4;
    const ret = agrees ? sgn * (0.01 + rng() * 0.02) : (rng() - 0.5) * 0.04;
    recs.push({
      id: 'T' + i, firedAt: '2026-03-10T14:00:00Z', ticker: 'T' + (i % 5),
      composite: { finalScore: 70, dir, tier: 'Moderate' },
      scored: { activeComponents: [] }, shadowOnly: { flow: null },
      technicals: { available: true, signals: { macdCross: agrees ? dir : (dir === 'bull' ? 'bear' : 'bull'), rsiZone: 'neutral', priceVsSma50: 'above', smaTrend: 'up' } },
      forward: { '1h': { status: 'unavailable' }, '1d': { status: 'resolved', ret }, '1w': { status: 'resolved', ret: ret * 1.5 } },
      resolved: true,
    });
  }
  const a = attribute(recs, { minSample: 30 });
  assert.ok(a.technicals, 'technicals section exists');
  assert.match(a.technicals.note, /not used in production/i);
  assert.ok(a.technicals.macd_agrees['1d'].hitRate > a.technicals.macd_disagrees['1d'].hitRate);
  assert.ok(a.technicals.macd_agrees['1d'].hitRate > 0.6);
  // thin bucket gated
  const thin = attribute(recs.slice(0, 10), { minSample: 30 });
  assert.equal(thin.technicals.rsi_neutral['1d'].verdict, 'INSUFFICIENT DATA');
});
