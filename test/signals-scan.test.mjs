// Run: node --test  (integration: boots the server with a temp SCAN_DIR)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const real = globalThis.fetch;
globalThis.fetch = async (u, o) => { const s = String(u); if (s.includes('127.0.0.1') || s.includes('localhost')) return real(u, o); return { ok: true, status: 200, json: async () => ({ data: [] }) }; };

const SCAN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
process.env.PORT = '4290'; process.env.DASHBOARD_PASSWORD = 'x'; process.env.OPTIONS_PROVIDER = 'uw'; process.env.OPTIONS_API_KEY = 'pve_live_SECRET'; process.env.UNUSUAL_WHALES_API_TOKEN = 'uw_live_SECRET'; process.env.OPENROUTER_API_KEY = ''; process.env.SCAN_DIR = SCAN_DIR;
const { httpServer } = await import('../server.js');
after(() => { try { httpServer.close(); } catch {} try { fs.rmSync(SCAN_DIR, { recursive: true, force: true }); } catch {} });
await new Promise((r) => setTimeout(r, 300));
const B = 'http://127.0.0.1:4290';
const cookie = (await real(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x' }) })).headers.get('set-cookie').split(';')[0];
const G = async (p) => (await real(B + p, { headers: { cookie } })).json();

test('DATA UNAVAILABLE (honest) when the scan cache does not exist yet', async () => {
  try { fs.rmSync(path.join(SCAN_DIR, 'latest.json')); } catch {}
  const r = await G('/api/signals/us');
  assert.equal(r.ok, true);
  assert.equal(r.available, false);
  assert.equal(r.dataStatus, 'DATA UNAVAILABLE');
  assert.deepEqual(r.rows, []);
  assert.match(r.reason, /no scan yet|run scan/i);
});

test('serves the scan cache; production is the authority, shadow is validation-only; no fabrication', async () => {
  const cache = {
    generatedAt: new Date().toISOString(), universe: 'screener', scored: 2, skipped: 1, count: 3,
    rows: [
      { ticker: 'NVDA', productionScore: 91, shadowScore: 87, scoreDelta: -4, engineAgreement: 'HIGH', signal: 'CALL', marketBias: 'STRONG', confidence: 100, price: 182.42, changePct: 3.42, ivRank: 55, optionsLiquidity: 'HIGH', shadowStatus: 'VALID' },
      { ticker: 'AMD', productionScore: 82, shadowScore: 64, scoreDelta: -18, engineAgreement: 'DIVERGENCE', signal: 'CALL', marketBias: 'STRONG', confidence: 90, price: 173.10, changePct: 1.92, ivRank: 40, optionsLiquidity: 'HIGH', shadowStatus: 'VALID' },
      { ticker: 'ZZZZ', productionScore: null, shadowScore: null, scoreDelta: null, engineAgreement: 'INSUFFICIENT', signal: 'DATA UNAVAILABLE', marketBias: 'UNAVAILABLE', confidence: null, price: null, changePct: null, ivRank: null, optionsLiquidity: null, shadowStatus: 'INSUFFICIENT' },
    ],
  };
  fs.writeFileSync(path.join(SCAN_DIR, 'latest.json'), JSON.stringify(cache));
  const r = await G('/api/signals/us');
  assert.equal(r.available, true);
  assert.equal(r.count, 3);
  assert.equal(r.rows[0].ticker, 'NVDA');
  // production and shadow are BOTH present and independent; delta is display-only
  assert.equal(r.rows[0].productionScore, 91);
  assert.equal(r.rows[0].shadowScore, 87);
  assert.equal(r.rows[0].scoreDelta, -4);
  // the note makes the isolation explicit
  assert.match(r.note, /shadowScore is validation-only and never modifies/i);
  // sparse ticker keeps nulls — never fabricated into numbers
  const z = r.rows.find((x) => x.ticker === 'ZZZZ');
  assert.equal(z.productionScore, null);
  assert.equal(z.signal, 'DATA UNAVAILABLE');
  // no secret leakage
  assert.ok(!/pve_live_|SECRET|Bearer/.test(JSON.stringify(r)));
});

test('limit param bounds the rows returned', async () => {
  const r = await G('/api/signals/us?limit=1');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].ticker, 'NVDA');
});

test('the Signals menu + page are served in the SPA shell', async () => {
  const html = await (await real(B + '/')).text();
  assert.match(html, /data-tab="signals"/, 'nav item missing');
  assert.match(html, /data-page="signals"/, 'page panel missing');
  assert.match(html, /id="sigTable"/, 'table container missing');
});
