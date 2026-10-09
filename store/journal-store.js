// Journal persistence. Original signal records are written once by store/signal-log.js and are
// treated as IMMUTABLE. Outcomes are stored as separate append-only patch lines in outcomes-*.jsonl
// and merged at read time, so post-signal information can never overwrite what the engine saw.

import fs from 'node:fs';
import path from 'node:path';
import { analyzeOutcome } from './journal.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function journalDir() {
  return process.env.SIGNAL_LOG_DIR || path.join(path.resolve(new URL('..', import.meta.url).pathname), 'research-data', 'signal-log');
}

function readJsonl(file) {
  const out = [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    const t = line.trim(); if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip malformed, never fabricate */ }
  }
  return out;
}

// Parsed-journal cache keyed on (dir, file names + mtimes + sizes): re-parse only when a file changes.
// Consumers must treat the returned records as read-only.
const _cache = new Map(); // dir -> { fp, list }
function fingerprint(dir, files) {
  const parts = [];
  for (const f of files) { try { const st = fs.statSync(path.join(dir, f)); parts.push(`${f}:${st.mtimeMs}:${st.size}`); } catch { parts.push(`${f}:x`); } }
  return parts.join('|');
}

// Read all signal records, merge any outcome patches. First write of an id wins (dedupe).
export function readJournal(dir = journalDir()) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return []; }
  const fp = fingerprint(dir, files);
  const hit = _cache.get(dir);
  if (hit && hit.fp === fp) return hit.list;
  const list = parseJournal(dir, files);
  _cache.set(dir, { fp, list });
  return list;
}

function parseJournal(dir, files) {
  const signals = new Map();
  for (const f of files.filter((f) => f.startsWith('signal-log-') && f.endsWith('.jsonl')).sort()) {
    for (const r of readJsonl(path.join(dir, f))) {
      if (r && r.id && !signals.has(r.id)) signals.set(r.id, r);
    }
  }
  // apply outcome patches (append-only; later patch for the same horizon wins)
  for (const f of files.filter((f) => f.startsWith('outcomes-') && f.endsWith('.jsonl')).sort()) {
    for (const p of readJsonl(path.join(dir, f))) {
      const rec = p && p.id ? signals.get(p.id) : null;
      if (!rec || !p.horizon || !p.outcome) continue;
      rec.outcomes = rec.outcomes || {};
      rec.outcomes[p.horizon] = p.outcome;          // outcomes only — never touches composite/explain/entry
    }
  }
  // derive post-trade analysis at read time (kept out of the stored signal record)
  const list = [...signals.values()];
  for (const r of list) {
    try {
      const a = analyzeOutcome(r, '60m') || analyzeOutcome(r, '30m') || analyzeOutcome(r, '15m');
      r.postAnalysis = a ? { ...a, analyzedAt: new Date().toISOString() } : null;
    } catch { r.postAnalysis = null; }
  }
  return list.sort((a, b) => String(b.firedAt).localeCompare(String(a.firedAt)));
}

export function readSignal(id, dir = journalDir()) {
  return readJournal(dir).find((r) => r.id === id) || null;   // served from the parse cache
}

// Append an outcome patch. NEVER rewrites the signal file.
export async function appendOutcome(id, horizon, outcome, dir = journalDir()) {
  if (!id || !horizon || !outcome) return false;
  await fs.promises.mkdir(dir, { recursive: true });
  const line = JSON.stringify({ id, horizon, outcome, patchedAt: new Date().toISOString() }) + '\n';
  await fs.promises.appendFile(path.join(dir, `outcomes-${new Date().toISOString().slice(0, 10)}.jsonl`), line);
  return true;
}

// Which (record, horizon) pairs are due for resolution right now?
export function pendingOutcomes(records, now = Date.now(), checkpointMs = { '15m': 900000, '30m': 1800000, '60m': 3600000 }) {
  const due = [];
  for (const r of records) {
    const fired = Date.parse(r.firedAt);
    if (!Number.isFinite(fired)) continue;
    for (const [h, ms] of Object.entries(checkpointMs)) {
      const cur = r.outcomes && r.outcomes[h];
      if (cur && cur.status === 'resolved') continue;
      if (now >= fired + ms) due.push({ id: r.id, ticker: r.ticker, horizon: h, firedAt: r.firedAt, entry: r.entry || null, dir: r.composite ? r.composite.dir : null, atr: (r.context && isNum(r.context.atr)) ? r.context.atr : null, checkpointAt: new Date(fired + ms).toISOString() });
    }
  }
  return due;
}

export { isNum };
