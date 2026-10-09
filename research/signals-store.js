// @ts-check
/*
 * research/signals-store.js — OFFLINE research only. Persists, at signal emission time, the
 * feature vector + deterministic score/dir/tier, so that outcomes (MFE/MAE, direction) can be
 * backfilled later from daily OHLC to build a calibration / backtest dataset.
 *
 * NOT imported by the server; NEVER feeds deterministic scoring. Records hold numbers only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { labelOutcome } from './labeler.js';

/** Build a labeled-signal record (label filled in later by backfill). */
export function buildSignalRecord({ ts, ticker, features = {}, score = null, dir = null, tier = null, horizonDays = 5 } = {}) {
  return {
    ts: ts || new Date().toISOString(),
    ticker: String(ticker || '').toUpperCase(),
    score: (typeof score === 'number' && Number.isFinite(score)) ? score : null,
    dir: dir || null, tier: tier || null,
    horizonDays: Math.max(1, Math.floor(horizonDays || 1)),
    features: features && typeof features === 'object' ? features : {},
    label: null,
  };
}

const dateOf = (ts) => String(ts || new Date().toISOString()).slice(0, 10);
export function signalFilePath(dir, ts) { return path.join(dir, `signals-${dateOf(ts)}.jsonl`); }

export async function appendSignal(dir, rec) {
  try { await fs.promises.mkdir(dir, { recursive: true }); const p = signalFilePath(dir, rec.ts); await fs.promises.appendFile(p, JSON.stringify(rec) + '\n'); return { ok: true, path: p }; }
  catch (e) { return { ok: false, error: e.message }; }
}

export async function readSignals(dir, { date } = {}) {
  try { const p = path.join(dir, `signals-${date || dateOf()}.jsonl`); const txt = await fs.promises.readFile(p, 'utf8');
    return txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * Attach an outcome label to one signal record using that ticker's daily OHLC bars.
 * Entry is the signal's own date (bar close), so the forward window is strictly later — no leakage.
 * Pure: returns a new record; does not mutate input.
 */
export function labelSignalRecord(rec, bars, { labeler = labelOutcome } = {}) {
  const label = labeler({ bars, entryDate: dateOf(rec.ts), horizonDays: rec.horizonDays, direction: rec.dir || 'neutral' });
  return { ...rec, label };
}

/** Backfill labels for many records given { TICKER: {bars:[...]} }. Pure. */
export function backfillLabels(records, ohlcByTicker = {}, opts = {}) {
  return (records || []).map((r) => {
    const o = ohlcByTicker[r.ticker];
    const bars = o && Array.isArray(o.bars) ? o.bars : (Array.isArray(o) ? o : []);
    return labelSignalRecord(r, bars, opts);
  });
}
