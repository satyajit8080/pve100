// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeTicker } from '../ticker.js';

test('safeTicker accepts valid US symbols (incl. class shares, ETFs)', () => {
  for (const t of ['AAPL', 'nvda', ' tsla ', 'SPY', 'QQQ', 'BRK.B', 'brk.b']) {
    const r = safeTicker(t);
    assert.ok(r && /^[A-Z0-9.]+$/.test(r), `${t} should pass → got ${r}`);
  }
  assert.equal(safeTicker('brk.b'), 'BRK.B');
});

test('safeTicker rejects path traversal, separators, and junk', () => {
  for (const bad of ['.', '..', '...', '../x', '..\\x', 'A/B', 'A\\B', '', '   ', '.AAPL', 'AAPL.', 'A..B', 'A B', '123', 'AAPL;rm', 'AAPL%2e%2e', 'a'.repeat(20), null, undefined]) {
    assert.equal(safeTicker(bad), null, `${JSON.stringify(bad)} must be rejected`);
  }
});
