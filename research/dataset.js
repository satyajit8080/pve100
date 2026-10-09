// @ts-check
/*
 * research/dataset.js — OFFLINE research only. Builds the validation dataset by joining each
 * signal-time feature row to its FORWARD outcome labels (from daily OHLC). Pure core; a thin
 * loader (CLI, elsewhere) reads the Phase 0/1/2 stores. NOT imported by the server.
 *
 * Missing values are NEVER fabricated — they stay null and are surfaced via coverage.
 */
import { labelMultiHorizon } from './labeler.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** The feature columns the validation pipeline tracks coverage for (per the Phase 3 spec). */
export const DATASET_FEATURES = [
  'price', 'currentScore', 'shadowScore', 'gexRegime', 'flipDistancePct', 'callWallDistancePct', 'putWallDistancePct',
  'nearSpotGex', 'deltaGexPct', 'vanna', 'charm', 'ivRank', 'ivPercentile', 'skew25', 'ivSpread', 'termSlope', 'vrp',
  'flowDirection', 'flowQuality', 'netPremium', 'premiumOI', 'golden', 'dte', 'moneyness', 'momentum', 'flowPrice',
  'marketRegime', 'marketTide', 'dix', 'sector', 'sectorBreadth', 'crossSectionalRank', 'earningsProximity', 'dataQuality',
];

/**
 * @param {Array<object>} records  signal-time observations (flat feature fields + ts, ticker, direction)
 * @param {Record<string,{bars:Array}>} ohlcByTicker  daily OHLC per ticker for forward labeling
 * @param {{horizons?:number[], targetPct?:number, adversePct?:number, features?:string[]}} [opts]
 * @returns {{version:string, size:number, labeledCount:number, dateRange:{from:?string,to:?string}, horizons:number[], rows:Array, coverage:Record<string,number>, insufficient:boolean}}
 */
export function buildDataset(records, ohlcByTicker = {}, opts = {}) {
  const horizons = opts.horizons || [1, 3, 5, 10];
  const features = opts.features || DATASET_FEATURES;
  const recs = Array.isArray(records) ? records.filter((r) => r && r.ticker && r.ts) : [];
  const rows = [];
  let labeled = 0; let from = null, to = null;
  for (const r of recs) {
    const day = String(r.ts).slice(0, 10);
    if (from == null || day < from) from = day; if (to == null || day > to) to = day;
    const o = ohlcByTicker[String(r.ticker).toUpperCase()];
    const bars = o && Array.isArray(o.bars) ? o.bars : (Array.isArray(o) ? o : []);
    const entryPrice = isNum(r.price) ? r.price : undefined;
    const labels = bars.length ? labelMultiHorizon({ bars, entryDate: day, direction: r.direction || 'neutral', entryPrice, horizons, targetPct: opts.targetPct, adversePct: opts.adversePct }) : null;
    const anyLabeled = labels && horizons.some((H) => labels.byHorizon[H] && labels.byHorizon[H].insufficient === false);
    if (anyLabeled) labeled++;
    rows.push({ ...r, labels });
  }
  const coverage = {};
  for (const f of features) { const c = recs.filter((r) => r[f] != null).length; coverage[f] = recs.length ? Math.round((c / recs.length) * 1000) / 10 : 0; }
  return {
    version: 'dataset-1.0.0', size: recs.length, labeledCount: labeled,
    dateRange: { from, to }, horizons, rows, coverage,
    insufficient: labeled < 1,
  };
}
