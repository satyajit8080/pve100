// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { explainSignal, computeCheckpoint, analyzeOutcome, computeLearning, filterJournal, journalRow, JOURNAL_MIN_SCORE } from '../store/journal.js';
import { readJournal, appendOutcome, pendingOutcomes } from '../store/journal-store.js';

const mkRec = (over = {}) => ({
  id: over.id || 'NVDA:2026-08-24T14:00:00.000Z', ticker: over.ticker || 'NVDA', firedAt: over.firedAt || '2026-08-24T14:00:00.000Z',
  composite: { finalScore: 82, dir: 'bull', tier: 'STRONG', primary: 86, optionsScore: 90, stockScore: 60, dataQuality: 100, stockConfirm: 1, ...(over.composite || {}) },
  scored: { components: over.components || [
    { key: 'cpVolume', directional: true, weight: 0.22, avail: 1, dir: 1, strength: 0.9, value: 3.2 },
    { key: 'oiChange', directional: true, weight: 0.14, avail: 1, dir: 1, strength: 0.7, value: 0.2 },
    { key: 'largePremium', directional: true, weight: 0.10, avail: 1, dir: -1, strength: 0.4, value: -1 },
    { key: 'liquidity', directional: false, weight: 0.07, avail: 1, dir: 0, strength: 0.8, value: 0.5 },
  ] },
  displayedNotScored: { ivRank: 40 },
  entry: { stockPrice: 100, optionPrice: 5, vsVwapPct: 1.2, changePct: 2.1 },
  shadowScore: over.shadowScore ?? 70,
  outcomes: over.outcomes || {},
});

test('explanation identifies strongest, weakest and CONFLICTING factors', () => {
  const ex = explainSignal(mkRec());
  assert.ok(ex.summary.includes('NVDA'));
  assert.equal(ex.strongestFactors[0].key, 'cpVolume');            // highest weight×strength
  assert.equal(ex.conflictingFactors.length, 1);
  assert.equal(ex.conflictingFactors[0].key, 'largePremium');      // dir -1 vs bull call
  assert.equal(ex.directionalAgreement.agree, 2);
  assert.equal(ex.directionalAgreement.total, 3);
  assert.ok(ex.risks.some((r) => /disagree/i.test(r)));
});

test('explanation flags unavailable factors and never fabricates them', () => {
  const rec = mkRec({ components: [
    { key: 'cpVolume', directional: true, weight: 0.22, avail: 1, dir: 1, strength: 0.9 },
    { key: 'oiChange', directional: true, weight: 0.14, avail: 0, dir: 0, strength: 0 },
    { key: 'ivBehavior', directional: false, weight: 0.12, avail: 0, dir: 0, strength: 0 },
  ] });
  const ex = explainSignal(rec);
  assert.equal(ex.unavailableFactors.length, 2);
  assert.ok(/unavailable/i.test(ex.optionsFlowReasoning));
  assert.ok(ex.risks.some((r) => /no data/i.test(r)));
});

test('stock conflict is explained as a penalty, not a boost', () => {
  const ex = explainSignal(mkRec({ composite: { stockConfirm: -1 } }));
  assert.ok(/CONFLICTS/i.test(ex.stockConfirmation));
  assert.ok(ex.risks.some((r) => /disagreed with options flow/i.test(r)));
});

test('checkpoint math: direction-aware favorable/adverse, PUT wins when price falls', () => {
  const bars = [{ t: 1, price: 101 }, { t: 2, price: 103 }, { t: 3, price: 99 }, { t: 4, price: 102 }];
  const bull = computeCheckpoint({ entryStock: 100, entryOption: 5, bars, dir: 'bull' });
  assert.equal(bull.stockChangePct, 2);
  assert.equal(bull.maxFavorablePct, 3);      // peak 103
  assert.equal(bull.maxAdversePct, -1);       // trough 99
  assert.equal(bull.directionalReturnPct, 2);

  const bear = computeCheckpoint({ entryStock: 100, bars: [{ t: 1, price: 97 }], dir: 'bear' });
  assert.equal(bear.directionalReturnPct, 3); // a PUT that falls 3% is +3% in its own direction
});

test('checkpoint reports unavailable rather than guessing', () => {
  const r = computeCheckpoint({ entryStock: 100, bars: [], dir: 'bull' });
  assert.equal(r.status, 'unavailable');
});

test('post-trade analysis explains a WIN and a LOSS differently', () => {
  const won = mkRec(); won.explain = explainSignal(won);
  won.outcomes = { '60m': computeCheckpoint({ entryStock: 100, bars: [{ t: 1, price: 104 }], dir: 'bull' }) };
  const a = analyzeOutcome(won, '60m');
  assert.equal(a.verdict, 'WIN');
  assert.ok(a.topContributor);

  const lost = mkRec(); lost.explain = explainSignal(lost);
  lost.outcomes = { '60m': computeCheckpoint({ entryStock: 100, bars: [{ t: 1, price: 96 }], dir: 'bull' }) };
  const b = analyzeOutcome(lost, '60m');
  assert.equal(b.verdict, 'LOSS');
  assert.ok(b.likelyReason.length > 10);
  assert.ok(b.reversedFactors.some((f) => f.key === 'largePremium'));   // the dissenter was right
});

test('learning: win rate, factor performance, and low-sample gating', () => {
  const recs = [];
  for (let i = 0; i < 6; i++) {
    const r = mkRec({ id: 'T' + i, firedAt: `2026-08-24T1${i}:00:00.000Z` });
    r.explain = explainSignal(r);
    r.outcomes = { '60m': computeCheckpoint({ entryStock: 100, bars: [{ t: 1, price: i < 4 ? 103 : 97 }], dir: 'bull' }) };
    recs.push(r);
  }
  const L = computeLearning(recs, { horizon: '60m', minSample: 5 });
  assert.equal(L.totals.resolved, 6);
  assert.equal(L.totals.winners, 4);
  assert.ok(Math.abs(L.winRate - 66.67) < 0.1);
  assert.ok(L.factorPerformance.length > 0);
  const small = computeLearning(recs.slice(0, 2), { horizon: '60m', minSample: 5 });
  assert.ok(small.factorPerformance.every((f) => f.gated));            // too few samples → gated
  assert.ok(/never modify live engine weights/i.test(L.note));
});

test('INTEGRITY: outcomes are append-only patches and never rewrite the original signal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-'));
  const rec = mkRec(); rec.explain = explainSignal(rec);
  fs.writeFileSync(path.join(dir, 'signal-log-2026-08-24.jsonl'), JSON.stringify(rec) + '\n');
  const originalRaw = fs.readFileSync(path.join(dir, 'signal-log-2026-08-24.jsonl'), 'utf8');

  await appendOutcome(rec.id, '60m', { status: 'resolved', stockPrice: 104, directionalReturnPct: 4, maxFavorablePct: 4, maxAdversePct: 0 }, dir);

  // the signal file itself must be byte-identical
  assert.equal(fs.readFileSync(path.join(dir, 'signal-log-2026-08-24.jsonl'), 'utf8'), originalRaw);

  const merged = readJournal(dir);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].outcomes['60m'].directionalReturnPct, 4);      // patch merged at read time
  assert.equal(merged[0].composite.finalScore, 82);                    // original score untouched
  assert.equal(merged[0].explain.summary, rec.explain.summary);        // original explanation untouched
  assert.equal(merged[0].entry.stockPrice, 100);                       // original entry untouched
  assert.equal(merged[0].postAnalysis.verdict, 'WIN');                 // derived, not stored in signal file
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INTEGRITY: pendingOutcomes only returns checkpoints whose time has actually passed', () => {
  const fired = Date.parse('2026-08-24T14:00:00.000Z');
  const rec = mkRec({ firedAt: '2026-08-24T14:00:00.000Z' });
  const tooEarly = pendingOutcomes([rec], fired + 5 * 60000);           // 5 min later
  assert.equal(tooEarly.length, 0);                                    // no look-ahead resolution
  const after30 = pendingOutcomes([rec], fired + 31 * 60000);
  assert.deepEqual(after30.map((d) => d.horizon).sort(), ['15m', '30m']);
  const after1h = pendingOutcomes([rec], fired + 61 * 60000);
  assert.deepEqual(after1h.map((d) => d.horizon).sort(), ['15m', '30m', '60m']);
});

test('journal row + filtering: status reflects resolution state', () => {
  const pending = mkRec({ id: 'A' });
  const winner = mkRec({ id: 'B' });
  winner.outcomes = { '60m': { status: 'resolved', directionalReturnPct: 2.5 } };
  const loser = mkRec({ id: 'C' });
  loser.outcomes = { '60m': { status: 'resolved', directionalReturnPct: -1.5 } };
  assert.equal(journalRow(pending).status, 'PENDING');
  assert.equal(journalRow(winner).status, 'WIN');
  assert.equal(journalRow(loser).status, 'LOSS');

  const f = filterJournal([pending, winner, loser], { status: 'WIN' });
  assert.equal(f.total, 1);
  assert.equal(f.rows[0].ticker, 'NVDA');
  assert.equal(filterJournal([pending, winner, loser], { sort: 'best' }).rows[0].id, 'B');
});

test('journal threshold constant matches the spec (>= 70)', () => {
  assert.equal(JOURNAL_MIN_SCORE, 70);
});
