// Phase 1 — baseline evaluation harness (spec §3, §22).
// Pure functions. Measures the CURRENT engine before anything is changed.
// Nothing here feeds back into scoring; it only reports.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const r2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : null);
const r4 = (x) => (isNum(x) ? Math.round(x * 10000) / 10000 : null);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Spearman rank IC between score and forward return.
export function rankIC(pairs) {
  const p = pairs.filter((x) => isNum(x.score) && isNum(x.ret));
  const n = p.length;
  if (n < 3) return { ic: null, n, gated: true, reason: 'need >= 3 observations' };
  const rank = (key) => {
    const idx = p.map((v, i) => ({ i, v: v[key] })).sort((a, b) => a.v - b.v);
    const r = new Array(n);
    let k = 0;
    while (k < n) {                                  // average ranks for ties
      let j = k; while (j + 1 < n && idx[j + 1].v === idx[k].v) j++;
      const mean = (k + j) / 2 + 1;
      for (let m = k; m <= j; m++) r[idx[m].i] = mean;
      k = j + 1;
    }
    return r;
  };
  const rs = rank('score'), rr = rank('ret');
  const ms = avg(rs), mr = avg(rr);
  let num = 0, ds = 0, dr = 0;
  for (let i = 0; i < n; i++) { const a = rs[i] - ms, b = rr[i] - mr; num += a * b; ds += a * a; dr += b * b; }
  const ic = ds > 0 && dr > 0 ? num / Math.sqrt(ds * dr) : null;
  return { ic: r4(ic), n, gated: n < 30, note: n < 30 ? 'low sample — treat as indicative only' : (isNum(ic) && Math.abs(ic) > 0.10 ? 'IC > 0.10 is suspicious; check for look-ahead/overfitting' : null) };
}

// Precision of the top decile by score (fraction with positive forward return).
export function topDecilePrecision(pairs) {
  const p = pairs.filter((x) => isNum(x.score) && isNum(x.ret)).sort((a, b) => b.score - a.score);
  if (p.length < 10) return { precision: null, n: p.length, gated: true };
  const k = Math.max(1, Math.floor(p.length / 10));
  const top = p.slice(0, k);
  return { precision: r2((top.filter((x) => x.ret > 0).length / k) * 100), n: k, baseline: r2((p.filter((x) => x.ret > 0).length / p.length) * 100), gated: p.length < 50 };
}

// Calibration: does a score of ~80 win ~80% of the time?
export function calibration(pairs, buckets = [[50, 60], [60, 70], [70, 80], [80, 90], [90, 101]]) {
  return buckets.map(([lo, hi]) => {
    const inB = pairs.filter((x) => isNum(x.score) && isNum(x.ret) && x.score >= lo && x.score < hi);
    return { range: `${lo}-${hi === 101 ? 100 : hi - 1}`, n: inB.length, hitRate: inB.length ? r2((inB.filter((x) => x.ret > 0).length / inB.length) * 100) : null, avgReturn: r2(avg(inB.map((x) => x.ret))), gated: inB.length < 30 };
  });
}

function statsOf(rows) {
  const rets = rows.map((r) => r.ret).filter(isNum);
  const wins = rets.filter((r) => r > 0).length, losses = rets.filter((r) => r <= 0).length;
  return {
    n: rows.length, hitRate: rets.length ? r2((wins / rets.length) * 100) : null,
    avgReturn: r2(avg(rets)), winLossRatio: losses ? r2(wins / losses) : null,
    avgMFE: r2(avg(rows.map((r) => r.mfe).filter(isNum))), avgMAE: r2(avg(rows.map((r) => r.mae).filter(isNum))),
    avgAtrReturn: r2(avg(rows.map((r) => r.atrRet).filter(isNum))),
    targetRate: r2((rows.filter((r) => r.outcome === 'TARGET').length / (rows.length || 1)) * 100),
    stopRate: r2((rows.filter((r) => r.outcome === 'STOP').length / (rows.length || 1)) * 100),
    gated: rows.length < 30,
  };
}

const groupBy = (rows, keyFn) => {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m.entries()].map(([key, rs]) => ({ key, ...statsOf(rs) })).sort((a, b) => (b.avgReturn ?? -999) - (a.avgReturn ?? -999));
};

// Flatten journal records into evaluation rows for one horizon.
export function toRows(records, horizon = '30m') {
  const out = [];
  for (const r of records || []) {
    const o = r.outcomes && r.outcomes[horizon];
    if (!o || o.status !== 'resolved' || !isNum(o.directionalReturnPct)) continue;
    const ctx = r.context || {};
    out.push({
      id: r.id, ticker: r.ticker, firedAt: r.firedAt,
      score: r.composite.finalScore, shadow: isNum(r.shadowScore) ? r.shadowScore : null,
      v2Score: (r.v2 && isNum(r.v2.score)) ? r.v2.score : null, v2State: r.v2 ? r.v2.state : null,
      dir: r.composite.dir, ret: o.directionalReturnPct, atrRet: o.atrNormalizedReturn,
      mfe: o.maxFavorablePct, mae: o.maxAdversePct, outcome: o.outcome,
      gammaRegime: ctx.gammaRegime || null, timeOfDay: ctx.timeOfDayBucket || null,
      marketRegime: ctx.marketRegime || null, rvolBucket: isNum(ctx.rvol) ? (ctx.rvol >= 1.5 ? 'high' : 'normal/low') : null,
    });
  }
  return out;
}

// Full baseline report for the current engine (spec §3).
export function baselineReport(records, { horizons = ['15m', '30m', '60m', 'close'] } = {}) {
  const byHorizon = {};
  for (const h of horizons) {
    const rows = toRows(records, h);
    byHorizon[h] = {
      ...statsOf(rows),
      rankIC: rankIC(rows.map((r) => ({ score: r.score, ret: r.ret }))),
      shadowRankIC: rankIC(rows.filter((r) => isNum(r.shadow)).map((r) => ({ score: r.shadow, ret: r.ret }))),
      // v2 vs v1 head-to-head on the SAME observations (spec §28: our data decides)
      v2RankIC: rankIC(rows.filter((r) => isNum(r.v2Score)).map((r) => ({ score: r.v2Score, ret: r.ret }))),
      v2TopDecile: topDecilePrecision(rows.filter((r) => isNum(r.v2Score)).map((r) => ({ score: r.v2Score, ret: r.ret }))),
      topDecile: topDecilePrecision(rows.map((r) => ({ score: r.score, ret: r.ret }))),
      calibration: calibration(rows.map((r) => ({ score: r.score, ret: r.ret }))),
    };
  }
  const primary = toRows(records, '30m');
  return {
    generatedAt: new Date().toISOString(),
    totals: { signals: (records || []).length, evaluated: primary.length, bullish: primary.filter((r) => r.dir === 'bull').length, bearish: primary.filter((r) => r.dir === 'bear').length },
    byHorizon,
    byScoreBucket: byHorizon['30m'] ? byHorizon['30m'].calibration : [],
    byGammaRegime: groupBy(primary, (r) => r.gammaRegime),
    byTimeOfDay: groupBy(primary, (r) => r.timeOfDay),
    byMarketRegime: groupBy(primary, (r) => r.marketRegime),
    byRvol: groupBy(primary, (r) => r.rvolBucket),
    byV2State: groupBy(primary, (r) => r.v2State),
    byTicker: groupBy(primary, (r) => r.ticker).slice(0, 25),
    note: 'Baseline measurement of the CURRENT engine. Groups with n < 30 are gated as indicative only. Rank IC above 0.10 usually means look-ahead bias, not skill.',
  };
}

export { statsOf };
