// Run: node --test
// REQ 6 — Baseline protection. The Signal Journal must NOT change production signal behavior.
// This asserts buildOptionsSignal still produces the values frozen in baseline-signals.json
// (captured BEFORE the journal was implemented). If anything differs, this fails → STOP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildOptionsSignal } from '../public/options-engine.js';
import { FIXTURES, captureBaseline } from './fixtures/engine-fixtures.mjs';

const baseline = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'baseline-signals.json'), 'utf8'));

test('production engine matches the frozen baseline (no drift from the Signal Journal)', () => {
  for (const fx of FIXTURES) {
    const now = captureBaseline(buildOptionsSignal(fx.chain, fx.ctx, {}));
    assert.deepEqual(now, baseline[fx.name], `BASELINE DRIFT in fixture "${fx.name}" — production scoring changed. STOP and diff.`);
  }
});
