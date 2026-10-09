// @ts-check
/*
 * research/capture-snapshot.js — OFFLINE research only. Fetches the live-only PVE series for a set
 * of tickers and appends one snapshot row per ticker. Run on a schedule (cron/systemd timer) on the
 * VPS. NOT imported by the server; NEVER feeds deterministic scoring. The API key is read from env
 * and never logged.
 *
 * Usage on the VPS (example):
 *   OPTIONS_API_KEY=pve_live_… RESEARCH_SNAPSHOT_DIR=./research-data/snapshots \
 *   RESEARCH_TICKERS=AAPL,MSFT,SPY node research/capture-snapshot.js
 */
import { buildSnapshotRecord, appendSnapshot } from './snapshot-store.js';

/**
 * Capture snapshots for `tickers` using an injected `provider` (the configured UW provider on the
 * VPS, or a fake in tests). Best-effort per ticker; one failing ticker never aborts the rest.
 * Fetches the market tide once and reuses it. Returns a summary; writes nothing to stdout except
 * a compact count line.
 * @returns {Promise<{count:number, written:string[], errors:Array<{ticker:string,error:string}>}>}
 */
export async function captureSnapshots({ provider, tickers, dir, now = () => new Date() }) {
  const list = (tickers || []).map((t) => String(t || '').toUpperCase()).filter(Boolean);
  const written = []; const errors = [];
  let marketTide = null;
  if (typeof provider.getMarketTide === 'function') { try { const mt = await provider.getMarketTide(); if (mt && mt.available) marketTide = mt; } catch { /* optional */ } }

  for (const ticker of list) {
    try {
      const [gex, byStrike, ivRank, skew, termStructure, netPremium, under, darkpool] = await Promise.all([
        safe(provider.getGex, provider, ticker),
        safe(provider.getByStrikeGex, provider, ticker),
        safe(provider.getIvRank, provider, ticker),
        safe(provider.getSkew, provider, ticker),
        safe(provider.getTermStructure, provider, ticker),
        safe(provider.getNetPremium, provider, ticker),
        safe(provider.getUnderlying, provider, ticker),
        safe(provider.getDarkpool, provider, ticker),
      ]);
      const underlying = under && under.available ? under.underlying : (under && under.price != null ? under : null);
      const rec = buildSnapshotRecord({ ticker, ts: now().toISOString(), gex, byStrike, ivRank, skew, termStructure, netPremium, underlying, darkpool, marketTide });
      const res = await appendSnapshot(dir, rec);
      if (res.ok) written.push(ticker); else errors.push({ ticker, error: res.error || 'append failed' });
    } catch (e) { errors.push({ ticker, error: (e && e.message) || 'capture failed' }); }
  }
  return { count: written.length, written, errors };
}

// Call a provider method defensively; normalize {available:false} instead of throwing.
async function safe(fn, self, ticker) {
  if (typeof fn !== 'function') return { available: false };
  try { return await fn.call(self, ticker); } catch (e) { return { available: false, error: (e && e.message) || 'error' }; }
}

// ---- CLI entry (only when run directly; not on import) ----
const isMain = (() => { try { return import.meta.url === `file://${process.argv[1]}`; } catch { return false; } })();
if (isMain) {
  (async () => {
    const { makeOptionsProvider } = await import('../providers/options.js');
    const apiKey = process.env.OPTIONS_API_KEY;
    const dir = process.env.RESEARCH_SNAPSHOT_DIR || './research-data/snapshots';
    const tickers = (process.env.RESEARCH_TICKERS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!apiKey) { console.error('capture-snapshot: OPTIONS_API_KEY not set — aborting (no snapshot taken).'); process.exit(1); }
    if (!tickers.length) { console.error('capture-snapshot: RESEARCH_TICKERS empty — nothing to capture.'); process.exit(1); }
    const provider = makeOptionsProvider(process.env);
    const r = await captureSnapshots({ provider, tickers, dir });
    console.log(`capture-snapshot: wrote ${r.count}/${tickers.length} snapshots to ${dir}${r.errors.length ? ` (${r.errors.length} errors)` : ''}`);
    process.exit(0);
  })();
}
