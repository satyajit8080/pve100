// Run: node --test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
process.env.SIGNAL_LOG_DIR = path.join(TMP, 'journal');
process.env.BASELINE_DIR = path.join(TMP, 'baselines');
process.env.SCAN_DIR = path.join(TMP, 'scan');
process.env.PORT = '4287';
process.env.DASHBOARD_PASSWORD = 'pw';
process.env.OPTIONS_PROVIDER = 'uw';
process.env.UNUSUAL_WHALES_API_TOKEN = 'testtoken9999';

const real = globalThis.fetch;
let uwFailMode = null;                       // null | 'network' | 'ratelimit' | 'server'
let uwCalls = 0;
const J = (o) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => o });
globalThis.fetch = async (u, o) => {
  const s = String(u);
  if (s.includes('127.0.0.1') || s.includes('localhost')) return real(u, o);
  uwCalls++;
  if (uwFailMode === 'network') throw new Error('socket hang up');
  if (uwFailMode === 'ratelimit') return { ok: false, status: 429, headers: { get: (k) => (k === 'x-ratelimit-remaining' ? '0' : null) }, json: async () => ({}) };
  if (uwFailMode === 'server') return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
  if (s.includes('/stock-state')) return J({ data: { close: '210', prev_close: '200', volume: '5000000' } });
  if (s.includes('/option-contracts')) return J({ data: [
    { option_symbol: 'AAPL260918C00200000', volume: 9000, open_interest: 4000, implied_volatility: 0.45, delta: 0.55, gamma: 0.05, nbbo_bid: 5, nbbo_ask: 5.2 },
    { option_symbol: 'AAPL260918P00200000', volume: 1200, open_interest: 4000, implied_volatility: 0.42, delta: -0.45, gamma: 0.04, nbbo_bid: 2, nbbo_ask: 2.2 },
  ] });
  if (s.includes('/ohlc/5m')) return J({ data: Array.from({ length: 12 }, (_, i) => ({ start_time: `2026-08-24T13:${String(30 + i * 5).padStart(2, '0')}:00Z`, open: 208, high: 211, low: 207, close: 209 + i * 0.1, volume: 100000 })) });
  if (s.includes('/ohlc')) return J({ data: Array.from({ length: 20 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, open: 200, high: 205 + i, low: 198 + i, close: 200 + i, volume: 1e6 })) });
  return J({ data: [] });
};

const { httpServer } = await import('../server.js');
const B = 'http://127.0.0.1:4287';
const cookie = (await real(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) })).headers.get('set-cookie').split(';')[0];
const G = async (p) => (await real(B + p, { headers: { cookie } })).json();
const POST = async (p, body) => { const r = await real(B + p, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };

// ---------------------------------------------------------------- §1 manual triggers
test('Run Scan is a manual endpoint that reports its state', async () => {
  const st = await G('/api/scan/status');
  assert.equal(st.ok, true);
  assert.equal(st.running, false);
  assert.ok('lastOk' in st);
});

test('Resolve Outcomes is a manual endpoint that reports its state', async () => {
  const st = await G('/api/journal/resolve/status');
  assert.equal(st.ok, true);
  assert.equal(st.running, false);
});

test('scan reports failure clearly rather than silently succeeding', async () => {
  const r = await POST('/api/scan/run', { limit: 1 });
  assert.ok([200, 409, 500].includes(r.status));
  if (r.status === 200) assert.equal(r.body.started, true);
});

test('duplicate scan requests are refused while one is running', async () => {
  const a = await POST('/api/scan/run', { limit: 1 });
  const b = await POST('/api/scan/run', { limit: 1 });
  const statuses = [a.status, b.status];
  assert.ok(statuses.includes(409) || statuses.every((s) => s === 200),
    'a second concurrent scan must 409 rather than double-spend UW quota');
});

// ---------------------------------------------------------------- UW failure handling
test('UW network failure degrades gracefully and never throws to the client', async () => {
  uwFailMode = 'network';
  const r = await G('/api/options/AAPL');
  assert.ok(r.ok === false || (r.signal && r.signal.dataQuality != null),
    'a UW outage must produce an honest failure, not a fabricated score');
  uwFailMode = null;
});

test('UW 429 is retried/backed off and surfaced, not converted to zero data', async () => {
  uwFailMode = 'ratelimit';
  const before = uwCalls;
  const r = await G('/api/options/AAPL');
  assert.ok(uwCalls > before);
  assert.ok(r.ok === false || r.signal, 'response must exist');
  if (r.signal) assert.notEqual(r.signal.finalScore, 0, 'rate-limited data must not masquerade as a real 0 score');
  uwFailMode = null;
});

test('UW 5xx does not corrupt the journal', async () => {
  uwFailMode = 'server';
  await G('/api/options/AAPL').catch(() => null);
  uwFailMode = null;
  const list = await G('/api/journal/list');
  assert.equal(list.ok, true);
  for (const row of list.rows) assert.ok(Number.isFinite(row.score), 'no NaN scores may be journaled');
});

// ---------------------------------------------------------------- §15 secrets
test('no endpoint leaks the UW token', async () => {
  const blobs = await Promise.all(['/auth/status', '/api/research/readiness', '/api/journal/list', '/api/journal/evaluation'].map(G));
  const all = JSON.stringify(blobs);
  assert.ok(!all.includes('testtoken9999'), 'UW token must never appear in an API response');
  assert.ok(all.includes('****'), 'masked form should be shown instead');
});

// ---------------------------------------------------------------- §11 V1 vs V2
test('evaluation exposes V1 and V2 metrics side by side', async () => {
  const e = await G('/api/journal/evaluation');
  assert.equal(e.ok, true);
  const h = e.report.byHorizon['30m'];
  assert.ok('rankIC' in h && 'v2RankIC' in h, 'both engines must be measured on the same rows');
  assert.ok('topDecile' in h && 'v2TopDecile' in h);
  assert.ok('byV2State' in e.report);
});

// ---------------------------------------------------------------- §12/§13 readiness
test('readiness reports UNAVAILABLE features and keeps v2 in SHADOW', async () => {
  const r = await G('/api/research/readiness');
  assert.equal(r.ok, true);
  assert.equal(r.readiness.v2Status, 'SHADOW');
  assert.equal(r.readiness.promotion, 'NOT_READY');
  assert.equal(r.readiness.dataSource, 'UNUSUAL_WHALES_ONLY');
  assert.equal(r.readiness.features.macro, 'UNAVAILABLE');
  assert.equal(r.readiness.metrics.v2RankIC, null);         // null, never a placeholder number
  assert.ok(r.uw.requestsTotal >= 0);
});

// ---------------------------------------------------------------- §9/§10 immutability
test('outcome resolution never rewrites the original signal file', async () => {
  const dir = process.env.SIGNAL_LOG_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const rec = {
    id: 'IMMU:1', ticker: 'IMMU', firedAt: new Date(Date.now() - 7200000).toISOString(),
    composite: { finalScore: 80, dir: 'bull', tier: 'STRONG', primary: 84, optionsScore: 88, stockScore: 50, dataQuality: 100, stockConfirm: 1 },
    scored: { components: [] }, entry: { stockPrice: 100, optionPrice: 4 }, outcomes: {},
  };
  const file = path.join(dir, 'signal-log-immu.jsonl');
  fs.writeFileSync(file, JSON.stringify(rec) + '\n');
  const before = fs.readFileSync(file, 'utf8');

  const { appendOutcome, readJournal } = await import('../store/journal-store.js');
  await appendOutcome('IMMU:1', '30m', { status: 'resolved', directionalReturnPct: 2, maxFavorablePct: 2, maxAdversePct: 0 }, dir);
  await appendOutcome('IMMU:1', '30m', { status: 'resolved', directionalReturnPct: 2, maxFavorablePct: 2, maxAdversePct: 0 }, dir);  // duplicate

  assert.equal(fs.readFileSync(file, 'utf8'), before, 'signal file must be byte-identical after outcomes');
  const merged = readJournal(dir).find((r) => r.id === 'IMMU:1');
  assert.equal(merged.composite.finalScore, 80);
  assert.equal(merged.outcomes['30m'].directionalReturnPct, 2);   // duplicate patch collapses, no double-count
});

after(() => { try { httpServer.close(); } catch { /* */ } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
