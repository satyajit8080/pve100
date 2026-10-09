// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeValidated, applyCalibration, IDENTITY_PROMOTION, VALIDATED_MODEL_VERSION } from '../validated/model.js';

test('identity promotion → validated EQUALS current, delta 0, mirrors dir/tier', () => {
  const v = computeValidated({ current: { score: 30, dir: 'bull', tier: 'Weak' }, featureInputs: { flowQuality: 0.9 }, promotion: IDENTITY_PROMOTION });
  assert.equal(v.validatedScore, 30);
  assert.equal(v.delta, 0);
  assert.equal(v.direction, 'bull');
  assert.equal(v.tier, 'Weak');
  assert.equal(v.usedFeatures.length, 0);
  assert.equal(v.probabilityShown, false);
  assert.equal(v.components[0].name, 'baseline (current score)');
  assert.equal(v.components.length, 1);            // no feature components when none approved
});

test('approved feature applies its Phase-3 weight deterministically (transparent components)', () => {
  const promotion = { approvedFeatures: ['flowQuality', 'gexRegime'], weights: { flowQuality: 10, gexRegime: 4 }, calibration: null };
  const v = computeValidated({ current: { score: 50, dir: 'bull', tier: 'Watch' }, featureInputs: { flowQuality: 0.8, gexRegime: 1 }, promotion });
  // 50 + 10*0.8 + 4*1 = 62
  assert.equal(v.validatedScore, 62);
  assert.equal(v.delta, 12);
  assert.deepEqual(v.usedFeatures, ['flowQuality', 'gexRegime']);
  const fq = v.components.find((c) => c.name === 'flowQuality');
  assert.equal(fq.contribution, 8);
  assert.equal(v.tier, 'Watch');                   // 62 → Watch band
});

test('missing feature input contributes 0 and is flagged — never fabricated', () => {
  const promotion = { approvedFeatures: ['flowQuality'], weights: { flowQuality: 10 }, calibration: null };
  const v = computeValidated({ current: { score: 40, dir: 'bull', tier: 'Weak' }, featureInputs: {}, promotion });
  assert.equal(v.validatedScore, 40);              // input unavailable → +0
  const fq = v.components.find((c) => c.name === 'flowQuality');
  assert.equal(fq.contribution, 0);
  assert.match(fq.note, /not fabricated/);
});

test('score clamps to [0,100]', () => {
  const promotion = { approvedFeatures: ['x'], weights: { x: 100 }, calibration: null };
  assert.equal(computeValidated({ current: { score: 90 }, featureInputs: { x: 1 }, promotion }).validatedScore, 100);
  assert.equal(computeValidated({ current: { score: 10 }, featureInputs: { x: -1 }, promotion }).validatedScore, 0);
});

test('probability hidden unless calibration is explicitly validated', () => {
  const noCal = computeValidated({ current: { score: 70 }, promotion: { approvedFeatures: [], weights: {}, calibration: { type: 'platt', a: 0.1, b: -5 } } });
  assert.equal(noCal.probabilityShown, false);     // calibration.validated !== true → hidden
  assert.equal(noCal.calibratedProbability, null);
  const withCal = computeValidated({ current: { score: 70 }, promotion: { approvedFeatures: [], weights: {}, calibration: { type: 'platt', a: 0.1, b: -5, validated: true } } });
  assert.equal(withCal.probabilityShown, true);
  assert.ok(withCal.calibratedProbability > 0 && withCal.calibratedProbability < 1);
});

test('applyCalibration: platt + isotonic', () => {
  assert.ok(Math.abs(applyCalibration({ type: 'platt', a: 0, b: 0 }, 50) - 0.5) < 1e-9);
  const iso = { type: 'isotonic', points: [{ x: 0, p: 0.1 }, { x: 50, p: 0.5 }, { x: 100, p: 0.9 }] };
  assert.ok(Math.abs(applyCalibration(iso, 50) - 0.5) < 1e-9);
  assert.ok(Math.abs(applyCalibration(iso, 25) - 0.3) < 1e-9);   // linear interp
});

test('validated model is PURE (no input mutation) and version-stamped', () => {
  const promotion = { approvedFeatures: ['a'], weights: { a: 5 }, calibration: null };
  const inp = { current: { score: 50, dir: 'bull', tier: 'Watch' }, featureInputs: { a: 0.5 }, promotion };
  const snap = JSON.stringify(inp);
  const v = computeValidated(inp);
  assert.equal(JSON.stringify(inp), snap);
  assert.equal(v.version, VALIDATED_MODEL_VERSION);
});

test('null current score → validated null (no fabrication)', () => {
  const v = computeValidated({ current: {}, promotion: IDENTITY_PROMOTION });
  assert.equal(v.validatedScore, null);
  assert.equal(v.delta, null);
});
