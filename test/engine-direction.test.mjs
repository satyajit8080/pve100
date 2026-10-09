// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOptionsSignal, combineScores } from '../public/options-engine.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
// mirror of scan-universe.js signalFrom (kept in sync)
function signalFrom(score, dir) { if (!isNum(score)) return 'DATA UNAVAILABLE'; if (score < 65) return 'WATCH'; return dir === 'bull' ? 'CALL' : dir === 'bear' ? 'PUT' : 'WATCH'; }

const callHeavyChain = (price, prevClose) => ({
  ticker: 'X', underlying: { price, prevClose, available: true },
  contracts: [
    { type: 'call', strike: 100, volume: 4000, openInterest: 5000, iv: 0.4, gamma: 0.03, bid: 5, ask: 5.1, expiration: '2026-04-17' },
    { type: 'put', strike: 95, volume: 1000, openInterest: 5000, iv: 0.4, gamma: 0.02, bid: 3, ask: 3.1, expiration: '2026-04-17' },
  ],
  fieldsAvailable: { chain: true, greeks: true, oi: true, iv: true, quotes: true, underlying: true }, flow: { available: false, largeTrades: [] },
});
const bullFlow = { available: true, largeTrades: [{ side: 'call', premium: 900000 }, { side: 'call', premium: 600000 }] };

test('stock confirmation is SIGNED: conflict penalizes, agreement boosts', () => {
  const down = [100, 99, 97, 95, 93, 92];  // -8% → stockDir bear (conflicts with bullish flow)
  const up = [92, 93, 95, 97, 99, 100];     // +8.7% → stockDir bull (agrees)
  const conflict = buildOptionsSignal(callHeavyChain(92, 100), { prevAgg: null, underlyingHist: down, flow: bullFlow }, {});
  const agree = buildOptionsSignal(callHeavyChain(100, 92), { prevAgg: null, underlyingHist: up, flow: bullFlow }, {});
  assert.ok(agree.finalScore > conflict.finalScore + 30, `agreement (${agree.finalScore}) must beat conflict (${conflict.finalScore}) by a wide margin`);
  assert.ok(conflict.finalScore < 65, `falling stock + bullish flow must drop below CALL threshold (got ${conflict.finalScore})`);
  assert.ok(agree.finalScore >= 65, `rising stock + bullish flow should stay a real CALL (got ${agree.finalScore})`);
});

test('a down-trending stock no longer produces a CALL signal', () => {
  const down = [100, 98, 96, 94, 92, 90];
  const sig = buildOptionsSignal(callHeavyChain(90, 100), { prevAgg: null, underlyingHist: down, flow: bullFlow }, {});
  assert.equal(signalFrom(sig.finalScore, sig.dir), 'WATCH');   // not CALL
});

test('combineScores: stockConfirm is +1 agree / -1 conflict / 0 neutral', () => {
  assert.equal(combineScores({ optionsScore: 80, optionsDir: 'bull', stockScore: 60, stockDir: 'bull', dataQuality: 100 }).stockConfirm, 1);
  assert.equal(combineScores({ optionsScore: 80, optionsDir: 'bull', stockScore: 60, stockDir: 'bear', dataQuality: 100 }).stockConfirm, -1);
  assert.equal(combineScores({ optionsScore: 80, optionsDir: 'bull', stockScore: 5, stockDir: 'neutral', dataQuality: 100 }).stockConfirm, 0);
  // conflict must score strictly lower than agreement for the same magnitudes
  const a = combineScores({ optionsScore: 80, optionsDir: 'bull', stockScore: 60, stockDir: 'bull', dataQuality: 100 }).finalScore;
  const c = combineScores({ optionsScore: 80, optionsDir: 'bull', stockScore: 60, stockDir: 'bear', dataQuality: 100 }).finalScore;
  assert.ok(a > c);
});

test('signal threshold: CALL/PUT only at score >= 65 (pure calls)', () => {
  assert.equal(signalFrom(9, 'bull'), 'WATCH');
  assert.equal(signalFrom(55, 'bull'), 'WATCH');
  assert.equal(signalFrom(64, 'bull'), 'WATCH');
  assert.equal(signalFrom(65, 'bull'), 'CALL');
  assert.equal(signalFrom(70, 'bear'), 'PUT');
  assert.equal(signalFrom(85, 'neutral'), 'WATCH');   // neutral dir never a call
});
