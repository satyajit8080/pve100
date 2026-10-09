// Run: node --test  (integration test: boots the server on a test port with a stubbed UW)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Capture the REAL fetch for our own HTTP client calls, then stub PVE for the server.
const real = globalThis.fetch;
const EARN_DATE = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10); // always 'approaching'
const J = (o) => ({ ok: true, status: 200, json: async () => o });
const chain = { data: [
  { right: 'call', strike: 450, expiry: '2026-09-18', volume: 3000, open_interest: 2000, implied_volatility: 0.46, delta: 0.52, gamma: 0.05, theta: -0.01, vega: 0.1, bid: 2, ask: 2.1 },
  { right: 'put', strike: 450, expiry: '2026-09-18', volume: 2500, open_interest: 1800, implied_volatility: 0.42, delta: -0.48, gamma: 0.05, theta: -0.01, vega: 0.1, bid: 1.9, ask: 2.0 },
], meta: { spot: 450, available_expirations: ['2026-09-18'] } };
const gex = { data: { net_gex: 1.2e9, net_vanna: 1e7, net_charm: -2e6, gamma_flip: 442, call_wall: 460, put_wall: 440 } };
const ohlc = { data: Array.from({ length: 30 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, high: 101 + i, low: 99 + i, close: 100 + i })) };
const screener = { data: [
  { ticker: 'AAPL', premium: 9e6, net_premium: 5e6, sweeps: 20, blocks: 3, trades: 400 },
  { ticker: 'NVDA', premium: 1.2e7, net_premium: 8e6, sweeps: 35, blocks: 5, trades: 800 },
  { ticker: 'XOM', premium: 3e6, net_premium: -2e6, sweeps: 8, blocks: 1, trades: 120 },
] };
const topiv = { data: [{ ticker: 'NVDA', iv_rank: 92 }, { ticker: 'AAPL', iv_rank: 60 }, { ticker: 'XOM', iv_rank: 35 }] };
const companies = { data: [{ ticker: 'AAPL', sector: 'Technology' }, { ticker: 'NVDA', sector: 'Technology' }, { ticker: 'XOM', sector: 'Energy' }] };

globalThis.fetch = async (u, o) => {
  const s = String(u);
  if (s.includes('127.0.0.1') || s.includes('localhost')) return real(u, o);   // our own client calls
  // --- UW-shaped routes (the only supported provider) ---
  if (s.includes('/stock-state')) return J({ data: { close: '450', prev_close: '445', volume: '5000000', market_time: 'r' } });
  if (s.includes('/option-contracts')) return J({ data: [
    { option_symbol: 'AAPL260918C00450000', volume: 3000, open_interest: 2000, implied_volatility: 0.46, delta: 0.52, gamma: 0.05, theta: -0.01, vega: 0.1, nbbo_bid: 2, nbbo_ask: 2.1, last_price: 2.05 },
    { option_symbol: 'AAPL260918P00450000', volume: 2500, open_interest: 1800, implied_volatility: 0.42, delta: -0.48, gamma: 0.05, theta: -0.01, vega: 0.1, nbbo_bid: 1.9, nbbo_ask: 2.0, last_price: 1.95 },
  ] });
  if (s.includes('/greek-exposure/strike')) return J({ data: [{ date: '2026-08-24', strike: 449, call_gex: 3, put_gex: -1 }, { date: '2026-08-24', strike: 451, call_gex: 4, put_gex: -2 }] });
  if (s.includes('/greek-exposure')) return J({ data: [{ date: '2026-08-24', call_gamma: 1.2e9, put_gamma: -2e8, call_delta: 1e7, put_delta: -2e6, call_vanna: 1e6, put_vanna: -1e5, call_charm: 1e5, put_charm: -1e4 }] });
  if (s.includes('/flow-alerts')) return J({ data: [{ ticker: 'AAPL', total_premium: '3000000', total_size: '1500', right: 'call', all_opening_trades: true, has_sweep: true, alert_rule: 'RepeatedHits', total_ask_side_prem: '2800000', total_bid_side_prem: '200000', expiry: '2026-09-18', underlying_price: '450', strike: '460' }] });
  if (s.includes('/net-prem-ticks')) return J({ data: [{ net_call_premium: '9000000', net_put_premium: '4000000' }] });
  if (s.includes('/historical-risk-reversal-skew')) return J({ data: [{ risk_reversal: 0.02 }] });
  if (s.includes('/volatility/term-structure')) return J({ data: [{ dte: 30, volatility: 0.45 }, { dte: 90, volatility: 0.43 }] });
  if (s.includes('/oi-change')) return J({ data: [{ option_symbol: 'AAPL260918C00450000', curr_oi: 2000, prev_oi: 1500, oi_diff_plain: 500 }] });
  if (s.includes('/info')) return J({ data: { sector: 'Technology', full_name: 'Apple Inc', next_earnings_date: EARN_DATE } });
  if (s.includes('/screener/stocks')) return J({ data: [
    { ticker: 'AAPL', sector: 'Technology', full_name: 'Apple', iv_rank: 60, call_premium: '9000000', put_premium: '3000000', net_call_premium: '5000000', net_put_premium: '1000000', marketcap: '3e12' },
    { ticker: 'NVDA', sector: 'Technology', full_name: 'Nvidia', iv_rank: 92, call_premium: '1.2e7', put_premium: '4000000', net_call_premium: '8000000', net_put_premium: '1000000', marketcap: '3e12' },
  ] });
  if (s.includes('/market/sector-tide')) return J({ data: [{ sector: 'Technology', net_premium: 8e8 }, { sector: 'Energy', net_premium: -2e8 }] });
  if (s.includes('/market/market-tide')) return J({ data: { net_call_premium: 1.1e9, net_put_premium: 3e8 } });
  if (s.includes('/earnings/ticker/')) return J({ data: { next_report_date: EARN_DATE } });
  if (s.includes('/volatility/top/iv-rank')) return J(topiv);
  if (s.includes('/companies')) return J(companies);
  if (s.includes('/market/tide/sectors')) return J({ data: [{ sector: 'Technology', net_premium: 8e8 }] });
  if (s.includes('/screener')) return J(screener);
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

process.env.PORT = '4288'; process.env.DASHBOARD_PASSWORD = 'x'; process.env.OPTIONS_PROVIDER = 'uw'; process.env.OPTIONS_API_KEY = 'pve_live_SECRET'; process.env.UNUSUAL_WHALES_API_TOKEN = 'uw_live_SECRET'; process.env.OPENROUTER_API_KEY = '';
const { httpServer } = await import('../server.js');
after(() => { try { httpServer.close(); } catch {} });
await new Promise((r) => setTimeout(r, 300));
const B = 'http://127.0.0.1:4288';
const login = await real(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const G = async (p) => (await real(B + p, { headers: { cookie } })).json();
const liveScore = async () => { const j = await G('/api/options/AAPL'); return { score: j.signal.finalScore, dir: j.signal.dir, tier: j.signal.tier }; };

test('Phase 2 endpoints return data without touching the live score', async () => {
  await liveScore(); await liveScore();                 // warm the pre-existing optCache rolling history
  const before = await liveScore();
  const mkt = await G('/api/shadow/market');
  const xs = await G('/api/shadow/cross-section');
  const sh = await G('/api/shadow/AAPL');
  const after = await liveScore();

  // THE BOUNDARY: identical live score/dir/tier before and after all Phase 2 calls.
  assert.deepEqual(after, before, 'Phase 2 must not change /api/options');

  // sanity: the Phase 2 endpoints actually produced real, correct shadow output
  assert.equal(mkt.ok, true); assert.equal(mkt.regime.gexRegime, 'positive');
  assert.equal(xs.ok, true); assert.equal(xs.available, true);
  assert.equal(xs.ranked[0].ticker, 'NVDA');            // highest notability
  assert.equal(xs.sectors.Technology.dominant, 'bullish');
  assert.equal(sh.shadow.crossSectional.inUniverse, true);
  assert.equal(sh.shadow.sectorBreadth.sector, 'Technology');
  assert.equal(sh.shadow.earnings.proximity, 'approaching');

  // no secret leak anywhere in the Phase 2 responses
  const blob = JSON.stringify(mkt) + JSON.stringify(xs) + JSON.stringify(sh);
  assert.ok(!/pve_live_|SECRET|Bearer|sk-or-/.test(blob));
});

test('cross-section ranks are relative (percentiles ordered by notability)', async () => {
  const xs = await G('/api/shadow/cross-section');
  const comps = xs.ranked.map((r) => r.composite);
  for (let i = 1; i < comps.length; i++) assert.ok(comps[i - 1] >= comps[i], 'ranked list must be sorted desc by composite');
});
