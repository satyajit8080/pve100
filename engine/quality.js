// Phase 6 (spec §27) — data-quality guards. Bad/missing data must NEVER silently become 0.
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export const MAX_QUOTE_AGE_MS = 5 * 60000;
export const MAX_SPREAD_PCT = 25;

// Validate a single option contract; returns cleaned contract + flags (nulls, never zeros).
export function validateContract(c, { now = Date.now() } = {}) {
  const flags = [];
  if (!c || typeof c !== 'object') return { valid: false, flags: ['malformed'], contract: null };
  const out = { ...c };
  const bid = isNum(c.bid) ? c.bid : null, ask = isNum(c.ask) ? c.ask : null;
  if (bid == null || ask == null) flags.push('missing_quote');
  if (isNum(bid) && isNum(ask)) {
    if (ask < bid) { flags.push('crossed_quote'); out.bid = null; out.ask = null; }
    else {
      const mid = (bid + ask) / 2;
      const spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : null;
      out.spreadPct = isNum(spreadPct) ? Math.round(spreadPct * 100) / 100 : null;
      if (isNum(spreadPct) && spreadPct > MAX_SPREAD_PCT) flags.push('abnormal_spread');
    }
  }
  if (c.iv === 0 || (c.iv != null && !isNum(c.iv))) { out.iv = null; flags.push('invalid_iv'); }
  for (const g of ['delta', 'gamma', 'theta', 'vega']) {
    if (c[g] === 0 && g === 'gamma') { out[g] = null; flags.push('zero_gamma'); }
    else if (c[g] != null && !isNum(c[g])) { out[g] = null; flags.push(`invalid_${g}`); }
  }
  if (c.openInterest != null && !isNum(c.openInterest)) { out.openInterest = null; flags.push('invalid_oi'); }
  if (isNum(c.quoteTime) && now - c.quoteTime > MAX_QUOTE_AGE_MS) flags.push('stale_quote');
  return { valid: !flags.includes('malformed'), flags, contract: out };
}

// De-duplicate trades and drop out-of-order//impossible rows.
export function dedupeTrades(trades) {
  const seen = new Set(); const out = []; const flags = [];
  let dropped = 0, outOfOrder = 0, lastTs = null;
  for (const t of Array.isArray(trades) ? trades : []) {
    const key = [t.id, t.option_symbol || t.symbol, t.premium, t.size, t.timestamp || t.executed_at].join('|');
    if (seen.has(key)) { dropped++; continue; }
    seen.add(key);
    const ts = Date.parse(t.timestamp || t.executed_at || '');
    if (Number.isFinite(ts)) { if (lastTs != null && ts < lastTs) outOfOrder++; lastTs = Math.max(lastTs ?? ts, ts); }
    out.push(t);
  }
  if (dropped) flags.push(`deduped_${dropped}`);
  if (outOfOrder) flags.push(`out_of_order_${outOfOrder}`);
  return { trades: out, dropped, outOfOrder, flags };
}

// Roll per-feature flags into one report the UI/journal can show.
export function qualityReport(parts = {}) {
  const flags = [];
  for (const [k, v] of Object.entries(parts)) {
    if (v == null) { flags.push(`${k}_missing`); continue; }
    if (v && v.available === false) flags.push(`${k}_unavailable`);
    if (v && Array.isArray(v.flags)) flags.push(...v.flags.map((f) => `${k}_${f}`));
  }
  const score = flags.length === 0 ? 100 : Math.max(0, 100 - flags.length * 10);
  return { score, flags, degraded: score < 80, note: 'missing data is reported, never coerced to zero' };
}
