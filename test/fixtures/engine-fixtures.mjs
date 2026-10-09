// Deterministic fixtures for the FROZEN production-engine baseline (req 6).
// These feed buildOptionsSignal directly (no network). If the Signal Journal ever changes
// production scoring, test/baseline-engine.test.mjs will fail against test/fixtures/baseline-signals.json.
const mk = (type, strike, { vol = 0, oi = 0, iv = 0.4, gamma = 0.04, bid = 1, ask = 1.1, exp = '2026-02-20' } = {}) =>
  ({ type, strike, expiration: exp, volume: vol, openInterest: oi, iv, gamma, delta: type === 'call' ? 0.5 : -0.5, theta: -0.01, vega: 0.1, bid, ask, mid: (bid + ask) / 2 });

const FA_FULL = { chain: true, underlying: true, greeks: true, oi: true, iv: true, quotes: true };

// 1) Bull: call volume + OI dominate
const bull = {
  ticker: 'FIX_BULL', asOf: '2026-01-15T15:00:00Z',
  underlying: { price: 100, prevClose: 98, volume: 5_000_000, available: true }, fieldsAvailable: FA_FULL,
  contracts: [
    mk('call', 95, { vol: 4000, oi: 6000, iv: 0.42, bid: 6, ask: 6.2 }),
    mk('call', 100, { vol: 9000, oi: 8000, iv: 0.40, bid: 2, ask: 2.1 }),
    mk('call', 105, { vol: 6000, oi: 5000, iv: 0.45, bid: 0.8, ask: 0.9 }),
    mk('put', 95, { vol: 1500, oi: 2500, iv: 0.44, bid: 0.7, ask: 0.8 }),
    mk('put', 100, { vol: 2000, oi: 3000, iv: 0.41, bid: 1.8, ask: 1.9 }),
    mk('put', 105, { vol: 800, oi: 1200, iv: 0.46, bid: 5, ask: 5.2 }),
  ],
};
// 2) Bear: put volume + OI dominate, price down vs prev close
const bear = {
  ticker: 'FIX_BEAR', asOf: '2026-01-15T15:00:00Z',
  underlying: { price: 100, prevClose: 104, volume: 4_000_000, available: true }, fieldsAvailable: FA_FULL,
  contracts: [
    mk('call', 95, { vol: 900, oi: 1500, iv: 0.40, bid: 6, ask: 6.2 }),
    mk('call', 100, { vol: 1500, oi: 2500, iv: 0.39, bid: 2, ask: 2.1 }),
    mk('call', 105, { vol: 700, oi: 1000, iv: 0.43, bid: 0.8, ask: 0.9 }),
    mk('put', 95, { vol: 5000, oi: 6000, iv: 0.47, bid: 0.7, ask: 0.8 }),
    mk('put', 100, { vol: 9000, oi: 9000, iv: 0.45, bid: 1.8, ask: 1.9 }),
    mk('put', 105, { vol: 6500, oi: 5500, iv: 0.50, bid: 5, ask: 5.2 }),
  ],
};
// 3) Neutral: balanced
const neutral = {
  ticker: 'FIX_NEUTRAL', asOf: '2026-01-15T15:00:00Z',
  underlying: { price: 100, prevClose: 100, volume: 3_000_000, available: true }, fieldsAvailable: FA_FULL,
  contracts: [
    mk('call', 100, { vol: 3000, oi: 4000, iv: 0.40, bid: 2, ask: 2.1 }),
    mk('put', 100, { vol: 3000, oi: 4000, iv: 0.40, bid: 1.9, ask: 2.0 }),
    mk('call', 105, { vol: 1500, oi: 2000, iv: 0.42, bid: 0.8, ask: 0.9 }),
    mk('put', 95, { vol: 1500, oi: 2000, iv: 0.42, bid: 0.7, ask: 0.8 }),
  ],
};
// 4) Sparse: no greeks / no iv / no quotes → low data quality, exercises null-safety
const sparse = {
  ticker: 'FIX_SPARSE', asOf: '2026-01-15T15:00:00Z',
  underlying: { price: 50, available: true }, fieldsAvailable: { chain: true, underlying: true, greeks: false, oi: true, iv: false, quotes: false },
  contracts: [
    { type: 'call', strike: 50, expiration: '2026-02-20', volume: 1000, openInterest: 2000 },
    { type: 'put', strike: 50, expiration: '2026-02-20', volume: 1200, openInterest: 1800 },
  ],
};

// 5) Bull WITH prior snapshot (exercises oiChange) + underlyingHist (exercises momentum)
const withPrev = {
  chain: { ...bull, ticker: 'FIX_WITHPREV' },
  ctx: { prevAgg: { callOI: 15000, putOI: 8000, atmIV: 0.38 }, underlyingHist: [96, 98] },
};

export const FIXTURES = [
  { name: 'bull', chain: bull, ctx: {} },
  { name: 'bear', chain: bear, ctx: {} },
  { name: 'neutral', chain: neutral, ctx: {} },
  { name: 'sparse', chain: sparse, ctx: {} },
  { name: 'withPrev', chain: withPrev.chain, ctx: withPrev.ctx },
];

// The production fields we freeze (req 6): composite outputs + factors + relevant aggregates.
export function captureBaseline(sig) {
  const a = sig.agg || {};
  return {
    finalScore: sig.finalScore, dir: sig.dir, tier: sig.tier,
    optionsScore: sig.optionsScore, stockScore: sig.stockScore, predictionMarketScore: sig.predictionMarketScore,
    pveFactor: sig.pveFactor, pveState: sig.pveState, dataQuality: sig.dataQuality, primary: sig.primary,
    agg: { gex: a.gex, gammaFlip: a.gammaFlip, maxPain: a.maxPain, cpVolRatio: a.cpVolRatio, cpOIRatio: a.cpOIRatio, volOIRatio: a.volOIRatio, atmIV: a.atmIV, strikeConcentration: a.strikeConcentration, avgSpread: a.avgSpread },
  };
}
