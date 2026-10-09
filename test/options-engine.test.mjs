// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateChain, extractOptionsFeatures, scoreOptions, scoreStock, dataQualityScore,
  combineScores, buildOptionsSignal, captureOptionsSnapshot, replayOptionsSignal, scoreTier, OPTIONS_ENGINE_VERSION,
} from '../public/options-engine.js';

// realistic chain fixture: spot 100, call-heavy volume, greeks+iv+oi+quotes present
function chainFixture(over = {}) {
  const mk = (type, strike, volume, oi, iv, gamma, bid, ask) => ({ type, strike, expiration: '2026-09-18', volume, openInterest: oi, iv, delta: type === 'call' ? 0.5 : -0.5, gamma, theta: -0.01, vega: 0.1, bid, ask, mid: (bid + ax(ask)) / 2 });
  function ax(a) { return a; }
  const contracts = [
    mk('call', 95, 500, 1000, 0.40, 0.02, 5.0, 5.2),
    mk('call', 100, 3000, 2000, 0.45, 0.05, 2.0, 2.1),
    mk('call', 105, 1500, 800, 0.50, 0.03, 0.8, 0.9),
    mk('put', 95, 400, 1500, 0.55, 0.03, 0.7, 0.8),
    mk('put', 100, 800, 1200, 0.48, 0.05, 1.8, 1.9),
    mk('put', 105, 300, 600, 0.52, 0.02, 4.5, 4.7),
  ];
  return {
    ticker: 'TEST', asOf: '2026-08-23T00:00:00Z',
    underlying: { price: 100, volume: 1_000_000, available: true },
    contracts,
    fieldsAvailable: { chain: true, greeks: true, iv: true, oi: true, quotes: true, underlying: true, trades: false, sweeps: false },
    flow: { available: false, largeTrades: [] },
    ...over,
  };
}

test('aggregate: call/put volume + ratios (hand-computed)', () => {
  const a = aggregateChain(chainFixture());
  assert.equal(a.callVol, 5000); assert.equal(a.putVol, 1500);
  assert.equal(a.cpVolRatio, 5000 / 1500);
  assert.equal(a.callOI, 3800); assert.equal(a.putOI, 3300);
  assert.equal(a.totOI, 7100); assert.equal(a.totVol, 6500);
});

test('aggregate: GEX sign positive when call gamma·OI dominates; max pain is a real strike', () => {
  const a = aggregateChain(chainFixture());
  assert.ok(a.gex > 0, 'call-dominant gamma → positive dealer GEX');
  assert.ok([95, 100, 105].includes(a.maxPain));
});

test('aggregate: unusual = volume > 1.5×OI (real, from chain)', () => {
  const a = aggregateChain(chainFixture());
  // call@100 vol 3000 > 1.5*2000=3000? no (strictly >). call@105 1500 > 1.5*800=1200 → yes
  assert.ok(a.unusual.some((u) => u.strike === 105 && u.type === 'call'));
});

test('features: call/put pressure is directional bullish here; vol/OI present', () => {
  const { features } = extractOptionsFeatures(chainFixture());
  const cp = features.find((f) => f.key === 'cpVolume');
  assert.equal(cp.avail, 1); assert.equal(cp.dir, 1); // calls dominate
  const vo = features.find((f) => f.key === 'volOIAnomaly');
  assert.equal(vo.avail, 1);
});

test('features: OI change unavailable without prior snapshot; available with one', () => {
  const noPrev = extractOptionsFeatures(chainFixture()).features.find((f) => f.key === 'oiChange');
  assert.equal(noPrev.avail, 0);
  const prevAgg = aggregateChain(chainFixture());
  const bump = chainFixture(); bump.contracts[1].openInterest = 5000; // call OI jumps
  const withPrev = extractOptionsFeatures(bump, { prevAgg }).features.find((f) => f.key === 'oiChange');
  assert.equal(withPrev.avail, 1); assert.equal(withPrev.dir, 1);
});

test('no fabrication: missing greeks/iv/quotes → those features unavailable, GEX null', () => {
  const bare = chainFixture({ fieldsAvailable: { chain: true, greeks: false, iv: false, oi: true, quotes: false, underlying: true } });
  const a = aggregateChain(bare);
  assert.equal(a.gex, null); assert.equal(a.atmIV, null); assert.equal(a.avgSpread, null);
  const { features } = extractOptionsFeatures(bare);
  assert.equal(features.find((f) => f.key === 'gexContext').avail, 0);
  assert.equal(features.find((f) => f.key === 'ivBehavior').avail, 0);
});

test('scoreOptions: bounded 0..100, direction bull for call-heavy chain', () => {
  const { features } = extractOptionsFeatures(chainFixture());
  const r = scoreOptions(features);
  assert.ok(r.optionsScore >= 0 && r.optionsScore <= 100);
  assert.equal(r.dir, 'bull');
});

test('dataQuality: full chain AVAILABLE; chain-only PARTIAL; none UNAVAILABLE', () => {
  assert.equal(dataQualityScore(chainFixture()).status, 'AVAILABLE');
  assert.equal(dataQualityScore(chainFixture({ fieldsAvailable: { chain: true, oi: true } })).status, 'PARTIAL');
  assert.equal(dataQualityScore({ fieldsAvailable: {} }).status, 'UNAVAILABLE');
});

test('combine: options+stock are PRIMARY; PVE only adjusts, never reverses', () => {
  const base = { optionsScore: 80, optionsDir: 'bull', stockScore: 70, stockDir: 'bull', dataQuality: 100 };
  const none = combineScores({ ...base, predictionMarketScore: null });
  const agree = combineScores({ ...base, predictionMarketScore: 90, predictionMarketDir: 'bull' });
  const disagree = combineScores({ ...base, predictionMarketScore: 90, predictionMarketDir: 'bear' });
  assert.equal(agree.dir, 'bull'); assert.equal(disagree.dir, 'bull'); // direction never flips
  assert.ok(agree.finalScore > none.finalScore, 'agreement boosts');
  assert.ok(disagree.finalScore < none.finalScore, 'disagreement reduces');
  assert.equal(disagree.pveState, 'disagree');
  // PVE cannot dominate: factor within [floor,cap]
  assert.ok(disagree.pveFactor >= 0.8 && agree.pveFactor <= 1.15);
});

test('combine: options has substantially greater influence than PVE', () => {
  // With PVE unavailable, final tracks the options-weighted primary closely (dq=100)
  const r = combineScores({ optionsScore: 90, optionsDir: 'bull', stockScore: 90, stockDir: 'bull', dataQuality: 100, predictionMarketScore: null });
  assert.ok(r.finalScore >= 85);
});

test('buildOptionsSignal: insufficient when no real chain (no fabricated signal)', () => {
  const sig = buildOptionsSignal({ ticker: 'X', fieldsAvailable: { chain: false }, contracts: [], underlying: { available: false } });
  assert.equal(sig.insufficient, true);
  assert.equal(sig.dataQualityStatus, 'UNAVAILABLE');
});

test('buildOptionsSignal: full pipeline yields tiered options-primary signal', () => {
  const sig = buildOptionsSignal(chainFixture(), { predictionMarket: { score: 70, dir: 'bull' }, underlyingHist: [98, 99, 100] });
  assert.equal(sig.insufficient, false);
  assert.equal(sig.tier, scoreTier(sig.finalScore));
  assert.equal(sig.dir, 'bull');
  assert.ok(isFinite(sig.optionsScore) && isFinite(sig.stockScore));
  assert.equal(sig.pveState, 'agree');
});

test('replay determinism: snapshot reproduces identical options signal without live API', () => {
  const ctx = { predictionMarket: { score: 70, dir: 'bull' }, underlyingHist: [98, 99, 100] };
  const sig = buildOptionsSignal(chainFixture(), ctx);
  const snap = captureOptionsSnapshot(chainFixture(), ctx, {}, 1234);
  const rep = replayOptionsSignal(snap);
  const view = (s) => JSON.stringify({ f: s.finalScore, o: s.optionsScore, st: s.stockScore, d: s.dir, t: s.tier, dq: s.dataQuality });
  assert.equal(view(rep), view(sig));
  assert.equal(snap.optionsEngineVersion, OPTIONS_ENGINE_VERSION);
});
