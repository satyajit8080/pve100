// @ts-check
/*
 * providers/options.js — options/stock provider selection.
 * PVE.trade v1 (providers/pve.js) is the real data source. Polygon was removed: PVE v1 already
 * provides the chain+Greeks+IV+OI (and additionally real GEX, sweeps, IV-rank) that Polygon supplied.
 * NullOptionsProvider is the honest fallback when no provider/key is configured.
 */
import { UnusualWhalesOptionsProvider } from './unusualwhales.js';

export class NullOptionsProvider {
  constructor(reason = 'No options provider configured (set OPTIONS_PROVIDER=uw + UNUSUAL_WHALES_API_TOKEN)') { this.name = 'null'; this.reason = reason; }
  async getChain(ticker) { return { available: false, error: this.reason, chain: { ticker, asOf: new Date().toISOString(), underlying: { available: false }, contracts: [], fieldsAvailable: { chain: false }, flow: { available: false, largeTrades: [] } } }; }
  async getUnderlying() { return { available: false, error: this.reason }; }
}

/** Build the options provider from env. Supported: pve | null. */
export function makeOptionsProvider(env = {}, { limiter = null } = {}) {
  let name = (env.OPTIONS_PROVIDER || 'null').toLowerCase();
  const baseUrl = env.OPTIONS_BASE_URL;
  const token = env.UNUSUAL_WHALES_API_TOKEN || env.OPTIONS_API_KEY;

  // MIGRATION: the PVE provider was removed (UW-only). An existing .env may still say
  // OPTIONS_PROVIDER=pve — fall through to UW when a token exists instead of silently
  // going dark, and say so plainly when it doesn't.
  if (name === 'pve') {
    if (env.UNUSUAL_WHALES_API_TOKEN) name = 'uw';
    else return new NullOptionsProvider('OPTIONS_PROVIDER=pve is no longer supported (PVE Trade API removed). Set OPTIONS_PROVIDER=uw and UNUSUAL_WHALES_API_TOKEN=<your UW token> in .env, then restart.');
  }

  if (name === 'uw') {
    return token ? new UnusualWhalesOptionsProvider({ apiKey: token, baseUrl, limiter })
      : new NullOptionsProvider('OPTIONS_PROVIDER=uw set but UNUSUAL_WHALES_API_TOKEN is missing from .env');
  }
  if (name === 'null') return new NullOptionsProvider('OPTIONS_PROVIDER is not set. Add OPTIONS_PROVIDER=uw and UNUSUAL_WHALES_API_TOKEN=<your UW token> to .env, then restart.');
  return new NullOptionsProvider(`Unknown OPTIONS_PROVIDER='${name}' (only 'uw' is supported).`);
}

// §15 — never expose a full credential anywhere (UI, logs, errors, API responses).
export function maskKey(key) {
  if (!key || typeof key !== 'string') return null;
  const last4 = key.slice(-4);
  return `${'*'.repeat(8)}${last4}`;
}

export function optionsProviderStatus(env = {}) {
  let name = (env.OPTIONS_PROVIDER || 'null').toLowerCase();
  if (name === 'pve' && env.UNUSUAL_WHALES_API_TOKEN) name = 'uw';   // same migration the factory applies
  const base = (name === 'uw' || name === 'pve') ? 'https://api.unusualwhales.com' : null;
  const key = env.UNUSUAL_WHALES_API_TOKEN || (name === 'uw' ? env.OPTIONS_API_KEY : null);
  const configured = name === 'uw' && !!key;
  let reason = null;
  if (!configured) {
    if (name === 'pve') reason = 'OPTIONS_PROVIDER=pve is no longer supported (set OPTIONS_PROVIDER=uw + UNUSUAL_WHALES_API_TOKEN)';
    else if (name === 'uw') reason = 'UNUSUAL_WHALES_API_TOKEN missing from .env';
    else if (name === 'null') reason = 'OPTIONS_PROVIDER not set in .env';
    else reason = `unknown OPTIONS_PROVIDER='${name}'`;
  }
  return { provider: name, configured, baseUrl: env.OPTIONS_BASE_URL || base, keyMasked: maskKey(key), reason };
}
