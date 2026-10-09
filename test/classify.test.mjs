// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMarket, filterMarkets, CLASSIFIER_VERSION } from '../classify.js';

const mk = (title, slug = '', tags = []) => ({ slug: slug || title.toLowerCase().replace(/\s+/g, '-'), title, tags, volume: 1000, liquidity: 500, outcomes: [{ tokenId: 't', price: 0.5, volume: 1 }] });

test('US equity: ticker in title → ALLOWED US_EQUITY', () => {
  const d = classifyMarket(mk('Will AAPL close above $250 this week?'));
  assert.equal(d.classification, 'ALLOWED'); assert.equal(d.asset_type, 'US_EQUITY'); assert.equal(d.ticker, 'AAPL');
});
test('US equity: cashtag → ALLOWED', () => {
  const d = classifyMarket(mk('Earnings beat for $NVDA?'));
  assert.equal(d.classification, 'ALLOWED'); assert.equal(d.ticker, 'NVDA');
});
test('US ETF: SPY → ALLOWED US_ETF', () => {
  const d = classifyMarket(mk('Will SPY close red today?'));
  assert.equal(d.classification, 'ALLOWED'); assert.equal(d.asset_type, 'US_ETF'); assert.equal(d.ticker, 'SPY');
});

test('crypto: bitcoin term → REJECTED CRYPTO', () => {
  const d = classifyMarket(mk('Will Bitcoin hold above $100k?'));
  assert.equal(d.classification, 'REJECTED'); assert.equal(d.asset_type, 'CRYPTO');
});
test('crypto: ticker BTC → REJECTED CRYPTO', () => {
  assert.equal(classifyMarket(mk('BTC to $150k in 2026')).asset_type, 'CRYPTO');
});
test('crypto beats equity: ETH even with "stock" phrasing → REJECTED', () => {
  const d = classifyMarket(mk('Will ETH stock-to-flow model hold?'));
  assert.equal(d.classification, 'REJECTED'); assert.equal(d.asset_type, 'CRYPTO');
});
test('politics → REJECTED POLITICS', () => {
  assert.equal(classifyMarket(mk('Who wins the presidential election?')).asset_type, 'POLITICS');
});
test('sports → REJECTED SPORTS', () => {
  assert.equal(classifyMarket(mk('Will the Chiefs win the Super Bowl?')).asset_type, 'SPORTS');
});
test('weather → REJECTED WEATHER', () => {
  assert.equal(classifyMarket(mk('Will NYC temperature exceed 100 degrees?')).asset_type, 'WEATHER');
});

test('ambiguous: equity phrasing, no known ticker → REJECTED UNKNOWN', () => {
  const d = classifyMarket(mk('Will this stock make a new all-time high?'));
  assert.equal(d.classification, 'REJECTED'); assert.equal(d.asset_type, 'UNKNOWN');
});
test('ambiguous: unrelated → REJECTED UNKNOWN', () => {
  assert.equal(classifyMarket(mk('Will aliens be confirmed this year?')).classification, 'REJECTED');
});
test('short ticker without cashtag does NOT false-match', () => {
  // "F" (Ford) must not match the bare letter F inside ordinary text
  const d = classifyMarket(mk('Will the F rating change for this bond?'));
  assert.equal(d.classification, 'REJECTED');
});

test('mixed PVE response → ONLY US stocks/ETFs pass', () => {
  const markets = [
    mk('Will AAPL close above $250 this week?', 'aapl-250'),
    mk('Will TSLA beat earnings?', 'tsla-earn'),
    mk('Will SPY close red today?', 'spy-red'),
    mk('Will Bitcoin hold above $100k?', 'btc-100k'),
    mk('ETH/BTC ratio to rise?', 'eth-flip'),
    mk('Who wins the presidential election?', 'election'),
    mk('Will the Lakers win the NBA title?', 'nba'),
    mk('Will it rain in Seattle tomorrow?', 'weather-sea'),
    mk('Will some random thing happen?', 'random'),
  ];
  const { allowed, rejected, stats } = filterMarkets(markets);
  const slugs = allowed.map((m) => m.slug).sort();
  assert.deepEqual(slugs, ['aapl-250', 'spy-red', 'tsla-earn']);
  assert.equal(stats.received, 9); assert.equal(stats.accepted, 3); assert.equal(stats.rejected, 6);
  assert.ok(allowed.every((m) => m.asset_type === 'US_EQUITY' || m.asset_type === 'US_ETF'));
  assert.ok(rejected.some((r) => r.asset_type === 'CRYPTO'));
  assert.equal(stats.version, CLASSIFIER_VERSION);
});

test('allowed markets carry asset_type + ticker + classification for downstream', () => {
  const { allowed } = filterMarkets([mk('Will MSFT hit a new high?', 'msft')]);
  assert.equal(allowed[0].asset_type, 'US_EQUITY');
  assert.equal(allowed[0].ticker, 'MSFT');
  assert.equal(allowed[0].classification.classification, 'ALLOWED');
});
