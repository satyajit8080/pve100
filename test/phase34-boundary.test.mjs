// Run: node --test  (integration: boots the server on a test port with stubbed PVE)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { labelMultiHorizon } from '../research/labeler.js';

const real = globalThis.fetch;
const J = (o) => ({ ok: true, status: 200, json: async () => o });
const chain = { data: [
  { right: 'call', strike: 450, expiry: '2026-09-18', volume: 3000, open_interest: 2000, implied_volatility: 0.46, delta: 0.52, gamma: 0.05, theta: -0.01, vega: 0.1, bid: 2, ask: 2.1 },
  { right: 'put', strike: 450, expiry: '2026-09-18', volume: 2500, open_interest: 1800, implied_volatility: 0.42, delta: -0.48, gamma: 0.05, theta: -0.01, vega: 0.1, bid: 1.9, ask: 2.0 },
], meta: { spot: 450, available_expirations: ['2026-09-18'] } };
const gex = { data: { net_gex: 1.2e9, net_vanna: 1e7, net_charm: -2e6, gamma_flip: 442, call_wall: 460, put_wall: 440 } };
const ohlc = { data: Array.from({ length: 30 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, high: 101 + i, low: 99 + i, close: 100 + i })) };
const screener = { data: [{ ticker: 'AAPL', premium: 9e6, net_premium: 5e6, sweeps: 20 }, { ticker: 'NVDA', premium: 1.2e7, net_premium: 8e6, sweeps: 35 }] };

globalThis.fetch = async (u, o) => {
  const s = String(u);
  if (s.includes('127.0.0.1') || s.includes('localhost')) return real(u, o);
  if (s.includes('/earnings/ticker/')) return J({ data: { next_report_date: '2026-08-27' } });
  if (s.includes('/volatility/top/iv-rank')) return J({ data: [{ ticker: 'NVDA', iv_rank: 92 }, { ticker: 'AAPL', iv_rank: 60 }] });
  if (s.includes('/companies')) return J({ data: [{ ticker: 'AAPL', sector: 'Technology' }, { ticker: 'NVDA', sector: 'Technology' }] });
  if (s.includes('/screener')) return J(screener);
  if (s.includes('/stock-state')) return J({ data: { close: '450', prev_close: '445', volume: '5000000' } });
  if (s.includes('/option-contracts')) return J({ data: [
    { option_symbol: 'AAPL260918C00450000', volume: 3000, open_interest: 2000, implied_volatility: 0.46, delta: 0.52, gamma: 0.05, nbbo_bid: 2, nbbo_ask: 2.1 },
    { option_symbol: 'AAPL260918P00450000', volume: 2500, open_interest: 1800, implied_volatility: 0.42, delta: -0.48, gamma: 0.05, nbbo_bid: 1.9, nbbo_ask: 2.0 },
  ] });
  if (s.includes('/greek-exposure/strike')) return J({ data: [{ date: '2026-08-24', strike: 449, call_gex: 3, put_gex: -1 }] });
  if (s.includes('/greek-exposure')) return J({ data: [{ date: '2026-08-24', call_gamma: 1.2e9, put_gamma: -2e8, call_delta: 1e7, put_delta: -2e6 }] });
  if (s.includes('/flow-alerts')) return J({ data: [{ ticker: 'AAPL', total_premium: '3000000', total_size: '1500', right: 'call', all_opening_trades: true, has_sweep: true, total_ask_side_prem: '2800000', total_bid_side_prem: '200000' }] });
  if (s.includes('/net-prem-ticks')) return J({ data: [{ net_call_premium: '9000000', net_put_premium: '4000000' }] });
  if (s.includes('/contracts')) return J(chain);
  if (s.includes('/by-strike')) return J({ data: [{ strike: 449, net_gex: 3 }, { strike: 451, net_gex: 4 }] });
  if (s.includes('/iv-rank')) return J({ data: { iv_rank: 60, iv_percentile: 70, current_iv: 0.45 } });
  if (s.includes('/skew')) return J({ data: { skew_25: 0.02, percentile: 40 } });
  if (s.includes('/term-structure')) return J({ data: { slope_30_90: -0.02 } });
  if (s.includes('/flow/ticker/')) return J({ data: [{ right: 'call', premium: 3e6, size: 1500, is_opening: true, is_golden_sweep: true, trade_type: 'Sweep', direction: 'buy', dte: 25, otm_percent: 4, open_interest: 1200 }] });
  if (s.includes('/flow/unusual')) return J({ data: [{ right: 'call', premium: 2.1e6, is_golden_sweep: true }] });
  if (s.includes('/net-premium')) return J({ meta: { total_net_premium: 5e6, total_bullish_premium: 9e6, total_bearish_premium: 3e6 } });
  if (s.includes('/darkpool')) return J({ data: { dark_pool_index: 45 } });
  if (s.includes('/market/tide')) return J({ meta: { total_net_premium: 1.1e9 } });
  if (s.includes('/ohlc')) return J(ohlc);
  if (s.includes('/profile')) return J({ data: { price: 450, volume: 5e6, prev_close: 445 } });
  if (s.includes('/gex/')) return J(gex);
  return J({ data: [] });
};

process.env.PORT = '4289'; process.env.DASHBOARD_PASSWORD = 'x'; process.env.OPTIONS_PROVIDER = 'uw'; process.env.OPTIONS_API_KEY = 'pve_live_SECRET'; process.env.UNUSUAL_WHALES_API_TOKEN = 'uw_live_SECRET'; process.env.OPENROUTER_API_KEY = '';
const { httpServer } = await import('../server.js');
after(() => { try { httpServer.close(); } catch {} });
await new Promise((r) => setTimeout(r, 300));
const B = 'http://127.0.0.1:4289';
const cookie = (await real(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x' }) })).headers.get('set-cookie').split(';')[0];
const G = async (p) => (await real(B + p, { headers: { cookie } })).json();
const liveScore = async () => { const j = await G('/api/options/AAPL'); return { score: j.signal.finalScore, dir: j.signal.dir, tier: j.signal.tier }; };

test('A/F: Phase 4 endpoints do not change /api/options; current score stays available', async () => {
  await liveScore(); await liveScore();
  const before = await liveScore();
  const v1 = await G('/api/validated/AAPL');
  const rank = await G('/api/validated/ranking');
  const after = await liveScore();
  assert.deepEqual(after, before, 'validated endpoints must not change the live score');
  assert.ok(isFinite(before.score));                        // F: current score present
  assert.equal(v1.ok, true); assert.ok(isFinite(v1.current.score));
  assert.equal(rank.ok, true);
  // regression guard: /api/validated/ranking must return the RANKING shape (ranked[]), not a
  // per-ticker signal — catches the route-ordering bug where :ticker captures "ranking".
  assert.ok(Array.isArray(rank.ranked), 'validated/ranking must return a ranked array, not a per-ticker signal');
  assert.equal(rank.validated, undefined, 'ranking response must not look like a per-ticker validated response');
});

test('B: validated scoring is deterministic across calls', async () => {
  const a = await G('/api/validated/AAPL'); const b = await G('/api/validated/AAPL');
  assert.deepEqual(a.validated, b.validated);
});

test('G: with empty promotion, validated uses ONLY approved features (none) → mirrors current, delta 0', async () => {
  const v = await G('/api/validated/AAPL');
  assert.equal(v.validated.validatedScore, v.current.score);
  assert.equal(v.validated.delta, 0);
  assert.deepEqual(v.validated.usedFeatures, []);
  assert.equal(v.validated.components.length, 1);           // baseline only
  assert.equal(v.validated.components[0].name, 'baseline (current score)');
  assert.deepEqual(v.promotion.approvedFeatures, []);
});

test('H: calibrated probability hidden when calibration is not validated', async () => {
  const v = await G('/api/validated/AAPL');
  assert.equal(v.validated.probabilityShown, false);
  assert.equal(v.validated.calibratedProbability, null);
});

test('D: missing PVE fields cannot fabricate a validated value (no NaN; usedFeatures ⊆ approved)', async () => {
  const v = await G('/api/validated/ZZZZ');                 // sparse ticker (stub returns empty for most)
  assert.equal(v.ok, true);
  const s = v.validated.validatedScore;
  assert.ok(s === null || Number.isFinite(s), 'validated score must be null or finite, never NaN');
  for (const f of v.validated.usedFeatures) assert.ok((v.promotion.approvedFeatures || []).includes(f));
});

test('E: no secret leakage in Phase 4 responses', async () => {
  const blob = JSON.stringify(await G('/api/validated/AAPL')) + JSON.stringify(await G('/api/validated/ranking')) + JSON.stringify(await G('/api/_monitor'));
  assert.ok(!/pve_live_|SECRET|Bearer|sk-or-/.test(blob));
});

test('C: AI analyze does not change the live score (advisory only) — re-assert alongside Phase 4', async () => {
  const before = await liveScore();
  await G('/api/ai/analyze/AAPL').catch(() => null);        // AI disabled in this env → no-op, but must not change score
  const after = await liveScore();
  assert.deepEqual(after, before);
});

test('I: forward labeling ignores the entry bar (no historical/future leakage into signal window)', () => {
  const bars = [{ date: '2026-08-17', high: 200, low: 1, close: 100 }, { date: '2026-08-18', high: 103, low: 99, close: 102 }, { date: '2026-08-19', high: 104, low: 101, close: 103 }];
  const r = labelMultiHorizon({ bars, entryIndex: 0, direction: 'bull', horizons: [2] });
  // entry bar's extreme high(200)/low(1) must NOT appear in MFE/MAE
  assert.ok(r.byHorizon[2].mfePct < 50 && r.byHorizon[2].maePct > -50);
});

test('monitor exposes validated model + promotion status (current primary)', async () => {
  const m = await G('/api/_monitor');
  assert.ok(m.validatedModelVersion);
  assert.equal(m.validated.primary, 'current');
  assert.equal(m.validated.promotedFeatures, 0);
});
