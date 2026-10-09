// @ts-check
/*
 * research/importance.js — OFFLINE research only. Understand which features matter, are redundant,
 * or add nothing — via correlation/redundancy analysis, a tiny zero-dependency logistic regression,
 * and permutation importance. ML lives HERE ONLY and never enters the live scoring path.
 */
import { pearson, spearman, mean, std, isNum, mulberry32 } from './stats.js';

/** Univariate correlation of each feature to the forward return (Pearson + Spearman). */
export function univariateCorrelations(rows, features, yFn) {
  const y = rows.map(yFn);
  const out = {};
  for (const f of features) { const x = rows.map((r) => (isNum(r[f]) ? r[f] : null)); out[f] = { pearson: pearson(x, y), spearman: spearman(x, y), n: x.filter(isNum).length }; }
  return out;
}

/** Redundancy: feature pairs with |corr| >= threshold (prefer keeping the simpler/earlier one). */
export function redundancyPairs(rows, features, { threshold = 0.85 } = {}) {
  const pairs = [];
  for (let i = 0; i < features.length; i++) for (let j = i + 1; j < features.length; j++) {
    const c = pearson(rows.map((r) => r[features[i]]), rows.map((r) => r[features[j]]));
    if (isNum(c) && Math.abs(c) >= threshold) pairs.push({ a: features[i], b: features[j], corr: c });
  }
  return pairs;
}

const standardize = (cols) => cols.map((c) => { const m = mean(c), s = std(c) || 1; return { m, s, z: c.map((v) => (isNum(v) ? (v - m) / s : 0)) }; });

/** Tiny logistic regression via gradient descent (deterministic). Returns weights + bias. */
export function logisticRegression(X, y, { iters = 400, lr = 0.1, l2 = 0.001 } = {}) {
  const n = X.length; if (!n) return { weights: [], bias: 0 };
  const d = X[0].length; let w = new Array(d).fill(0), b = 0;
  const sig = (z) => 1 / (1 + Math.exp(-z));
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) { let z = b; for (let k = 0; k < d; k++) z += w[k] * X[i][k]; const p = sig(z); const e = p - y[i]; for (let k = 0; k < d; k++) gw[k] += e * X[i][k]; gb += e; }
    for (let k = 0; k < d; k++) w[k] -= lr * (gw[k] / n + l2 * w[k]); b -= lr * (gb / n);
  }
  return { weights: w, bias: b };
}

const auc = (scores, labels) => {
  const pairs = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  let pos = 0, neg = 0, rankSum = 0;
  pairs.forEach(([, l], i) => { if (l === 1) rankSum += i + 1; });
  pos = labels.filter((l) => l === 1).length; neg = labels.length - pos;
  if (!pos || !neg) return null;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
};

/**
 * Permutation importance on a logistic model trained on standardized features.
 * Target y = 1 if forward return > 0 else 0. Importance = AUC drop when a feature is shuffled.
 * Deterministic (seeded). Returns per-feature importance sorted desc.
 */
export function permutationImportance(rows, features, yFn, { iters = 5, seed = 42 } = {}) {
  const usable = rows.filter((r) => features.every((f) => isNum(r[f])) && isNum(yFn(r)));
  if (usable.length < 30) return { insufficient: true, n: usable.length, importances: [] };
  const y = usable.map((r) => (yFn(r) > 0 ? 1 : 0));
  const rawCols = features.map((f) => usable.map((r) => r[f]));
  const stz = standardize(rawCols);
  const X = usable.map((_, i) => stz.map((c) => c.z[i]));
  const model = logisticRegression(X, y);
  const score = (Xrows) => Xrows.map((row) => { let z = model.bias; for (let k = 0; k < row.length; k++) z += model.weights[k] * row[k]; return z; });
  const baseAuc = auc(score(X), y); const rng = mulberry32(seed);
  const importances = features.map((f, fi) => {
    let drop = 0;
    for (let it = 0; it < iters; it++) {
      const Xp = X.map((row) => row.slice());
      for (let i = Xp.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = Xp[i][fi]; Xp[i][fi] = Xp[j][fi]; Xp[j][fi] = t; }
      const a = auc(score(Xp), y); if (isNum(a) && isNum(baseAuc)) drop += baseAuc - a;
    }
    return { feature: f, importance: drop / iters };
  }).sort((a, b) => b.importance - a.importance);
  return { insufficient: false, n: usable.length, baseAuc, importances };
}
