// @ts-check
/*
 * research/technicals.js — PURE retail technical indicators (RSI, MACD, SMA/EMA, Bollinger, ATR)
 * computed from daily OHLC bars. OFFLINE / research only: never imported by the server, never part
 * of production scoring. Phase 1 = OBSERVE ONLY — these are logged into the Signal Journal so the
 * attribution report can later measure whether any of them predict; promotion into a bounded score
 * factor is a separate, evidence-gated step.
 *
 * POINT-IN-TIME (no look-ahead): computeTechnicals(bars, {asOf}) uses only bars STRICTLY BEFORE
 * asOf by default — i.e. only fully-closed prior daily sessions — so an intraday signal never sees
 * its own (not-yet-known) fire-day close. Nothing is fabricated: insufficient history → null.
 */
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function stddev(a) { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length); }

export function sma(vals, n) { if (!Array.isArray(vals) || vals.length < n) return null; return mean(vals.slice(-n)); }

/** Full EMA series aligned to input (nulls until the SMA seed at index n-1). */
export function emaSeries(vals, n) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < n) return out;
  let prev = mean(vals.slice(0, n)); out[n - 1] = prev; const k = 2 / (n + 1);
  for (let i = n; i < vals.length; i++) { prev = vals[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
export function ema(vals, n) { const s = emaSeries(vals, n); return s.length ? s[s.length - 1] : null; }

/** Wilder RSI. Returns final value or null. */
export function rsi(closes, n = 14) {
  if (!Array.isArray(closes) || closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  let ag = g / n, al = l / n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; ag = (ag * (n - 1) + Math.max(d, 0)) / n; al = (al * (n - 1) + Math.max(-d, 0)) / n; }
  if (al === 0) return 100; const rs = ag / al; return 100 - 100 / (1 + rs);
}

/** MACD(fast,slow,signal). Returns {macd, signal, hist, cross}. */
export function macd(closes, fast = 12, slow = 26, sig = 9) {
  if (!Array.isArray(closes) || closes.length < slow + sig) return null;
  const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
  const line = closes.map((_, i) => (isNum(ef[i]) && isNum(es[i]) ? ef[i] - es[i] : null)).filter(isNum);
  const sigSeries = emaSeries(line, sig); const s = sigSeries[sigSeries.length - 1]; const m = line[line.length - 1];
  if (!isNum(m) || !isNum(s)) return null;
  const eps = Math.max(Math.abs(m), Math.abs(s)) * 1e-9 + 1e-12;      // flat momentum → neutral, not float noise
  return { macd: m, signal: s, hist: m - s, cross: m > s + eps ? 'bull' : m < s - eps ? 'bear' : 'neutral' };
}

/** Bollinger(n,k). Returns {mid, upper, lower, pctB}. */
export function bollinger(closes, n = 20, k = 2) {
  if (!Array.isArray(closes) || closes.length < n) return null;
  const win = closes.slice(-n); const mid = mean(win); const sd = stddev(win); if (!isNum(sd)) return null;
  const upper = mid + k * sd, lower = mid - k * sd; const price = closes[closes.length - 1];
  return { mid, upper, lower, pctB: upper === lower ? null : (price - lower) / (upper - lower) };
}

/** Wilder ATR from bars [{high,low,close}]. */
export function atr(bars, n = 14) {
  if (!Array.isArray(bars) || bars.length < n + 1) return null;
  const tr = []; for (let i = 1; i < bars.length; i++) { const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close; if (![h, l, pc].every(isNum)) return null; tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); }
  let a = mean(tr.slice(0, n)); for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n; return a;
}

/**
 * Point-in-time technical snapshot as of `asOf` (a 'YYYY-MM-DD' fire date).
 * @param {Array<{date:string,high:number,low:number,close:number,volume:number}>} bars daily bars
 * @param {{asOf:string, inclusive?:boolean}} opts inclusive=false ⇒ strictly-before (no look-ahead)
 */
export function computeTechnicals(bars, { asOf, inclusive = false } = {}) {
  const src = (bars || []).filter((b) => b && typeof b.date === 'string' && isNum(b.close)).sort((a, b) => a.date.localeCompare(b.date));
  const usable = asOf ? src.filter((b) => (inclusive ? b.date <= asOf : b.date < asOf)) : src; // leakage guard: closed sessions only
  const closes = usable.map((b) => b.close);
  if (closes.length < 15) return { available: false, asOf: asOf || null, source: 'pve-daily', reason: 'insufficient history', barsUsed: closes.length };
  const price = closes[closes.length - 1];
  const rsi14 = rsi(closes, 14), macdV = macd(closes), sma20v = sma(closes, 20), sma50v = sma(closes, 50), sma200v = sma(closes, 200), ema20v = ema(closes, 20), bb = bollinger(closes, 20, 2), atr14 = atr(usable, 14);
  const signals = {
    rsiZone: isNum(rsi14) ? (rsi14 < 30 ? 'oversold' : rsi14 > 70 ? 'overbought' : 'neutral') : null,
    macdCross: macdV ? macdV.cross : null,
    priceVsSma50: isNum(sma50v) ? (price >= sma50v ? 'above' : 'below') : null,
    smaTrend: isNum(sma50v) && isNum(sma200v) ? (sma50v >= sma200v ? 'up' : 'down') : null,   // golden/death
    bbZone: bb && isNum(bb.pctB) ? (bb.pctB > 1 ? 'above_upper' : bb.pctB < 0 ? 'below_lower' : 'inside') : null,
  };
  return {
    available: true, asOf: asOf || null, source: 'pve-daily', barsUsed: closes.length, priceAtAsOf: price,
    rsi14: isNum(rsi14) ? Math.round(rsi14 * 100) / 100 : null,
    macd: macdV ? { macd: round4(macdV.macd), signal: round4(macdV.signal), hist: round4(macdV.hist), cross: macdV.cross } : null,
    sma20: r2(sma20v), sma50: r2(sma50v), sma200: r2(sma200v), ema20: r2(ema20v),
    bollingerPctB: bb && isNum(bb.pctB) ? Math.round(bb.pctB * 1000) / 1000 : null, atr14: r2(atr14),
    signals,
    note: 'OBSERVE-ONLY — retail technicals; NOT used in production scoring',
  };
}
const r2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : null);
const round4 = (x) => (isNum(x) ? Math.round(x * 10000) / 10000 : null);
