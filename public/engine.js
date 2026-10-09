// @ts-check
/*
 * PVE Signal Engine — deterministic core.
 *
 * Pure functions, no DOM / no fetch / no globals, so the SAME code runs in the browser
 * and under `node --test`. This is the single source of truth for scoring (previously the
 * math lived only in app.js and was re-implemented in tests — a drift risk that this module removes).
 *
 * Pipeline (each stage is a pure, separately-testable function):
 *   validateSnapshot → extractFeatures → scoreFeatures → (buildSignal composes these)
 *   evaluateOutcome / updateExcursion  ← LABELS, computed later from FUTURE prices, kept
 *                                          in different functions so leakage is structural.
 *
 * LEAKAGE RULE: extractFeatures/scoreFeatures may read ONLY the snapshot at time T.
 * Nothing that computes a FeatureVector is allowed to touch a future price/volume/label.
 * evaluateOutcome is the only place a future price appears, and it never feeds a feature.
 */

/** @typedef {{tokenId?:string,name?:string,price:(number|null),volume:(number|null)}} Outcome */
/** @typedef {{slug:string,title?:string,status?:string,tags?:string[],volume:(number|null),liquidity:(number|null),endDate?:string,outcomes:Outcome[]}} MarketSnapshot */
/** @typedef {{bidDepth:number,askDepth:number,imbalance:(number|null),mid:(number|null)}} OrderbookSnapshot */
/** @typedef {{series?:({t:*,price:number}[]|null),ob?:(OrderbookSnapshot|null)}} DeepData */
/** @typedef {{slug?:string,tokenId?:string,direction?:number,magnitude?:(number|null)}} Spike */
/** @typedef {{slug?:string,direction?:number,volume?:(number|null)}} Trader */
/** @typedef {{spikes:Spike[],traders:Trader[],volMed:number,liqMed:number,snapshotTs:number}} ScanContext */
/** @typedef {{key:string,label:string,avail:(0|1),dir:number,strength:number,value:(number|null),note:string}} FeatureResult */
/** @typedef {{features:FeatureResult[],asOf:number}} FeatureVector */
/** @typedef {{score:number,net:number,coverage:number,confidence:number,dir:('bull'|'bear'|'neutral'),comps:(FeatureResult&{weight:number,contribution:number})[]}} ScoreResult */
/** @typedef {{level:('ok'|'low'|'reject'),score:number,reasons:string[],checks:Record<string,boolean>}} QualityReport */
/** @typedef {{done:boolean,price?:number,delta?:number,deltaPct?:(number|null),favPts?:number,win?:boolean}} OutcomeLabel */

export const COMPONENTS = [
  { key: 'flow', label: 'Unusual Flow', note: 'from /flow/spikes' },
  { key: 'outcome', label: 'Outcome Pressure', note: 'YES/NO volume · PCR-analog' },
  { key: 'liquidity', label: 'Liquidity / Depth', note: 'orderbook imbalance · OI-analog' },
  { key: 'volume', label: 'Volume', note: 'activity vs median · confirmation' },
  { key: 'price', label: 'Price Movement', note: 'windowed return from /prices' },
  { key: 'smart', label: 'Smart Money', note: 'top-trader attribution' },
];

/** @type {*} */
export const DEFAULT_CONFIG = {
  weights: { flow: 0.28, outcome: 0.16, liquidity: 0.14, volume: 0.16, price: 0.20, smart: 0.06 },
  epsilon: 0.08,          // neutral band on net tilt
  priceWindow: 6,         // points used for the momentum window
  staleSnapshotMs: 90000, // snapshot older than this → quality LOW
  cooldownMs: 60000,      // min time before a market may flip direction / re-create
  flipMargin: 8,          // new opposite signal must beat the old score by this to flip
  featureStrengthThreshold: 0.34, // a feature counts as "fired" in research at/above this strength
};

// ---- helpers (pure) ----
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export function median(arr) { const a = arr.filter(isNum).sort((x, y) => x - y); if (!a.length) return 0; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
export function mean(arr) { const a = arr.filter(isNum); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
const sign = (d) => (d === 'bull' ? 1 : d === 'bear' ? -1 : 0);

// =====================================================================
//  STAGE 1 — VALIDATION / DATA QUALITY
// =====================================================================
/**
 * @param {MarketSnapshot} m @param {DeepData|undefined} deep @param {ScanContext} ctx @param {number} now @param {*} [config]
 * @returns {QualityReport}
 */
export function validateSnapshot(m, deep, ctx, now, config = DEFAULT_CONFIG) {
  const checks = {};
  const reasons = [];
  const bull = (m && m.outcomes && m.outcomes[0]) || null;

  checks.hasSlug = !!(m && m.slug);
  if (!checks.hasSlug) reasons.push('missing slug');

  checks.hasPricedOutcome = !!(bull && isNum(bull.price));
  if (!checks.hasPricedOutcome) reasons.push('no priced outcome');

  checks.priceInRange = !!(bull && isNum(bull.price) && bull.price > 0 && bull.price < 1);
  if (bull && isNum(bull.price) && !checks.priceInRange) reasons.push('price outside (0,1)');

  checks.volumeValid = !(isNum(m && m.volume) && m.volume < 0);
  if (!checks.volumeValid) reasons.push('negative volume');

  checks.fresh = isNum(ctx && ctx.snapshotTs) ? (now - ctx.snapshotTs) <= config.staleSnapshotMs : true;
  if (!checks.fresh) reasons.push('stale snapshot');

  const hasBook = !!(deep && deep.ob && isNum(deep.ob.imbalance));
  checks.hasLiquidity = hasBook || isNum(m && m.liquidity);
  if (!checks.hasLiquidity) reasons.push('no liquidity/depth');

  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;
  const score = Math.round((passed / total) * 100);
  // reject if we literally cannot score; otherwise ok/low by completeness
  const fatal = !checks.hasSlug || !checks.hasPricedOutcome || !checks.priceInRange || !checks.volumeValid;
  const level = fatal ? 'reject' : (checks.fresh && checks.hasLiquidity ? 'ok' : 'low');
  return { level, score, reasons, checks };
}

// =====================================================================
//  STAGE 2 — FEATURE EXTRACTION  (snapshot-only; no future data)
// =====================================================================
/**
 * @param {MarketSnapshot} m @param {DeepData|undefined} deep @param {ScanContext} ctx @param {*} [config]
 * @returns {FeatureVector}
 */
export function extractFeatures(m, deep, ctx, config = DEFAULT_CONFIG) {
  const outs = (m && m.outcomes) || [];
  const bull = outs[0] || {}; const bear = outs[1] || { price: isNum(bull.price) ? 1 - bull.price : null, volume: null };
  const spikes = (ctx && ctx.spikes) || [];
  const traders = (ctx && ctx.traders) || [];
  /** @type {(a:boolean,d:number,s:number,v:number|null,n:string)=>Omit<FeatureResult,'key'|'label'>} */
  const mk = (a, d, s, v, n) => ({ avail: a ? 1 : 0, dir: a ? d : 0, strength: a ? clamp(s, 0, 1) : 0, value: a ? v : null, note: n });
  /** @type {Record<string, Omit<FeatureResult,'key'|'label'>>} */
  const F = {};

  // 1) Unusual flow — spike on this market, direction translated to YES-side
  const mine = spikes.filter((s) => s.slug && s.slug === m.slug);
  if (mine.length) {
    const s = mine.reduce((a, b) => ((b.magnitude || 0) > (a.magnitude || 0) ? b : a));
    const isNo = (s.tokenId && bear.tokenId && s.tokenId === bear.tokenId) || String(s.tokenId || '').endsWith('__NO');
    const d = (s.direction || 0) * (isNo ? -1 : 1);
    const mag = isNum(s.magnitude) ? s.magnitude : 2;
    F.flow = mk(true, d || 0, (mag - 1.5) / 3, mag, `spike ×${mag} ${d > 0 ? 'bull' : d < 0 ? 'bear' : '?'}`);
  } else F.flow = mk(false, 0, 0, null, 'no spike');

  // 2) Outcome pressure (PCR-analog) — YES vs NO volume
  if (isNum(bull.volume) && isNum(bear.volume) && (bull.volume + bear.volume) > 0) {
    const p = (bull.volume - bear.volume) / (bull.volume + bear.volume);
    F.outcome = mk(true, p > 0 ? 1 : p < 0 ? -1 : 0, Math.abs(p) / 0.5, p, `YES/NO ${Math.round(bull.volume)}/${Math.round(bear.volume)}`);
  } else F.outcome = mk(false, 0, 0, null, 'no outcome volume');

  // 3) Liquidity/depth (OI-analog) — orderbook imbalance is directional; bare liquidity is confirmation
  const ob = deep && deep.ob;
  if (ob && isNum(ob.imbalance)) {
    F.liquidity = mk(true, ob.imbalance > 0 ? 1 : ob.imbalance < 0 ? -1 : 0, Math.abs(ob.imbalance) / 0.5, ob.imbalance, `book imbalance ${(ob.imbalance * 100).toFixed(0)}%`);
  } else if (isNum(m.liquidity)) {
    const rel = m.liquidity / ((ctx && ctx.liqMed) || m.liquidity || 1);
    F.liquidity = mk(true, 0, (rel - 1) / 2, rel, `liquidity ${Math.round(m.liquidity)} (${rel.toFixed(1)}×)`); // dir 0 → confirmation only
  } else F.liquidity = mk(false, 0, 0, null, 'no depth');

  // 5) Price movement — windowed return of the YES series
  const series = deep && deep.series;
  if (series && series.length >= 2) {
    const n = Math.min(config.priceWindow, series.length - 1);
    const ref = series[series.length - 1 - n].price; const last = series[series.length - 1].price;
    const ret = last - ref;
    F.price = mk(true, ret > 0.002 ? 1 : ret < -0.002 ? -1 : 0, Math.abs(ret) / 0.06, ret, `Δ ${ret >= 0 ? '+' : ''}${(ret * 100).toFixed(1)}pts/${n}`);
  } else F.price = mk(false, 0, 0, null, 'no price series');

  // 4) Volume — CONFIRMATION only (dir 0). Independent of price: it measures activity level,
  //    not direction, so it never double-counts the price feature's direction.
  if (isNum(m.volume)) {
    const rel = m.volume / ((ctx && ctx.volMed) || 1);
    F.volume = mk(true, 0, (rel - 1) / 3, rel, `vol ${Math.round(m.volume)} (${rel.toFixed(1)}× med)`);
  } else F.volume = mk(false, 0, 0, null, 'no volume');

  // 6) Smart money — top traders attributed to this market (self-disables without attribution)
  const tr = traders.filter((t) => t.slug && t.slug === m.slug);
  if (tr.length) {
    const net = tr.reduce((a, t) => a + (t.direction || 0) * (t.volume || 1), 0);
    F.smart = mk(true, net > 0 ? 1 : net < 0 ? -1 : 0, clamp(tr.length / 3, 0, 1), net, `${tr.length} top trader(s)`);
  } else F.smart = mk(false, 0, 0, null, 'no attribution');

  const features = COMPONENTS.map((c) => ({ key: c.key, label: c.label, ...F[c.key] }));
  return { features, asOf: (ctx && ctx.snapshotTs) || 0 };
}

// =====================================================================
//  STAGE 3 — SCORING + CONFIDENCE
// =====================================================================
/**
 * Score = |net directional tilt| × data coverage × 100.
 *  - net       : weighted average of DIRECTIONAL features (dir≠0), in [-1,1] — conviction & side.
 *  - coverage  : share of total weight whose data was present (incl. confirmation features) — breadth.
 *  - confidence: coverage as a 0–100 (breadth of evidence), reported separately from score.
 * Confirmation features (dir=0, e.g. volume) raise coverage but never move net → no double counting.
 * @param {FeatureVector} fv @param {*} [config] @returns {ScoreResult}
 */
export function scoreFeatures(fv, config = DEFAULT_CONFIG) {
  const w = config.weights;
  const totalW = Object.values(w).reduce((a, b) => a + Math.max(0, /** @type {number} */(b)), 0) || 1;
  let signed = 0, dirW = 0, availW = 0;
  const comps = fv.features.map((f) => {
    const wn = Math.max(0, w[f.key] || 0) / totalW;
    const contribution = wn * f.avail * f.dir * f.strength;
    signed += contribution;
    availW += wn * f.avail;
    if (f.avail && f.dir !== 0) dirW += wn;
    return { ...f, weight: wn, contribution };
  });
  const net = dirW > 0 ? signed / dirW : 0;
  const coverage = availW;
  const score = Math.round(100 * Math.abs(net) * coverage);
  const dir = dirW === 0 ? 'neutral' : net > config.epsilon ? 'bull' : net < -config.epsilon ? 'bear' : 'neutral';
  return { score, net, coverage, confidence: Math.round(coverage * 100), dir, comps };
}

export const ENGINE_VERSION = 'eng-2.1.0';
export const SCORE_TIERS = [[90, 'Exceptional'], [80, 'Very Strong'], [70, 'Strong'], [60, 'Moderate'], [0, 'Weak']];
export function scoreTier(score) { for (const [min, label] of SCORE_TIERS) if (score >= min) return label; return 'Weak'; }

/** Modular feature registry (signal_engine_v1 pattern): metadata for every scored feature. */
export const FEATURE_DEFS = {
  flow: { name: 'Prediction-Market Flow Anomaly', source: '/flow/spikes', proxy: false, directional: true, explain: 'Unusual prediction-market buy/sell flow on this contract' },
  outcome: { name: 'Outcome Pressure (put/call proxy)', source: '/markets (outcomes)', proxy: true, directional: true, explain: 'YES vs NO contract-volume imbalance — PROXY for put/call skew' },
  liquidity: { name: 'Order-Book Imbalance (OI proxy)', source: '/orderbook', proxy: true, directional: true, explain: 'Prediction-market token bid/ask depth imbalance — PROXY for positioning/OI' },
  volume: { name: 'Contract Volume Anomaly', source: '/markets', proxy: false, directional: false, explain: 'Contract volume vs median — activity confirmation' },
  price: { name: 'Probability Momentum', source: '/prices', proxy: false, directional: true, explain: 'Prediction-market implied-probability momentum — NOT the stock share price' },
  smart: { name: 'Smart-Money Attribution', source: '/flow/top-traders', proxy: false, directional: true, explain: 'Net top-trader direction attributed to this contract' },
};

// ---- Prediction-Market Flow Anomaly helpers ----
// Adapted from the anomaly-vs-baseline METHODOLOGY of unusual-options-scanner (rolling-median
// baseline + ratio anomaly), applied to PVE prediction-market flow/volume. NOT options data.
export function baselineStats(arr) { const a = (arr || []).filter(isNum); return { n: a.length, median: median(a), mean: mean(a) }; }
export function anomalyRatio(cur, arr) {
  const b = baselineStats(arr);
  if (!b.n || !(b.median > 0) || !isNum(cur)) return { ratio: null, score: 0, n: b.n };
  const ratio = cur / b.median;
  return { ratio, score: clamp((ratio - 1) / 2, 0, 1), n: b.n };
}
export function acceleration(arr) {
  const a = (arr || []).filter(isNum);
  if (a.length < 4) return { accel: 0, n: a.length };
  const k = Math.min(3, Math.floor(a.length / 2));
  const recent = mean(a.slice(-k)); const prior = mean(a.slice(-2 * k, -k));
  if (!(prior > 0)) return { accel: 0, n: a.length };
  return { accel: clamp((recent - prior) / prior, -1, 1), n: a.length };
}
export function persistence(arr, threshold) {
  const a = (arr || []).filter(isNum);
  if (!a.length) return { frac: 0, streak: 0, n: 0 };
  const flags = a.map((x) => (x >= threshold ? 1 : 0));
  let streak = 0; for (let i = flags.length - 1; i >= 0; i--) { if (flags[i]) streak++; else break; }
  return { frac: mean(flags), streak, n: a.length };
}
export function regimeFromFlow(flow) {
  const s = flow && isNum(flow.sentiment) ? flow.sentiment : null;
  if (s === null) return { regime: 'unknown', sentiment: null };
  return { regime: s > 0.15 ? 'risk-on' : s < -0.15 ? 'risk-off' : 'neutral', sentiment: s };
}
/** Prediction-Market Flow Anomaly diagnostics for a market, from multi-snapshot history + spikes + flow. */
export function flowDiagnostics(m, ctx) {
  const slug = m && m.slug;
  const hist = (ctx && ctx.marketHist && ctx.marketHist[slug]) || {};
  const mine = ((ctx && ctx.spikes) || []).filter((s) => s.slug === slug);
  const curMag = mine.length ? Math.max(...mine.map((s) => (isNum(s.magnitude) ? s.magnitude : 0))) : 0;
  const volA = anomalyRatio(m && m.volume, hist.vols);
  const flowA = anomalyRatio(curMag, hist.spikeMags);
  const acc = acceleration(hist.vols);
  const per = persistence(hist.spikeMags || [], 1.8);
  const reg = regimeFromFlow(ctx && ctx.flow);
  return {
    volAnomaly: volA.score, volRatio: volA.ratio, flowAnomaly: flowA.score, spikeMagnitude: curMag,
    flowAccel: acc.accel, persistence: per.frac, persistenceStreak: per.streak,
    regime: reg.regime, sentiment: reg.sentiment, samples: hist.vols ? hist.vols.length : 0,
  };
}

// =====================================================================
//  buildSignal — the deep entry point callers use
// =====================================================================
/**
 * @param {MarketSnapshot} m @param {DeepData|undefined} deep @param {ScanContext} ctx @param {number} now @param {*} [config]
 * @returns {{ signal: (*|null), quality: QualityReport }}
 */
export function buildSignal(m, deep, ctx, now, config = DEFAULT_CONFIG) {
  const quality = validateSnapshot(m, deep, ctx, now, config);
  if (quality.level === 'reject') return { signal: null, quality };
  const fv = extractFeatures(m, deep, ctx, config);
  const r = scoreFeatures(fv, config);
  const bull = (m.outcomes || [])[0] || {}; const bear = (m.outcomes || [])[1] || {};
  const diagnostics = flowDiagnostics(m, ctx);
  const proxies = r.comps.filter((c) => c.avail && FEATURE_DEFS[c.key] && FEATURE_DEFS[c.key].proxy).map((c) => c.key);
  const signal = {
    id: m.slug + ':' + r.dir, slug: m.slug, title: m.title || m.slug, tags: m.tags || [],
    assetType: m.asset_type || null, ticker: m.ticker || null, classification: m.classification || null,
    dir: r.dir, score: r.score, tier: scoreTier(r.score), net: r.net, coverage: r.coverage, confidence: r.confidence,
    quality: quality.level, qualityScore: quality.score, qualityReasons: quality.reasons,
    comps: r.comps, proxies, diagnostics, asOf: fv.asOf, engineVersion: ENGINE_VERSION,
    market: { bullPrice: bull.price, bearPrice: isNum(bear.price) ? bear.price : (isNum(bull.price) ? 1 - bull.price : null), volume: m.volume, liquidity: m.liquidity, endDate: m.endDate, status: m.status, outcomes: m.outcomes },
    leadTokenId: bull.tokenId, entryPrice: bull.price,
    ts_created: now, ts_updated: now,
  };
  return { signal, quality };
}

// =====================================================================
//  REPLAY — deterministic reproduction from a persisted input snapshot (no PVE call)
// =====================================================================
/** Capture exactly what buildSignal needs, so the signal can be reproduced later. */
export function captureSnapshot(m, deep, ctx, now, config, classification) {
  const slug = m.slug;
  return {
    engineVersion: ENGINE_VERSION, classifierVersion: (classification && classification.version) || null, now,
    slug, ticker: m.ticker || null, asset_type: m.asset_type || null, classification: classification || m.classification || null,
    market: m, deep: deep || null,
    ctx: {
      spikes: ((ctx && ctx.spikes) || []).filter((s) => s.slug === slug),
      traders: ((ctx && ctx.traders) || []).filter((t) => t.slug === slug),
      volMed: ctx && ctx.volMed, liqMed: ctx && ctx.liqMed, snapshotTs: ctx && ctx.snapshotTs, flow: ctx && ctx.flow,
      marketHist: ctx && ctx.marketHist && ctx.marketHist[slug] ? { [slug]: ctx.marketHist[slug] } : {},
    },
    config: config || null,
  };
}
/** Reproduce the signal from a snapshot. Pure — same inputs → same signal, without calling PVE. */
export function replaySignal(snapshot) {
  const { market, deep, ctx, now, config } = snapshot;
  const cfg = (config && config.weights) ? config : DEFAULT_CONFIG; // guard partial/empty configs
  return buildSignal(market, deep, ctx, now, cfg).signal;
}

// =====================================================================
//  LABELS / FORWARD OUTCOMES  (only place a FUTURE price is used)
// =====================================================================
/**
 * @param {number} entryPrice @param {number} futurePrice @param {'bull'|'bear'|'neutral'} dir @returns {OutcomeLabel}
 */
export function evaluateOutcome(entryPrice, futurePrice, dir) {
  if (!isNum(entryPrice) || !isNum(futurePrice)) return { done: false };
  const delta = futurePrice - entryPrice;
  const favPts = (dir === 'bull' ? 1 : -1) * delta;
  return { done: true, price: futurePrice, delta, deltaPct: entryPrice ? (delta / entryPrice) * 100 : null, favPts, win: favPts > 0 };
}
/**
 * @param {number} mfe @param {number} mae @param {number} entryPrice @param {number} cur @param {'bull'|'bear'|'neutral'} dir
 * @returns {{mfe:number,mae:number}}
 */
export function updateExcursion(mfe, mae, entryPrice, cur, dir) {
  if (!isNum(entryPrice) || !isNum(cur)) return { mfe: mfe || 0, mae: mae || 0 };
  const fav = (dir === 'bull' ? 1 : -1) * (cur - entryPrice);
  return { mfe: Math.max(mfe || 0, fav), mae: Math.min(mae || 0, fav) };
}

// =====================================================================
//  DEDUPLICATION / COOLDOWN  (pure decision; caller holds state)
// =====================================================================
/**
 * @param {*} existing signal already tracked for the SAME market (any direction), or null
 * @param {*} candidate freshly built signal @param {*} config @param {number} now
 * @returns {{action:('create'|'update'|'flip'|'suppress'),reason:string}}
 */
export function emitDecision(existing, candidate, config, now) {
  if (!existing) return { action: 'create', reason: 'new market signal' };
  if (existing.dir === candidate.dir) return { action: 'update', reason: 'refresh same-direction signal' };
  const age = now - existing.ts_created;
  if (age < config.cooldownMs) return { action: 'suppress', reason: `cooldown ${Math.ceil((config.cooldownMs - age) / 1000)}s` };
  if (candidate.score < existing.score + config.flipMargin) return { action: 'suppress', reason: `flip needs +${config.flipMargin} (${candidate.score} vs ${existing.score})` };
  return { action: 'flip', reason: 'direction reversed with margin' };
}

// =====================================================================
//  RESEARCH / BACKTEST AGGREGATION  (pure; operate on stored history rows)
//  row: { ts, score, dir, entryPrice, mfe, mae, comps:[{key,avail,dir,strength}], evals:{h:{done,favPts,win,deltaPct}} }
// =====================================================================
export const DEFAULT_BUCKETS = [[50, 60], [60, 70], [70, 80], [80, 90], [90, 101]];

function statsOf(rows, h) {
  const done = rows.filter((r) => r.evals && r.evals[h] && r.evals[h].done);
  const fav = done.map((r) => r.evals[h].favPts);
  const wins = done.filter((r) => r.evals[h].win).length;
  const winRate = done.length ? wins / done.length : null;
  return { n: done.length, winRate, fpr: winRate === null ? null : 1 - winRate, avgFav: done.length ? mean(fav) : null, medFav: done.length ? median(fav) : null };
}

/** @param {*[]} rows @param {{horizons:number[],buckets?:number[][]}} opts */
export function bucketPerformance(rows, opts) {
  const buckets = opts.buckets || DEFAULT_BUCKETS;
  return buckets.map(([lo, hi]) => {
    const inb = rows.filter((r) => r.score >= lo && r.score < hi);
    const byHorizon = {};
    for (const h of opts.horizons) byHorizon[h] = statsOf(inb, h);
    const avgMfe = mean(inb.map((r) => r.mfe)); const avgMae = mean(inb.map((r) => r.mae));
    const avgRange = mean(inb.map((r) => (r.mfe || 0) - (r.mae || 0))); // hypothetical-hold peak-to-trough drawdown proxy
    return { bucket: `${lo}\u2013${hi === 101 ? 100 : hi}`, lo, hi, n: inb.length, byHorizon, avgMfe, avgMae, avgRange };
  });
}

/** did a feature "fire" (present, strong, and — if directional — aligned with the signal)? */
function fired(row, key, thr) {
  const c = row.comps && row.comps.find((x) => x.key === key);
  if (!c || !c.avail || c.strength < thr) return false;
  if (c.dir === 0) return true; // confirmation feature: presence counts
  return Math.sign(c.dir) === sign(row.dir);
}

/** @param {*[]} rows @param {{horizons:number[],thr?:number}} opts */
export function featurePerformance(rows, opts) {
  const thr = opts.thr ?? DEFAULT_CONFIG.featureStrengthThreshold;
  const baseline = {};
  for (const h of opts.horizons) baseline[h] = statsOf(rows, h);
  const perFeature = COMPONENTS.map((c) => {
    const hit = rows.filter((r) => fired(r, c.key, thr));
    const byHorizon = {};
    for (const h of opts.horizons) byHorizon[h] = statsOf(hit, h);
    return { key: c.key, label: c.label, fired: hit.length, byHorizon };
  });
  return { baseline, perFeature };
}

/** @param {*[]} rows @param {string[][]} combos @param {{horizons:number[],thr?:number}} opts */
export function combinationPerformance(rows, combos, opts) {
  const thr = opts.thr ?? DEFAULT_CONFIG.featureStrengthThreshold;
  return combos.map((combo) => {
    const hit = rows.filter((r) => combo.every((k) => fired(r, k, thr)));
    const byHorizon = {};
    for (const h of opts.horizons) byHorizon[h] = statsOf(hit, h);
    return { combo, label: combo.join(' + '), n: hit.length, byHorizon };
  });
}

/** out-of-sample split by time (later rows = test). @param {*[]} rows @param {number} [ratio] */
export function splitByTime(rows, ratio = 0.7) {
  const s = rows.slice().sort((a, b) => a.ts - b.ts);
  const idx = Math.floor(s.length * ratio);
  return { train: s.slice(0, idx), test: s.slice(idx) };
}

/** walk-forward metric stability across sequential folds (validation scaffolding, no weight fitting). */
export function walkForward(rows, folds, horizon) {
  const s = rows.slice().sort((a, b) => a.ts - b.ts);
  const chunk = Math.floor(s.length / (folds + 1));
  if (chunk < 1) return [];
  const out = [];
  for (let i = 1; i <= folds; i++) {
    const train = s.slice(0, i * chunk);
    const test = s.slice(i * chunk, (i + 1) * chunk);
    out.push({ fold: i, trainN: train.length, test: statsOf(test, horizon) });
  }
  return out;
}

/** Generic grouped performance — e.g. by direction or by market regime. groups: {label: predicate}. */
export function groupPerformance(rows, groups, opts) {
  return Object.entries(groups).map(([label, pred]) => {
    const g = rows.filter(pred);
    const byHorizon = {};
    for (const h of opts.horizons) byHorizon[h] = statsOf(g, h);
    return { label, n: g.length, byHorizon };
  });
}
