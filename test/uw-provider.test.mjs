// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnusualWhalesOptionsProvider } from '../providers/unusualwhales.js';

// Stub fetch so we test the normalization SHAPE (not live UW). Routes by path substring.
function withStub(routes, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [frag, body] of Object.entries(routes)) if (u.includes(frag)) return { ok: true, status: 200, json: async () => body };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = real; });
}
const P = new UnusualWhalesOptionsProvider({ apiKey: 'uw_test' });

test('getUnderlying → {price,prevClose,volume,available}', async () => {
  await withStub({ '/stock-state': { data: { close: 191.2, prev_close: 188.0, volume: 1000000 } } }, async () => {
    const u = await P.getUnderlying('NVDA');
    assert.equal(u.available, true);
    assert.equal(u.underlying.price, 191.2);
    assert.equal(u.underlying.prevClose, 188);
    assert.equal(u.underlying.volume, 1000000);
  });
});

test('getChain → normalized contracts + fieldsAvailable + merged flow', async () => {
  await withStub({
    '/stock-state': { data: { close: 191, prev_close: 188, volume: 5e6 } },
    '/option-contracts': { data: [
      { option_symbol: 'NVDA260417C00190000', bid: 5.0, ask: 5.2, volume: 1200, open_interest: 3400, implied_volatility: 0.42, gamma: 0.03 },
      { option_symbol: 'NVDA260417P00185000', bid: 3.0, ask: 3.2, volume: 800, open_interest: 2100, implied_volatility: 0.4, gamma: 0.02 },
    ] },
    '/flow-alerts': { data: [{ type: 'call', total_premium: 250000, total_size: 500, side: 'ask', is_golden_sweep: true, is_opening: true, dte: 30, open_interest: 3400 }] },
  }, async () => {
    const r = await P.getChain('NVDA');
    assert.equal(r.available, true);
    assert.equal(r.chain.contracts.length, 2);
    const c = r.chain.contracts[0];
    assert.deepEqual([c.type, c.strike, c.expiration], ['call', 190, '2026-04-17']); // parsed from OCC symbol
    assert.equal(c.mid, 5.1);
    assert.equal(r.chain.fieldsAvailable.greeks, true);
    assert.equal(r.chain.fieldsAvailable.oi, true);
    assert.equal(r.chain.fieldsAvailable.sweeps, true);              // flow merged
    assert.equal(r.chain.flow.largeTrades.length, 1);
    assert.equal(r.chain.underlying.price, 191);
  });
});

test('getGex → net_gex / net_dex from latest greek-exposure', async () => {
  await withStub({ '/greek-exposure': { data: [{ date: '2026-03-15', call_gamma: '3e6', put_gamma: '-1e6', call_delta: '4e5', put_delta: '-1e5' }, { date: '2026-03-16', call_gamma: '7e6', put_gamma: '-2.08e6', call_delta: '9e5', put_delta: '-2e5' }] } }, async () => {
    const g = await P.getGex('NVDA');
    assert.equal(g.available, true);
    assert.equal(g.net_gex, 7e6 - 2.08e6);  // call_gamma+put_gamma of latest
    assert.equal(g.net_dex, 9e5 - 2e5);
  });
});

test('getIvRank → {iv_rank,iv_percentile,current_iv}', async () => {
  await withStub({ '/iv-rank': { data: [{ date: '2026-03-16', iv_rank_1y: '55', volatility: '0.41' }] } }, async () => {
    const r = await P.getIvRank('NVDA');
    assert.equal(r.available, true);
    assert.deepEqual([r.iv_rank, r.current_iv], [55, 0.41]);
  });
});

test('getOhlc → daily bars', async () => {
  await withStub({ '/ohlc/': { data: [{ date: '2026-03-16', open: 188, high: 193, low: 187, close: 191, volume: 5e6 }] } }, async () => {
    const r = await P.getOhlc('NVDA');
    assert.equal(r.available, true);
    assert.deepEqual({ date: r.bars[0].date, open: r.bars[0].open, high: r.bars[0].high, low: r.bars[0].low, close: r.bars[0].close, volume: r.bars[0].volume }, { date: '2026-03-16', open: 188, high: 193, low: 187, close: 191, volume: 5e6 });
  });
});

test('getNetPremium → aggregates ticks into totals', async () => {
  await withStub({ '/net-prem-ticks': { data: [{ net_call_premium: '1e6', net_put_premium: '2e5' }, { net_call_premium: '5e5', net_put_premium: '1e5' }] } }, async () => {
    const r = await P.getNetPremium('NVDA');
    assert.equal(r.available, true);
    assert.equal(r.total_net_premium, (1e6 + 5e5) - (2e5 + 1e5)); // bull - bear
    assert.equal(r.total_trades, 2);
  });
});

test('getFlowDetailed → trades[] shaped for computeFlowQuality', async () => {
  await withStub({ '/flow-alerts': { data: [{ type: 'put', total_premium: '90000', total_size: 300, has_sweep: true, all_opening_trades: true, expiry: '2026-04-17', strike: '185', underlying_price: '190', total_ask_side_prem: '10000', total_bid_side_prem: '80000' }] } }, async () => {
    const r = await P.getFlowDetailed('NVDA');
    assert.equal(r.available, true);
    assert.equal(r.trades[0].right, 'put');
    assert.equal(r.trades[0].premium, 90000);
  });
});

test('getIntraday → session VWAP from 5m candles', async () => {
  await withStub({ '/ohlc/5m': { data: [
    { start_time: '2026-08-24T13:30:00Z', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    { start_time: '2026-08-24T13:35:00Z', open: 100, high: 103, low: 100, close: 102, volume: 3000 },
    { start_time: '2026-08-23T19:55:00Z', open: 90, high: 91, low: 89, close: 90, volume: 500 },
  ] } }, async () => {
    const r = await P.getIntraday('NVDA');
    assert.equal(r.available, true);
    // only 2026-08-24 bars count; VWAP = (100*1000 + (103+100+102)/3*3000)/(1000+3000)
    const tp2 = (103 + 100 + 102) / 3;
    const expected = (100 * 1000 + tp2 * 3000) / 4000;
    assert.ok(Math.abs(r.vwap - expected) < 0.01, `vwap ${r.vwap} vs ${expected}`);
    assert.equal(r.sessionDate, '2026-08-24');
    assert.equal(r.bars, 2);
  });
});

test('getOiChange → net call/put OI change (activates oiChange feature)', async () => {
  await withStub({ '/oi-change': { data: [
    { option_symbol: 'NVDA261218C00019000', curr_oi: 5000, prev_oi: 3000, oi_diff_plain: 2000 },
    { option_symbol: 'NVDA261218P00019000', curr_oi: 1000, prev_oi: 1500, oi_diff_plain: -500 },
    { option_symbol: 'BAD', curr_oi: 1, prev_oi: 0 },
  ] } }, async () => {
    const r = await P.getOiChange('NVDA');
    assert.equal(r.available, true);
    assert.equal(r.callOIChange, 2000);
    assert.equal(r.putOIChange, -500);
    assert.equal(r.netOIChange, 2500);
    assert.equal(r.contracts, 2);          // malformed symbol skipped, never fabricated
  });
});

test('graceful degradation: non-OK response → { available:false }, never throws', async () => {
  const real = globalThis.fetch; globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  try {
    assert.equal((await P.getGex('X')).available, false);
    assert.equal((await P.getIvRank('X')).available, false);
    assert.equal((await P.getChain('X')).available, false);           // returns empty chain, not a throw
    assert.equal((await P.getUnderlying('X')).available, false);
  } finally { globalThis.fetch = real; }
});

test('provider identity + no key leakage in shape', () => {
  assert.equal(P.name, 'uw');
  assert.equal(P.baseUrl, 'https://api.unusualwhales.com');
});
