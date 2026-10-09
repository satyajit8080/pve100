// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NullOptionsProvider, makeOptionsProvider, optionsProviderStatus } from '../providers/options.js';

test('NullOptionsProvider returns unavailable chain (never fabricates)', async () => {
  const r = await new NullOptionsProvider().getChain('AAPL');
  assert.equal(r.available, false); assert.ok(r.error);
  assert.equal(r.chain.fieldsAvailable.chain, false);
});

test('a legacy OPTIONS_PROVIDER=pve env migrates to UW when a token exists', () => {
  const st = optionsProviderStatus({ OPTIONS_PROVIDER: 'pve', UNUSUAL_WHALES_API_TOKEN: 'tok1234' });
  assert.equal(st.provider, 'uw');
  assert.equal(st.configured, true);
  const dead = optionsProviderStatus({ OPTIONS_PROVIDER: 'pve', OPTIONS_API_KEY: 'pve_live_x' });
  assert.equal(dead.configured, false);
  assert.match(dead.reason, /no longer supported/i);
});

test('makeOptionsProvider: env-driven selection (uw | null)', () => {
  assert.equal(makeOptionsProvider({}).name, 'null');
      assert.equal(makeOptionsProvider({ OPTIONS_PROVIDER: 'polygon', OPTIONS_API_KEY: 'k' }).name, 'null'); // removed → null
});

test('optionsProviderStatus reflects config', () => {
  const empty = optionsProviderStatus({});
  assert.equal(empty.provider, 'null'); assert.equal(empty.configured, false); assert.equal(empty.keyMasked, null);
  assert.match(empty.reason, /OPTIONS_PROVIDER not set/i);
  const ok = optionsProviderStatus({ OPTIONS_PROVIDER: 'uw', UNUSUAL_WHALES_API_TOKEN: 'abcd1234wxyz' });
  assert.equal(ok.provider, 'uw'); assert.equal(ok.configured, true); assert.equal(ok.keyMasked, '********wxyz'); assert.equal(ok.reason, null);
});
