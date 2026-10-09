// @ts-check
/*
 * research/resolve-forward-returns.js — OFFLINE. Fills the Signal Journal's forward-return fields.
 * Reads store/signal-log JSONL, and for each unresolved record fetches the ticker's DAILY close at
 * +1 and +5 trading days via OPTIONS_PROVIDER, computing return vs entryPrice. 1h stays 'unavailable'
 * (no intraday data). Never imported by the server. Never fabricates: if a bar isn't available yet,
 * the horizon stays 'pending' for a later run.
 *
 * LEAKAGE PREVENTION: only bars with date STRICTLY GREATER than the fire date are ever used — the
 * fire-day bar and all earlier bars are excluded, so no outcome can leak the entry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { computeTechnicals } from './technicals.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const HORIZON_BARS = { '1d': 1, '1w': 5 };   // trading days after the fire date

/** Bars (daily {date,close}) strictly AFTER firedDate, ascending. Leakage-safe by construction. */
export function tradingBarsAfter(bars, firedDate) {
  return (bars || []).filter((b) => b && typeof b.date === 'string' && b.date > firedDate && isNum(b.close)).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Pure: fill a record's 1d/1w forward returns from daily bars. Returns a NEW record (no mutation).
 * @param {object} rec signal-log record @param {Array<{date:string,close:number}>} bars daily bars
 */
export function resolveRecord(rec, bars) {
  const out = { ...rec, forward: { ...(rec.forward || {}) } };
  const entry = out.entryPrice;
  const firedDate = String(out.firedAt || '').slice(0, 10);
  if (!isNum(entry) || !firedDate) return out;
  const after = tradingBarsAfter(bars, firedDate);           // STRICTLY after fire date (leakage guard)
  for (const [h, n] of Object.entries(HORIZON_BARS)) {
    const cur = out.forward[h];
    if (!cur || cur.status !== 'pending') continue;
    const bar = after[n - 1];                                 // nth trading day after fire
    if (!bar) continue;                                       // not enough bars yet → stay pending (no fabrication)
    // hard leakage assertion
    if (!(bar.date > firedDate)) { continue; }
    out.forward[h] = { price: bar.close, ret: Math.round(((bar.close - entry) / entry) * 100000) / 100000, status: 'resolved', barDate: bar.date, resolvedAt: new Date().toISOString() };
  }
  const pending = ['1d', '1w'].some((h) => out.forward[h] && out.forward[h].status === 'pending');
  out.resolved = !pending;                                    // 1h is 'unavailable' → never blocks
  return out;
}

// ---------- CLI (real data) ----------
function logDir() { return process.env.SIGNAL_LOG_DIR || path.join(ROOT, 'research-data', 'signal-log'); }
function readAll(dir) {
  const byId = new Map();                                     // dedupe by deterministic id (first wins)
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.startsWith('signal-log-') && f.endsWith('.jsonl')); } catch { return { byId, files: [] }; }
  for (const f of files) { for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { if (!line.trim()) continue; try { const r = JSON.parse(line); if (r && r.id && !byId.has(r.id)) byId.set(r.id, { ...r, __file: f }); } catch {} } }
  return { byId, files };
}

async function main() {
  const key = process.env.OPTIONS_API_KEY;
  if (!key) { console.error('OPTIONS_API_KEY required.'); process.exit(1); }
  const dir = logDir();
  const { byId, files } = readAll(dir);
  const recs = [...byId.values()];
  // process records that either need forward returns OR haven't been stamped with technicals yet
  const todo = recs.filter((r) => !r.resolved || !r.technicals);
  if (!todo.length) { console.log(`nothing to do (${recs.length} records, all resolved + technicals stamped) in ${dir}`); process.exit(0); }

  const { makeOptionsProvider } = await import('../providers/options.js');
  const P = makeOptionsProvider(process.env);
  if (P.name === 'null') { console.error(P.reason || 'No options provider configured'); process.exit(1); }
  const gap = Number(process.env.RESOLVE_GAP_MS || 300);
  const tickers = [...new Set(todo.map((r) => r.ticker))];
  const barsByTicker = {};
  for (const t of tickers) { try { const o = await P.getOhlc(t); barsByTicker[t] = (o && o.bars) || (Array.isArray(o) ? o : []); } catch { barsByTicker[t] = []; } await sleep(gap); }

  let filled = 0, stamped = 0;
  const updated = new Map();
  for (const r of recs) {
    let nr = r;
    // OBSERVE-ONLY technicals: point-in-time (strictly before the fire date), from the same daily bars. Zero production impact.
    if (!nr.technicals) { nr = { ...nr, technicals: computeTechnicals(barsByTicker[nr.ticker] || [], { asOf: String(nr.firedAt || '').slice(0, 10) }) }; stamped++; }
    if (!nr.resolved) { const rr = resolveRecord(nr, barsByTicker[nr.ticker] || []); if (JSON.stringify(rr.forward) !== JSON.stringify(nr.forward)) filled++; nr = { ...rr, technicals: nr.technicals }; }
    updated.set(r.id, nr);
  }

  // rewrite each day file with dedup'd + updated records (collapses any duplicate ids too)
  const byFile = {};
  for (const nr of updated.values()) { const f = nr.__file; (byFile[f] = byFile[f] || []).push(nr); }
  for (const [f, list] of Object.entries(byFile)) { fs.writeFileSync(path.join(dir, f), list.map((r) => { const { __file, ...rest } = r; return JSON.stringify(rest); }).join('\n') + '\n'); }
  const stillPending = [...updated.values()].filter((r) => !r.resolved).length;
  console.log(`resolved forward returns: ${filled} horizon-fills, ${stamped} technicals stamped, across ${files.length} file(s); ${stillPending} record(s) still pending (awaiting future bars).`);
  process.exit(0);
}
if (process.argv[1] && process.argv[1].endsWith('resolve-forward-returns.js')) main();
