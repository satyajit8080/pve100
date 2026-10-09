#!/usr/bin/env node
// scripts/uw-diagnostic.mjs — RUN ON THE VPS (needs network to api.unusualwhales.com + your token).
//   OPTIONS_PROVIDER=uw UNUSUAL_WHALES_API_TOKEN=uw_xxx node scripts/uw-diagnostic.mjs NVDA
// Hits each endpoint the provider uses and prints HTTP status + the TOP-LEVEL JSON KEYS of the
// response (and keys of the first array element), so we can lock exact field mappings. It never
// prints the token and truncates values — safe to copy/paste the output back.
const token = process.env.UNUSUAL_WHALES_API_TOKEN || process.env.OPTIONS_API_KEY;
const base = (process.env.OPTIONS_BASE_URL || 'https://api.unusualwhales.com').replace(/\/$/, '');
const ticker = (process.argv[2] || 'AAPL').toUpperCase();
if (!token) { console.error('Set UNUSUAL_WHALES_API_TOKEN (or OPTIONS_API_KEY) first.'); process.exit(1); }

const endpoints = [
  ['getUnderlying', `/api/stock/${ticker}/stock-state`],
  ['getUnderlying/info', `/api/stock/${ticker}/info`],
  ['getChain(option-chains=symbols)', `/api/stock/${ticker}/option-chains`],
  ['getChain(option-contracts=DATA?)', `/api/stock/${ticker}/option-contracts`],
  ['getChain(greeks?)', `/api/stock/${ticker}/greeks`],
  ['getChain(atm-chains?)', `/api/stock/${ticker}/atm-chains`],
  ['getGex', `/api/stock/${ticker}/greek-exposure`],
  ['getByStrikeGex', `/api/stock/${ticker}/greek-exposure/strike`],
  ['getIvRank', `/api/stock/${ticker}/iv-rank`],
  ['getSkew', `/api/stock/${ticker}/historical-risk-reversal-skew`],
  ['getTermStructure', `/api/stock/${ticker}/volatility/term-structure`],
  ['getFlowDetailed', `/api/stock/${ticker}/flow-alerts?limit=5`],
  ['getNetPremium', `/api/stock/${ticker}/net-prem-ticks`],
  ['getOhlc(1d)', `/api/stock/${ticker}/ohlc/1d?limit=3`],
  ['getOhlc(5m)', `/api/stock/${ticker}/ohlc/5m?limit=3`],
  ['getIntraday(VWAP src)', `/api/stock/${ticker}/ohlc/5m?limit=6`],
  ['getOiChange', `/api/stock/${ticker}/oi-change?limit=5`],
  ['getDarkpool', `/api/darkpool/${ticker}`],
  ['getScreener', `/api/screener/stocks?limit=3`],
  ['getMaxPain', `/api/stock/${ticker}/max-pain`],
];

const keysOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : Array.isArray(v) ? `[array len ${v.length}]` : typeof v);
const sample = (v) => { const s = JSON.stringify(v); return s && s.length > 220 ? s.slice(0, 220) + '…' : s; };

console.log(`UW diagnostic — ticker ${ticker} — ${new Date().toISOString()}\n${'='.repeat(64)}`);
for (const [label, path] of endpoints) {
  try {
    const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    let body = null; try { body = await res.json(); } catch { body = '<non-json>'; }
    const top = body && typeof body === 'object' ? Object.keys(body) : typeof body;
    const data = body && body.data !== undefined ? body.data : body;
    const firstEl = Array.isArray(data) ? data[0] : (data && typeof data === 'object' ? data : null);
    console.log(`\n▶ ${label}  [${res.status}]  ${path}`);
    console.log(`  top-level keys: ${JSON.stringify(top)}`);
    console.log(`  data is: ${keysOf(data)}`);
    if (firstEl) console.log(`  element/object keys: ${JSON.stringify(Object.keys(firstEl))}`);
    if (firstEl) console.log(`  sample: ${sample(firstEl)}`);
  } catch (e) {
    console.log(`\n▶ ${label}  [ERROR]  ${path}\n  ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 250)); // be gentle on rate limits
}
console.log(`\n${'='.repeat(64)}\nDone. Copy everything above back so field mappings can be locked.`);
