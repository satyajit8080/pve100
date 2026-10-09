// Run: node --test — consolidated production-boundary proofs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { categorizeMarkets, filterMarkets, ASSET_CATEGORIES } from '../classify.js';
import { buildSignal } from '../public/engine.js';
import { combineScores, buildOptionsSignal, aggregateChain } from '../public/options-engine.js';
import { NullOptionsProvider } from '../providers/options.js';

const mk = (title, slug, tags = []) => ({ slug, title, tags, volume: 1000, liquidity: 500, outcomes: [{ tokenId: slug + '__y', price: 0.5, volume: 1 }] });
const mixed = [
  mk('Will AAPL close above $250?', 'aapl'), mk('Will TSLA beat earnings?', 'tsla'), mk('Will SPY close red?', 'spy'),
  mk('Will Bitcoin hold $100k?', 'btc'), mk('ETH to flip?', 'eth'), mk('Who wins the presidential election?', 'pol'),
  mk('Will the Lakers win the NBA title?', 'nba'), mk('Will NYC temperature exceed 100 degrees?', 'wx'), mk('Will aliens be confirmed?', 'oth'),
];

// ---- 1. Explorer sees all; Engine sees only US ----
test('BOUNDARY: Explorer sees ALL PVE categories', () => {
  const { counts } = categorizeMarkets(mixed);
  assert.ok(counts.US_EQUITY >= 2 && counts.US_ETF >= 1 && counts.CRYPTO >= 2 && counts.POLITICS >= 1 && counts.SPORTS >= 1 && counts.WEATHER >= 1);
});
test('BOUNDARY: Signal Engine receives ONLY US_EQUITY/US_ETF', () => {
  const { allowed } = filterMarkets(mixed);
  assert.deepEqual(allowed.map((m) => m.slug).sort(), ['aapl', 'spy', 'tsla']);
  assert.ok(allowed.every((m) => m.asset_type === 'US_EQUITY' || m.asset_type === 'US_ETF'));
});
test('BOUNDARY: crypto/politics/sports/weather/other CANNOT reach scoring', () => {
  const engineSlugs = new Set(filterMarkets(mixed).allowed.map((m) => m.slug));
  for (const s of ['btc', 'eth', 'pol', 'nba', 'wx', 'oth']) assert.equal(engineSlugs.has(s), false, `${s} must be excluded`);
  // and flagged not engine-eligible in the Explorer
  const { byCategory } = categorizeMarkets(mixed);
  for (const cat of ['CRYPTO', 'POLITICS', 'SPORTS', 'WEATHER', 'OTHER', 'UNKNOWN']) {
    assert.ok((byCategory[cat] || []).every((m) => m.engineEligible === false));
    assert.equal(ASSET_CATEGORIES[cat].engine, false);
  }
});

// ---- 2. Explorer cannot mutate inputs or influence scoring ----
test('BOUNDARY: categorizeMarkets does NOT mutate caller market objects', () => {
  const one = mk('Will NVDA rip?', 'nvda');
  const before = JSON.stringify(one);
  categorizeMarkets([one]);
  assert.equal(JSON.stringify(one), before);           // unchanged
  assert.equal('asset_type' in one, false);            // no field injected into caller's object
});
test('BOUNDARY: running the Explorer has NO effect on engine scoring (no shared state)', () => {
  const m = { slug: 'aapl', title: 'AAPL', tags: ['AAPL'], volume: 10000, liquidity: 5000, asset_type: 'US_EQUITY', ticker: 'AAPL', outcomes: [{ tokenId: 'aapl__YES', price: 0.6, volume: 6000 }, { tokenId: 'aapl__NO', price: 0.4, volume: 4000 }] };
  const deep = { series: [{ t: 1, price: 0.5 }, { t: 2, price: 0.55 }, { t: 3, price: 0.6 }], ob: { imbalance: 0.3, bidDepth: 6000, askDepth: 3000, mid: 0.6 } };
  const ctx = { spikes: [{ slug: 'aapl', magnitude: 3, direction: 1 }], traders: [], volMed: 5000, liqMed: 5000, snapshotTs: 1e12, marketHist: {} };
  const a = buildSignal(m, deep, ctx, 1e12).signal.score;
  categorizeMarkets(mixed); filterMarkets(mixed);       // exercise explorer + filter in between
  const b = buildSignal(m, deep, ctx, 1e12).signal.score;
  assert.equal(a, b);
});

// ---- 3. No fabricated options data ----
test('BOUNDARY: NullOptionsProvider → insufficient, never fabricates', async () => {
  const { chain } = await new NullOptionsProvider().getChain('AAPL');
  const sig = buildOptionsSignal(chain);
  assert.equal(sig.insufficient, true);
  assert.equal(sig.dataQualityStatus, 'UNAVAILABLE');
});
test('BOUNDARY: missing greeks/iv/quotes → unavailable (GEX/IV/spread null, not invented)', () => {
  const bare = { ticker: 'X', underlying: { price: 100, available: true }, contracts: [{ type: 'call', strike: 100, expiration: '2026-09-18', volume: 10, openInterest: 50 }], fieldsAvailable: { chain: true, oi: true, underlying: true, greeks: false, iv: false, quotes: false } };
  const a = aggregateChain(bare);
  assert.equal(a.gex, null); assert.equal(a.atmIV, null); assert.equal(a.avgSpread, null);
  const sig = buildOptionsSignal(bare);
  assert.equal(sig.dataAvailability.greeks, false);
  assert.equal(sig.dataAvailability.sweeps, undefined === sig.dataAvailability.sweeps ? sig.dataAvailability.sweeps : false); // never true
});

// ---- 4. PVE cannot reverse options/stock direction ----
for (const dir of ['bull', 'bear']) {
  test(`BOUNDARY: PVE opposite @100 does NOT reverse ${dir} primary (only lowers score, within floor)`, () => {
    const base = { optionsScore: 85, optionsDir: dir, stockScore: 70, stockDir: dir, dataQuality: 100 };
    const none = combineScores({ ...base, predictionMarketScore: null });
    const opp = combineScores({ ...base, predictionMarketScore: 100, predictionMarketDir: dir === 'bull' ? 'bear' : 'bull' });
    assert.equal(opp.dir, dir);                    // direction NEVER flips
    assert.ok(opp.finalScore < none.finalScore);   // disagreement reduces
    assert.ok(opp.pveFactor >= 0.8);               // bounded — PVE can't dominate
    assert.equal(opp.pveState, 'disagree');
  });
}

// ---- 5. PVE_AGENT_KEY / secrets never in browser code ----
test('BOUNDARY: browser assets never reference the agent key/header or process.env', () => {
  const pub = path.join(import.meta.dirname, '..', 'public');
  for (const f of ['app.js', 'engine.js', 'options-engine.js', 'index.html']) {
    const src = fs.readFileSync(path.join(pub, f), 'utf8');
    assert.equal(/X-Agent-Key/i.test(src), false, `${f} must not use X-Agent-Key`);
    assert.equal(/process\.env/.test(src), false, `${f} must not read process.env`);
    assert.equal(/ghp_[A-Za-z0-9]{20}/.test(src), false, `${f} must not contain a token`);
    assert.equal(/SatyajitDD7/.test(src), false, `${f} must not contain the password`);
  }
});
