// Phase 2 (spec §4) — per-ticker, same-time-of-day rolling normalization.
// STRICTLY BACKWARD-LOOKING: a sample is only ever compared against observations recorded
// BEFORE it. Nothing is normalized against its own future. Insufficient history => null
// (never 0, never a fabricated z-score).

import fs from 'node:fs';
import path from 'node:path';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const r4 = (x) => (isNum(x) ? Math.round(x * 10000) / 10000 : null);

export const MIN_HISTORY = 10;          // below this, features report null + insufficient_history
export const MAX_HISTORY = 60;          // ~60 trading days per spec

export function baselineDir() {
  return process.env.BASELINE_DIR || path.join(path.resolve(new URL('..', import.meta.url).pathname), 'research-data', 'baselines');
}

// US-Eastern clock-time bucket (same buckets as the journal, spec §12)
export function timeBucket(d) {
  try {
    const et = new Date(new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const m = et.getHours() * 60 + et.getMinutes();
    if (m < 570) return 'premarket';
    if (m < 585) return '09:30-09:45';
    if (m < 630) return '09:45-10:30';
    if (m < 690) return '10:30-11:30';
    if (m < 780) return '11:30-13:00';
    if (m < 870) return '13:00-14:30';
    if (m < 930) return '14:30-15:30';
    if (m <= 960) return '15:30-16:00';
    return 'afterhours';
  } catch { return null; }
}

const key = (ticker, bucket, feature) => `${String(ticker).toUpperCase()}|${bucket}|${feature}`;

// ---- pure statistics -------------------------------------------------------
export function zScore(value, history) {
  const h = (history || []).filter(isNum);
  if (!isNum(value) || h.length < MIN_HISTORY) return { z: null, percentile: null, n: h.length, available: false, reason: 'insufficient_history' };
  const mean = h.reduce((a, b) => a + b, 0) / h.length;
  const varr = h.reduce((a, b) => a + (b - mean) ** 2, 0) / (h.length - 1 || 1);
  const sd = Math.sqrt(varr);
  const below = h.filter((x) => x < value).length;
  return {
    z: sd > 0 ? r4((value - mean) / sd) : null,
    percentile: r4((below / h.length) * 100),
    n: h.length, mean: r4(mean), sd: r4(sd), available: sd > 0,
    reason: sd > 0 ? null : 'zero_variance',
  };
}

// ---- persistent store ------------------------------------------------------
// One JSONL append per observation; read-time grouping. Append-only, so a later observation
// can never rewrite an earlier one.
export class BaselineStore {
  constructor(dir = baselineDir()) { this.dir = dir; this.cache = null; }

  _file() { return path.join(this.dir, 'baselines.jsonl'); }

  load() {
    if (this.cache) return this.cache;
    const map = new Map();
    let raw = '';
    try { raw = fs.readFileSync(this._file(), 'utf8'); } catch { this.cache = map; return map; }
    for (const line of raw.split('\n')) {
      const t = line.trim(); if (!t) continue;
      try {
        const o = JSON.parse(t);
        if (!o || !o.k || !isNum(o.v)) continue;
        if (!map.has(o.k)) map.set(o.k, []);
        map.get(o.k).push({ v: o.v, at: o.at });
      } catch { /* skip malformed */ }
    }
    for (const [k, arr] of map) { arr.sort((a, b) => String(a.at).localeCompare(String(b.at))); map.set(k, arr.slice(-MAX_HISTORY)); }
    this.cache = map;
    return map;
  }

  // History strictly BEFORE `before` (ISO string) — this is what prevents look-ahead.
  history(ticker, bucket, feature, before = null) {
    const arr = this.load().get(key(ticker, bucket, feature)) || [];
    const cut = before ? arr.filter((x) => String(x.at) < String(before)) : arr;
    return cut.map((x) => x.v);
  }

  // Normalize a value against the ticker's own prior same-time-of-day distribution.
  normalize(ticker, feature, value, at) {
    const bucket = timeBucket(at);
    const hist = this.history(ticker, bucket, feature, new Date(at).toISOString());
    return { ...zScore(value, hist), bucket, feature };
  }

  async record(ticker, feature, value, at) {
    if (!isNum(value)) return false;
    const bucket = timeBucket(at);
    const k = key(ticker, bucket, feature);
    const at_ = new Date(at).toISOString();
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.appendFile(this._file(), JSON.stringify({ k, v: value, at: at_ }) + '\n');
    if (this.cache) { if (!this.cache.has(k)) this.cache.set(k, []); this.cache.get(k).push({ v: value, at: at_ }); }
    return true;
  }

  // Normalize a whole feature bag, then record the raw values for future baselines.
  async normalizeAndRecord(ticker, features, at) {
    const out = {};
    for (const [f, v] of Object.entries(features)) out[f] = this.normalize(ticker, f, v, at);
    for (const [f, v] of Object.entries(features)) await this.record(ticker, f, v, at);
    return out;
  }

  stats() {
    const m = this.load();
    let obs = 0; for (const arr of m.values()) obs += arr.length;
    return { keys: m.size, observations: obs, file: this._file() };
  }
}

// EWMA smoothing for noisy poll-to-poll inputs (spec §18)
export function ewma(prev, value, alpha = 0.3) {
  if (!isNum(value)) return isNum(prev) ? prev : null;
  if (!isNum(prev)) return value;
  return r4(alpha * value + (1 - alpha) * prev);
}
