// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelOutcome, findIndexByDate } from '../research/labeler.js';

// entry bar index 0 (close 100). Forward bars are indices 1..N.
const bars = [
  { date: '2026-08-17', open: 99, high: 101, low: 98, close: 100 }, // entry (its high/low must NOT count)
  { date: '2026-08-18', open: 100, high: 104, low: 99, close: 103 },
  { date: '2026-08-19', open: 103, high: 106, low: 102, close: 105 }, // upMax here (+6%)
  { date: '2026-08-20', open: 105, high: 105, low: 95, close: 97 },  // downMin here (-5%)
  { date: '2026-08-21', open: 97, high: 99, low: 96, close: 98 },
];

test('findIndexByDate matches exact and date-prefixed timestamps', () => {
  assert.equal(findIndexByDate(bars, '2026-08-19'), 2);
  assert.equal(findIndexByDate(bars, '2026-08-19T00:00:00Z'), 2);
  assert.equal(findIndexByDate(bars, '2099-01-01'), -1);
});

test('bull: MFE=upside, MAE=downside, correct time-to-extreme, no entry-bar look-ahead', () => {
  const o = labelOutcome({ bars, entryIndex: 0, horizonDays: 4, direction: 'bull' });
  assert.equal(o.insufficient, false);
  assert.equal(o.entryPrice, 100);
  assert.ok(Math.abs(o.mfe - 0.06) < 1e-9);   // +6% at index 2
  assert.ok(Math.abs(o.mae - (-0.05)) < 1e-9); // -5% at index 3
  assert.equal(o.timeToMfeDays, 2);
  assert.equal(o.timeToMaeDays, 3);
  assert.ok(Math.abs(o.ret - (-0.02)) < 1e-9); // exit close 98 → -2%
  assert.equal(o.hitDirection, false);         // bull but ended down
  // entry bar high(101)=+1% must not be the MFE
  assert.ok(o.mfe > 0.05);
});

test('bear: favorable=downside, adverse=upside, hit when ret<0', () => {
  const o = labelOutcome({ bars, entryIndex: 0, horizonDays: 4, direction: 'bear' });
  assert.ok(Math.abs(o.mfe - 0.05) < 1e-9);    // downside 5% is favorable for a short
  assert.ok(Math.abs(o.mae - (-0.06)) < 1e-9); // upside 6% is adverse
  assert.equal(o.timeToMfeDays, 3);
  assert.equal(o.timeToMaeDays, 2);
  assert.equal(o.hitDirection, true);          // ended down → short correct
});

test('neutral: direction-aware mfe/mae null, raw excursions present', () => {
  const o = labelOutcome({ bars, entryIndex: 0, horizonDays: 4, direction: 'neutral' });
  assert.equal(o.mfe, null); assert.equal(o.mae, null);
  assert.ok(Math.abs(o.rawUpMax - 0.06) < 1e-9);
  assert.ok(Math.abs(o.rawDownMin - (-0.05)) < 1e-9);
  assert.equal(o.hitDirection, null);
});

test('horizon clamps to available bars; entry at last bar is insufficient', () => {
  const o = labelOutcome({ bars, entryIndex: 0, horizonDays: 99, direction: 'bull' });
  assert.equal(o.usedBars, 4);                 // only 4 forward bars exist
  const last = labelOutcome({ bars, entryIndex: bars.length - 1, horizonDays: 3, direction: 'bull' });
  assert.equal(last.insufficient, true);       // no forward bars
  assert.equal(last.entryPrice, 98);
});

test('bad inputs return insufficient without throwing', () => {
  assert.equal(labelOutcome({ bars: [], entryIndex: 0 }).insufficient, true);
  assert.equal(labelOutcome({ bars, entryDate: 'nope', direction: 'bull' }).insufficient, true);
  assert.equal(labelOutcome({ bars, entryIndex: 0, entryPrice: 0 }).insufficient, true);
});
