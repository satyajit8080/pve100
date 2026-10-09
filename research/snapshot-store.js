// @ts-check
/*
 * research/snapshot-store.js — OFFLINE research only. Captures the LIVE-ONLY PVE series
 * (/gex summary, iv-rank, skew, term slope, tide, DIX) as timestamped rows so ΔGEX / regime
 * history / calibration become possible later. NOT imported by the server; NEVER feeds scoring.
 *
 * Records contain ONLY whitelisted numeric scalars + ts/ticker — no keys, prompts, or secrets.
 */
import fs from 'node:fs';
import path from 'node:path';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const num = (x) => (isNum(x) ? x : null);

/** The exact set of keys a snapshot record may contain (guarantees no secret ever lands here). */
export const SNAPSHOT_FIELDS = [
  'ts', 'ticker', 'spot',
  'net_gex', 'call_gex', 'put_gex', 'net_dex', 'gamma_flip', 'call_wall', 'put_wall',
  'near_spot_gex', 'flip_distance', 'call_wall_distance', 'put_wall_distance',
  'iv_rank', 'iv_percentile', 'current_iv', 'skew25', 'term_slope_30_90',
  'net_premium', 'bullish_premium', 'bearish_premium',
  'dix', 'market_net_premium',
];

const relDist = (level, spot) => (isNum(level) && isNum(spot) && spot !== 0 ? (level - spot) / spot : null);

/** Sum of per-strike netGex within ±pct of spot (gamma concentration near price). */
export function nearSpotGex(byStrike, spot, pct = 0.05) {
  if (!byStrike || !Array.isArray(byStrike.strikes) || !isNum(spot) || spot === 0) return null;
  const lo = spot * (1 - pct), hi = spot * (1 + pct);
  let sum = 0, seen = false;
  for (const s of byStrike.strikes) { if (isNum(s.strike) && isNum(s.netGex) && s.strike >= lo && s.strike <= hi) { sum += s.netGex; seen = true; } }
  return seen ? sum : null;
}

/**
 * Build a flat, whitelisted snapshot record from normalized provider outputs.
 * Any input may be null/absent; missing values become null (never fabricated).
 */
export function buildSnapshotRecord({ ticker, ts, gex, byStrike, ivRank, skew, termStructure, netPremium, underlying, darkpool, marketTide } = {}) {
  const spot = num(underlying && underlying.price);
  const flip = num(gex && gex.gamma_flip), cw = num(gex && gex.call_wall), pw = num(gex && gex.put_wall);
  const rec = {
    ts: ts || new Date().toISOString(),
    ticker: String(ticker || '').toUpperCase(),
    spot,
    net_gex: num(gex && gex.net_gex), call_gex: num(gex && gex.call_gex), put_gex: num(gex && gex.put_gex), net_dex: num(gex && gex.net_dex),
    gamma_flip: flip, call_wall: cw, put_wall: pw,
    near_spot_gex: nearSpotGex(byStrike, spot),
    flip_distance: relDist(flip, spot) != null ? (spot - flip) / spot : null,  // (spot−flip)/spot: sign = regime
    call_wall_distance: relDist(cw, spot), put_wall_distance: relDist(pw, spot),
    iv_rank: num(ivRank && ivRank.iv_rank), iv_percentile: num(ivRank && ivRank.iv_percentile), current_iv: num(ivRank && ivRank.current_iv),
    skew25: num(skew && skew.skew25), term_slope_30_90: num(termStructure && termStructure.slope3090),
    net_premium: num(netPremium && netPremium.total_net_premium), bullish_premium: num(netPremium && netPremium.total_bullish_premium), bearish_premium: num(netPremium && netPremium.total_bearish_premium),
    dix: num(darkpool && darkpool.dix), market_net_premium: num(marketTide && marketTide.net_premium),
  };
  // Enforce whitelist (defensive: strip anything unexpected).
  for (const k of Object.keys(rec)) if (!SNAPSHOT_FIELDS.includes(k)) delete rec[k];
  return rec;
}

const dateOf = (ts) => String(ts || new Date().toISOString()).slice(0, 10);
export function snapshotFilePath(dir, ts) { return path.join(dir, `snapshots-${dateOf(ts)}.jsonl`); }

/** Append one record as a JSONL line (best-effort; creates dir). Returns { ok, path }. */
export async function appendSnapshot(dir, rec) {
  try { await fs.promises.mkdir(dir, { recursive: true }); const p = snapshotFilePath(dir, rec.ts); await fs.promises.appendFile(p, JSON.stringify(rec) + '\n'); return { ok: true, path: p }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/** Read snapshot rows for a given date (default today). Returns [] if the file is absent. */
export async function readSnapshots(dir, { date } = {}) {
  try { const p = path.join(dir, `snapshots-${date || dateOf()}.jsonl`); const txt = await fs.promises.readFile(p, 'utf8');
    return txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
