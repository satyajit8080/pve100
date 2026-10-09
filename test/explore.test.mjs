// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorizeMarkets, filterMarkets, ASSET_CATEGORIES } from '../classify.js';

const mk = (title, slug, tags = []) => ({ slug, title, tags, volume: 1000, liquidity: 500, outcomes: [{ tokenId: slug + '__y', price: 0.5, volume: 1 }] });

const mixed = [
  mk('Will AAPL close above $250?', 'aapl'),
  mk('Will TSLA beat earnings?', 'tsla'),
  mk('Will SPY close red today?', 'spy'),
  mk('Will Bitcoin hold above $100k?', 'btc'),
  mk('ETH/BTC ratio to rise?', 'eth'),
  mk('Who wins the presidential election?', 'election'),
  mk('Will the Lakers win the NBA title?', 'nba'),
  mk('Will it rain in Seattle tomorrow?', 'weather'),
  mk('Will aliens be confirmed this year?', 'other'),
];

test('EXPLORER: categorizeMarkets buckets ALL PVE market types', () => {
  const { byCategory, counts, total } = categorizeMarkets(mixed);
  assert.equal(total, 9);
  assert.equal(counts.US_EQUITY, 2);          // AAPL, TSLA
  assert.equal(counts.US_ETF, 1);             // SPY
  assert.equal(counts.CRYPTO, 2);             // BTC, ETH
  assert.equal(counts.POLITICS, 1);
  assert.equal(counts.SPORTS, 1);
  assert.equal(counts.WEATHER, 1);
  assert.equal(counts.UNKNOWN, 1);            // aliens
  assert.ok(byCategory.CRYPTO.some((m) => m.slug === 'btc'));
});

test('SEPARATION: crypto/politics/sports are visible in Explorer but flagged NOT engine-eligible', () => {
  const { byCategory } = categorizeMarkets(mixed);
  for (const cat of ['CRYPTO', 'POLITICS', 'SPORTS', 'WEATHER', 'UNKNOWN']) {
    assert.ok(byCategory[cat].every((m) => m.engineEligible === false), `${cat} must not be engine-eligible`);
    assert.equal(ASSET_CATEGORIES[cat].engine, false);
  }
});

test('SEPARATION: US stocks/ETFs are engine-eligible in Explorer', () => {
  const { byCategory } = categorizeMarkets(mixed);
  assert.ok(byCategory.US_EQUITY.every((m) => m.engineEligible === true));
  assert.ok(byCategory.US_ETF.every((m) => m.engineEligible === true));
});

test('SIGNAL ENGINE: same mixed input → ONLY US equity/ETF enter (crypto/politics/sports rejected)', () => {
  const { allowed } = filterMarkets(mixed);
  const slugs = allowed.map((m) => m.slug).sort();
  assert.deepEqual(slugs, ['aapl', 'spy', 'tsla']);                 // no btc/eth/election/nba/weather/other
  assert.ok(allowed.every((m) => m.asset_type === 'US_EQUITY' || m.asset_type === 'US_ETF'));
});

test('CONSISTENCY: engine-allowed set == Explorer engine-eligible set', () => {
  const engineSlugs = filterMarkets(mixed).allowed.map((m) => m.slug).sort();
  const { byCategory } = categorizeMarkets(mixed);
  const eligible = Object.values(byCategory).flat().filter((m) => m.engineEligible).map((m) => m.slug).sort();
  assert.deepEqual(eligible, engineSlugs);
});
