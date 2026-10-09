// @ts-check
/*
 * research/stats.js — OFFLINE research only. Pure numeric + statistics helpers used by the
 * validation pipeline. Deterministic (seeded RNG) so results are reproducible in tests.
 * NOT imported by the server and NEVER part of the live scoring path.
 */

export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const nums = (a) => (a || []).filter(isNum);
export const mean = (a) => { const v = nums(a); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
export const std = (a, sample = true) => { const v = nums(a); if (v.length < 2) return null; const m = mean(v); const d = v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - (sample ? 1 : 0)); return Math.sqrt(d); };
export const median = (a) => { const v = nums(a).slice().sort((x, y) => x - y); if (!v.length) return null; const i = Math.floor(v.length / 2); return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2; };
export const quantile = (a, q) => { const v = nums(a).slice().sort((x, y) => x - y); if (!v.length) return null; const pos = (v.length - 1) * q; const lo = Math.floor(pos), hi = Math.ceil(pos); return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo); };
export const sum = (a) => nums(a).reduce((s, x) => s + x, 0);

/** Deterministic PRNG (mulberry32) so bootstraps/permutations are reproducible. */
export function mulberry32(seed) {
  let t = seed >>> 0;
  return function () { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}

/** Bootstrap CI of the mean (i.i.d. resampling). Returns {mean, lo, hi, iters, n}. */
export function bootstrapCI(values, { iters = 2000, alpha = 0.05, seed = 42 } = {}) {
  const v = nums(values); const n = v.length;
  if (n < 2) return { mean: mean(v), lo: null, hi: null, iters: 0, n, insufficient: true };
  const rng = mulberry32(seed); const means = [];
  for (let b = 0; b < iters; b++) { let s = 0; for (let i = 0; i < n; i++) s += v[(rng() * n) | 0]; means.push(s / n); }
  means.sort((a, c) => a - c);
  return { mean: mean(v), lo: quantile(means, alpha / 2), hi: quantile(means, 1 - alpha / 2), iters, n };
}

/** Block bootstrap CI of the mean — preserves autocorrelation for time-dependent series. */
export function blockBootstrapCI(values, { block = 5, iters = 2000, alpha = 0.05, seed = 42 } = {}) {
  const v = nums(values); const n = v.length;
  if (n < block * 2) return { mean: mean(v), lo: null, hi: null, iters: 0, n, insufficient: true };
  const rng = mulberry32(seed); const nb = Math.ceil(n / block); const means = [];
  for (let b = 0; b < iters; b++) {
    const s = []; while (s.length < n) { const start = (rng() * (n - block + 1)) | 0; for (let k = 0; k < block && s.length < n; k++) s.push(v[start + k]); }
    means.push(mean(s));
  }
  means.sort((a, c) => a - c);
  return { mean: mean(v), lo: quantile(means, alpha / 2), hi: quantile(means, 1 - alpha / 2), iters, n, block };
}

// ---- risk / performance metrics on a per-trade (or per-period) return series ----
export function sharpe(returns, { periodsPerYear = 252 } = {}) { const m = mean(returns), s = std(returns); if (m == null || !s) return null; return (m / s) * Math.sqrt(periodsPerYear); }
export function sortino(returns, { periodsPerYear = 252, mar = 0 } = {}) { const v = nums(returns); if (v.length < 2) return null; const m = mean(v); const dn = v.filter((x) => x < mar); if (!dn.length) return null; const dd = Math.sqrt(dn.reduce((s, x) => s + (x - mar) ** 2, 0) / dn.length); return dd ? ((m - mar) / dd) * Math.sqrt(periodsPerYear) : null; }
export function maxDrawdown(returns) { const v = nums(returns); if (!v.length) return null; let eq = 1, peak = 1, mdd = 0; for (const r of v) { eq *= 1 + r; if (eq > peak) peak = eq; const dd = (eq - peak) / peak; if (dd < mdd) mdd = dd; } return mdd; }
export function winRate(returns) { const v = nums(returns); if (!v.length) return null; return v.filter((x) => x > 0).length / v.length; }
export function payoffRatio(returns) { const v = nums(returns); const w = v.filter((x) => x > 0), l = v.filter((x) => x < 0); const aw = mean(w), al = mean(l); return (aw != null && al != null && al !== 0) ? aw / Math.abs(al) : null; }
export function profitFactor(returns) { const v = nums(returns); const g = sum(v.filter((x) => x > 0)), lo = Math.abs(sum(v.filter((x) => x < 0))); return lo > 0 ? g / lo : null; }

/**
 * Deflated Sharpe ratio (Bailey & López de Prado, approximate) — corrects an observed Sharpe for
 * the number of trials tested (multiple-testing) and sample length. Returns a probability the true
 * Sharpe > 0 after deflation. Approximation using the standard-error-of-Sharpe adjustment.
 */
export function deflatedSharpe(observedSharpe, { nTrials = 1, nObs = 0, skew = 0, kurtosis = 3 } = {}) {
  if (!isNum(observedSharpe) || nObs < 10 || nTrials < 1) return { value: null, insufficient: true };
  // expected max Sharpe from nTrials independent noise strategies (E[max] ~ sqrt(2 ln N))
  const emc = 0.5772156649;
  const expMax = nTrials <= 1 ? 0 : Math.sqrt(2 * Math.log(nTrials)) - (Math.log(Math.log(nTrials)) + Math.log(4 * Math.PI)) / (2 * Math.sqrt(2 * Math.log(nTrials))) - emc / Math.sqrt(2 * Math.log(nTrials));
  const srAnnToPer = observedSharpe / Math.sqrt(252);           // convert if annualized; treat input as annualized
  const seSR = Math.sqrt((1 - skew * srAnnToPer + ((kurtosis - 1) / 4) * srAnnToPer ** 2) / (nObs - 1));
  const z = (srAnnToPer - expMax * seSR) / (seSR || 1e-9);
  const cdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
  return { value: cdf(z), expectedMaxSharpe: expMax, nTrials, nObs };
}
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }

export function pearson(x, y) {
  const n = Math.min(x.length, y.length); const xs = [], ys = [];
  for (let i = 0; i < n; i++) if (isNum(x[i]) && isNum(y[i])) { xs.push(x[i]); ys.push(y[i]); }
  if (xs.length < 3) return null;
  const mx = mean(xs), my = mean(ys); let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}
const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); for (let k = 0; k < idx.length; k++) r[idx[k][1]] = k + 1; return r; };
export function spearman(x, y) {
  const n = Math.min(x.length, y.length); const xs = [], ys = [];
  for (let i = 0; i < n; i++) if (isNum(x[i]) && isNum(y[i])) { xs.push(x[i]); ys.push(y[i]); }
  if (xs.length < 3) return null;
  return pearson(rank(xs), rank(ys));
}
