// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rvolReadiness, ivSkewReadiness, sectorRelativeStrength, macroReadiness, promotionGate, researchReadiness, RateLimiter, prioritizeRequests, FEATURE_STATE } from '../store/readiness.js';
import { maskKey, optionsProviderStatus, makeOptionsProvider } from '../providers/options.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'research-data', 'ai-runs'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
};

// ---------------------------------------------------------------- §18 data rule
test('UW is the ONLY external market-data provider in the codebase', () => {
  const forbidden = [/api\.pve\.trade/i, /polygon\.io/i, /thetadata/i, /api\.tradier/i, /orats\.com/i, /cboe\.com\/data/i, /massive\.io/i];
  const offenders = [];
  for (const f of walk(ROOT)) {
    if (f.includes(`${path.sep}test${path.sep}`)) continue;              // tests may name them to assert absence
    const src = fs.readFileSync(f, 'utf8');
    for (const re of forbidden) if (re.test(src)) offenders.push(`${path.relative(ROOT, f)} :: ${re}`);
  }
  assert.deepEqual(offenders, [], `forbidden data providers referenced:\n${offenders.join('\n')}`);
});

test('the PVE provider module no longer exists', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'providers', 'pve.js')), false);
  assert.equal(makeOptionsProvider({ OPTIONS_PROVIDER: 'pve', OPTIONS_API_KEY: 'k' }).name, 'null');
});

test('no background scheduler ships with the app', () => {
  const deploy = path.join(ROOT, 'deploy');
  const timers = fs.existsSync(deploy) ? fs.readdirSync(deploy).filter((f) => f.endsWith('.timer')) : [];
  assert.deepEqual(timers, [], 'systemd timers must not ship — scanning is manual only');
  // server must not self-schedule scans
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!/setInterval\s*\([^)]*scan/i.test(server), 'server must not auto-scan');
});

// ---------------------------------------------------------------- §15 secrets
test('API keys are masked and never exposed in full', () => {
  assert.equal(maskKey('abcd1234wxyz'), '********wxyz');
  assert.equal(maskKey(null), null);
  const st = optionsProviderStatus({ OPTIONS_PROVIDER: 'uw', UNUSUAL_WHALES_API_TOKEN: 'supersecrettoken9999' });
  assert.equal(st.keyMasked, '********9999');
  assert.ok(!JSON.stringify(st).includes('supersecrettoken'));
});

// ---------------------------------------------------------------- §7 rate limits
test('no local per-minute cap is invented unless explicitly configured', () => {
  const rl = new RateLimiter({});
  assert.equal(rl.maxPerMinute, null);              // UW does not publish it; we do not guess
  for (let i = 0; i < 500; i++) rl.record();
  assert.equal(rl.canRequest().ok, true);           // only UW headers / scan budget can block
});

test('rate limiter counts, blocks and reports without guessing UW limits', () => {
  const rl = new RateLimiter({ maxPerMinute: 3, maxPerScan: 5 });
  const now = Date.now();
  for (let i = 0; i < 3; i++) { assert.equal(rl.canRequest(now).ok, true); rl.record(now); }
  const blocked = rl.canRequest(now);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'RATE_WINDOW_FULL');
  assert.equal(rl.stats().uwRemaining, null);                     // not exposed => null, not invented
  assert.equal(rl.stats().requestsThisScan, 3);
});

test('rate limiter honours UW headers when present and enforces the scan budget', () => {
  const rl = new RateLimiter({ maxPerMinute: 100, maxPerScan: 2 });
  rl.readHeaders({ get: (k) => (k === 'x-ratelimit-remaining' ? '7' : k === 'x-ratelimit-limit' ? '100' : null) });
  assert.equal(rl.remaining, 7);
  rl.record(); rl.record();
  assert.equal(rl.canRequest().reason, 'SCAN_BUDGET_EXHAUSTED');
  rl.beginScan();
  assert.equal(rl.canRequest().ok, true);
});

test('rate limiter refuses when UW quota is exhausted', () => {
  const rl = new RateLimiter({});
  rl.remaining = 0;
  assert.equal(rl.canRequest().reason, 'UW_QUOTA_EXHAUSTED');
});

test('duplicate in-flight requests are deduped into one call', async () => {
  const rl = new RateLimiter({});
  let calls = 0;
  const fn = () => { calls++; return new Promise((r) => setTimeout(() => r('x'), 10)); };
  const [a, b] = await Promise.all([rl.dedupe('k', fn), rl.dedupe('k', fn)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
});

test('backoff grows exponentially and is capped', () => {
  const rl = new RateLimiter({});
  assert.ok(rl.backoffMs(1) > rl.backoffMs(0));
  assert.ok(rl.backoffMs(20) <= 30000);
});

test('requests are prioritized: flow first, context last', () => {
  const order = prioritizeRequests([{ kind: 'context' }, { kind: 'greeks' }, { kind: 'flow' }, { kind: 'gex' }]).map((r) => r.kind);
  assert.deepEqual(order, ['flow', 'gex', 'greeks', 'context']);
});

// ---------------------------------------------------------------- §3 RVOL readiness
test('RVOL readiness reports WARMING_UP / READY / UNAVAILABLE, never a fake number', () => {
  const baselines = { history: () => new Array(4).fill(1) };
  const warming = rvolReadiness({ baselines, ticker: 'X', bucket: '09:45-10:30', rvolResult: { available: false, reason: 'insufficient_history' } });
  assert.equal(warming.state, FEATURE_STATE.WARMING_UP);
  assert.equal(warming.rvol, null);
  assert.equal(warming.observations, 4);
  assert.equal(warming.required, 10);

  const ready = rvolReadiness({ baselines, ticker: 'X', bucket: 'b', rvolResult: { available: true, rvol: 1.8 } });
  assert.equal(ready.state, FEATURE_STATE.READY);
  assert.equal(ready.rvol, 1.8);

  const un = rvolReadiness({ baselines, ticker: 'X', bucket: 'b', rvolResult: { available: false, reason: 'no_intraday_volume' } });
  assert.equal(un.state, FEATURE_STATE.UNAVAILABLE);
  assert.equal(un.reason, 'UW_INTRADAY_VOLUME_UNAVAILABLE');
  assert.equal(un.rvol, null);
});

// ---------------------------------------------------------------- §4 IV skew
test('IV-skew readiness distinguishes warming-up from unavailable', () => {
  assert.equal(ivSkewReadiness({ available: false, reason: 'no_prior_snapshot' }).state, FEATURE_STATE.WARMING_UP);
  assert.equal(ivSkewReadiness({ available: false, reason: 'insufficient_iv_data' }).reason, 'UW_IV_DATA_INSUFFICIENT');
  assert.equal(ivSkewReadiness(null).state, FEATURE_STATE.UNAVAILABLE);
  const r = ivSkewReadiness({ available: true, putCallIvSpreadChange: 0.02 });
  assert.equal(r.state, FEATURE_STATE.READY);
  assert.equal(r.ivSkewChange, 0.02);
});

// ---------------------------------------------------------------- §5 sector
test('sector relative strength uses UW sector-tide, or reports UNAVAILABLE', () => {
  const tide = { available: true, rows: [{ sector: 'Technology', net: 8e8 }, { sector: 'Energy', net: -2e8 }, { sector: 'Health', net: 1e8 }] };
  const r = sectorRelativeStrength({ ticker: 'AAPL', sector: 'Technology', sectorTide: tide });
  assert.equal(r.state, FEATURE_STATE.READY);
  assert.equal(r.sectorTrend, 'up');
  assert.ok(r.sectorRelativeStrength > 0);

  assert.equal(sectorRelativeStrength({ ticker: 'X', sector: null, sectorTide: tide }).reason, 'UW_SECTOR_UNKNOWN_FOR_TICKER');
  assert.equal(sectorRelativeStrength({ ticker: 'X', sector: 'Tech', sectorTide: null }).reason, 'UW_SECTOR_TIDE_UNAVAILABLE');
  assert.equal(sectorRelativeStrength({ ticker: 'X', sector: 'Nope', sectorTide: tide }).sectorRelativeStrength, null);
});

// ---------------------------------------------------------------- §6 macro
test('macro is UNAVAILABLE because UW exposes no calendar — and is never faked', () => {
  const m = macroReadiness({ uwSupportsMacroCalendar: false });
  assert.equal(m.state, FEATURE_STATE.UNAVAILABLE);
  assert.equal(m.reason, 'UW_ENDPOINT_UNAVAILABLE');
  assert.equal(m.macroEvent, null);
});

// ---------------------------------------------------------------- §12 promotion
test('promotion gate keeps v2 in SHADOW with no data', () => {
  const g = promotionGate(null);
  assert.equal(g.status, 'SHADOW');
  assert.equal(g.promotion, 'NOT_READY');
  assert.ok(g.checks.some((c) => c.name === 'sufficient_sample' && !c.passed));
});

test('promotion gate rejects a small in-sample win and flags suspicious IC', () => {
  const report = { byHorizon: { '30m': { n: 12, avgReturn: 3, avgMAE: -1, rankIC: { ic: 0.01 }, v2RankIC: { ic: 0.35 }, topDecile: { precision: 50 }, v2TopDecile: { precision: 90 } } } };
  const g = promotionGate(report);
  assert.equal(g.promotion, 'NOT_READY');
  assert.ok(g.checks.some((c) => c.name === 'sufficient_sample' && !c.passed));
  assert.ok(g.checks.some((c) => c.name === 'no_look_ahead_suspicion' && !c.passed));   // IC 0.35 is implausible
});

test('promotion gate never auto-promotes even when checks pass', () => {
  const report = { byHorizon: { '30m': { n: 500, avgReturn: 0.4, avgMAE: -0.8, rankIC: { ic: 0.02 }, v2RankIC: { ic: 0.05 }, topDecile: { precision: 55 }, v2TopDecile: { precision: 62 } } } };
  const g = promotionGate(report);
  assert.equal(g.status, 'SHADOW');                    // still shadow
  assert.match(g.note, /human decision/i);
});

// ---------------------------------------------------------------- §13 readiness UI payload
test('research readiness reports actual values, never placeholders', () => {
  const R = researchReadiness({ report: null, journalCount: 0 });
  assert.equal(R.signals, 0);
  assert.equal(R.resolved['30m'], 0);
  assert.equal(R.metrics.v2RankIC, null);              // null, not 0
  assert.equal(R.v2Status, 'SHADOW');
  assert.equal(R.promotion, 'NOT_READY');
  assert.equal(R.dataSource, 'UNUSUAL_WHALES_ONLY');
  assert.equal(R.features.macro, FEATURE_STATE.UNAVAILABLE);
});

// ---------------------------------------------------------------- UI must not reference removed things
test('the UI calls no removed PVE routes and shows no PVE data branding', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  for (const dead of ["api('/flow')", "api('/markets'", "api('/flow/spikes')", "api('/flow/top-traders'", "'/api/me'", '/api/archive/']) {
    assert.ok(!app.includes(dead), `frontend still calls removed route: ${dead}`);
  }
  for (const s of ['pve.trade', 'PVE.trade', 'pve_live_', 'OPTIONS_PROVIDER=pve']) {
    assert.ok(!app.includes(s) && !html.includes(s), `stale PVE reference in UI: ${s}`);
  }
});

test('the browser performs no automatic polling loop', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(!/scanTimer\s*=\s*setInterval\(\s*scan\b/.test(app), 'automatic scan polling must be removed (§1)');
});

// ---------------------------------------------------------------- Overview simulation
test('the Overview simulation makes no network calls and is labelled as simulated', () => {
  const sim = fs.readFileSync(path.join(ROOT, 'public', 'overview-sim.js'), 'utf8');
  for (const net of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', "import('./api", 'api(']) {
    assert.ok(!sim.includes(net), `the demo must not perform I/O: found ${net}`);
  }
  assert.ok(sim.includes('SIMULATED DEMO DATA'), 'demo must be labelled as simulated');
  assert.ok(sim.includes('ENGINE SIMULATION RUNNING'), 'status must say simulation');
  assert.ok(/NO network requests/i.test(sim), 'module must document that it is offline');
});

test('the Overview simulation shows losses as well as wins', () => {
  const sim = fs.readFileSync(path.join(ROOT, 'public', 'overview-sim.js'), 'utf8');
  assert.ok(sim.includes("'LOSS'") && sim.includes("'WIN'"), 'outcomes must include losing signals, not only wins');
});
