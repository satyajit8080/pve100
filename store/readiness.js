// UW-only operational layer (spec §3, §5, §6, §7, §12, §13, §14).
// Every feature reports an explicit state. Nothing is fabricated, nothing falls back to
// another provider: if UW cannot supply it, the state is UNAVAILABLE.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const r2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : null);

export const FEATURE_STATE = { READY: 'READY', WARMING_UP: 'WARMING_UP', UNAVAILABLE: 'UNAVAILABLE' };
export const DATA_STATE = { VALID: 'VALID', STALE: 'STALE', MISSING: 'MISSING', INVALID: 'INVALID', UNAVAILABLE: 'UNAVAILABLE' };
export const RVOL_REQUIRED_OBS = 10;

// ---------------------------------------------------------------------------
// §3 RVOL readiness — per ticker × time-of-day bucket
// ---------------------------------------------------------------------------
export function rvolReadiness({ baselines, ticker, bucket = null, rvolResult = null }) {
  if (!baselines) return { state: FEATURE_STATE.UNAVAILABLE, reason: 'NO_BASELINE_STORE', rvol: null };
  let observations = 0;
  try { observations = baselines.history(ticker, bucket, 'sessionVolume').length; } catch { observations = 0; }
  if (rvolResult && rvolResult.available && isNum(rvolResult.rvol)) {
    return { state: FEATURE_STATE.READY, ticker, bucket, observations, required: RVOL_REQUIRED_OBS, rvol: r2(rvolResult.rvol), dataTimestamp: rvolResult.at || null };
  }
  if (rvolResult && rvolResult.reason === 'no_intraday_volume') {
    return { state: FEATURE_STATE.UNAVAILABLE, reason: 'UW_INTRADAY_VOLUME_UNAVAILABLE', ticker, bucket, observations, required: RVOL_REQUIRED_OBS, rvol: null };
  }
  return { state: FEATURE_STATE.WARMING_UP, ticker, bucket, observations, required: RVOL_REQUIRED_OBS, rvol: null, reason: 'INSUFFICIENT_HISTORY' };
}

// ---------------------------------------------------------------------------
// §4 IV-skew readiness
// ---------------------------------------------------------------------------
export function ivSkewReadiness(result) {
  if (!result) return { state: FEATURE_STATE.UNAVAILABLE, reason: 'NOT_COMPUTED', ivSkewChange: null };
  if (result.available) return { state: FEATURE_STATE.READY, ivSkewChange: result.putCallIvSpreadChange ?? result.callIvChange ?? null, elapsedMs: result.elapsedMs ?? null, ...result };
  if (result.reason === 'no_prior_snapshot') return { state: FEATURE_STATE.WARMING_UP, reason: 'AWAITING_SECOND_SNAPSHOT', ivSkewChange: null };
  if (result.reason === 'insufficient_iv_data') return { state: FEATURE_STATE.UNAVAILABLE, reason: 'UW_IV_DATA_INSUFFICIENT', ivSkewChange: null };
  return { state: FEATURE_STATE.UNAVAILABLE, reason: String(result.reason || 'UNKNOWN').toUpperCase(), ivSkewChange: null };
}

// ---------------------------------------------------------------------------
// §5 Sector relative strength — UW sector-tide + per-ticker sector, no external data
// ---------------------------------------------------------------------------
export function sectorRelativeStrength({ ticker, sector = null, sectorTide = null, marketTide = null }) {
  if (!sector) return { state: FEATURE_STATE.UNAVAILABLE, reason: 'UW_SECTOR_UNKNOWN_FOR_TICKER', sectorRelativeStrength: null, sectorTrend: null };
  if (!sectorTide || !sectorTide.available || !Array.isArray(sectorTide.rows) || !sectorTide.rows.length) {
    return { state: FEATURE_STATE.UNAVAILABLE, reason: 'UW_SECTOR_TIDE_UNAVAILABLE', sector, sectorRelativeStrength: null, sectorTrend: null };
  }
  const row = sectorTide.rows.find((r) => String(r.sector).toLowerCase() === String(sector).toLowerCase());
  if (!row || !isNum(row.net)) return { state: FEATURE_STATE.UNAVAILABLE, reason: 'UW_SECTOR_NOT_IN_TIDE', sector, sectorRelativeStrength: null, sectorTrend: null };

  const nets = sectorTide.rows.map((r) => r.net).filter(isNum);
  const mean = nets.reduce((a, b) => a + b, 0) / nets.length;
  const sd = Math.sqrt(nets.reduce((a, b) => a + (b - mean) ** 2, 0) / (nets.length - 1 || 1));
  const rs = sd > 0 ? (row.net - mean) / sd : null;                 // sector vs the other sectors
  const vsMarket = (marketTide && isNum(marketTide.net) && marketTide.net !== 0) ? row.net / Math.abs(marketTide.net) : null;
  return {
    state: FEATURE_STATE.READY, ticker, sector,
    sectorNetPremium: row.net, sectorRelativeStrength: r2(rs),
    sectorTrend: row.net > 0 ? 'up' : row.net < 0 ? 'down' : 'flat',
    sectorVsMarket: r2(vsMarket), peers: nets.length,
  };
}

// ---------------------------------------------------------------------------
// §6 Macro events — UW exposes no macro calendar; report UNAVAILABLE, never invent
// ---------------------------------------------------------------------------
export function macroReadiness({ uwSupportsMacroCalendar = false, events = null } = {}) {
  if (!uwSupportsMacroCalendar || !events) {
    return { state: FEATURE_STATE.UNAVAILABLE, reason: 'UW_ENDPOINT_UNAVAILABLE', macroEvent: null, note: 'UW exposes no FOMC/CPI calendar; no external provider permitted, so macro stays null.' };
  }
  return { state: FEATURE_STATE.READY, macroEvent: events };
}

// ---------------------------------------------------------------------------
// §7 UW rate-limit manager — counting, priority, backoff, dedupe, partial scans
// ---------------------------------------------------------------------------
export const PRIORITY = { flow: 1, netPremium: 2, gex: 3, underlying: 4, greeks: 5, context: 6 };

export class RateLimiter {
  // maxPerMinute defaults to null: UW's real limit is NOT published per-tier, so we do not
  // invent one (§7 — track what UW exposes, never guess). Set UW_MAX_PER_MINUTE to opt in.
  constructor({ maxPerMinute = null, maxPerScan = 2000, dailyQuota = null } = {}) {
    this.maxPerMinute = maxPerMinute; this.maxPerScan = maxPerScan; this.dailyQuota = dailyQuota;
    this.window = []; this.scanCount = 0; this.totalCount = 0;
    this.remaining = null; this.limit = null;      // from UW headers when exposed
    this.failures = []; this.inflight = new Map();
  }

  _prune(now) { const cut = now - 60000; while (this.window.length && this.window[0] < cut) this.window.shift(); }

  canRequest(now = Date.now()) {
    this._prune(now);
    if (this.scanCount >= this.maxPerScan) return { ok: false, reason: 'SCAN_BUDGET_EXHAUSTED' };
    if (isNum(this.remaining) && this.remaining <= 0) return { ok: false, reason: 'UW_QUOTA_EXHAUSTED' };
    if (isNum(this.maxPerMinute) && this.window.length >= this.maxPerMinute) return { ok: false, reason: 'RATE_WINDOW_FULL', retryAfterMs: 60000 - (now - this.window[0]) };
    return { ok: true };
  }

  record(now = Date.now()) { this._prune(now); this.window.push(now); this.scanCount++; this.totalCount++; if (isNum(this.remaining)) this.remaining--; }

  // UW exposes limits via headers when available; we never guess them.
  readHeaders(headers) {
    if (!headers || typeof headers.get !== 'function') return;
    const rem = Number(headers.get('x-ratelimit-remaining'));
    const lim = Number(headers.get('x-ratelimit-limit'));
    if (Number.isFinite(rem)) this.remaining = rem;
    if (Number.isFinite(lim)) this.limit = lim;
  }

  backoffMs(attempt) { return Math.min(30000, 500 * 2 ** attempt); }

  logFailure(endpoint, error, attempt) { this.failures.push({ endpoint, error: String(error).slice(0, 200), attempt, at: new Date().toISOString() }); if (this.failures.length > 200) this.failures.shift(); }

  // Duplicate-request prevention: identical in-flight calls share one promise.
  dedupe(key, fn) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = Promise.resolve().then(fn).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  beginScan() { this.scanCount = 0; this.failures = []; }
  stats() {
    return { requestsThisScan: this.scanCount, requestsTotal: this.totalCount, perMinuteUsed: this.window.length, perMinuteLimit: this.maxPerMinute,
      uwRemaining: this.remaining, uwLimit: this.limit, failures: this.failures.length, scanBudget: this.maxPerScan };
  }
}

// Order work so the most important UW data is fetched before any budget runs out (§7).
export function prioritizeRequests(requests) {
  return [...requests].sort((a, b) => (PRIORITY[a.kind] ?? 99) - (PRIORITY[b.kind] ?? 99));
}

// ---------------------------------------------------------------------------
// §12 Promotion gate — v2 stays SHADOW until its OWN data clears every bar
// ---------------------------------------------------------------------------
export const PROMOTION_REQUIREMENTS = { minSample: 100, minRankIC: 0.02, minPeriods: 2 };

export function promotionGate(report, reqs = PROMOTION_REQUIREMENTS) {
  const h = (report && report.byHorizon && report.byHorizon['30m']) || null;
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed: !!passed, detail });

  const n = h ? h.n : 0;
  add('sufficient_sample', n >= reqs.minSample, `${n}/${reqs.minSample} resolved observations`);

  const v2ic = h && h.v2RankIC ? h.v2RankIC.ic : null;
  const v1ic = h && h.rankIC ? h.rankIC.ic : null;
  add('v2_rank_ic', isNum(v2ic) && v2ic >= reqs.minRankIC, `v2 rank IC ${v2ic ?? 'n/a'} (need >= ${reqs.minRankIC})`);
  add('v2_beats_v1_ic', isNum(v2ic) && isNum(v1ic) && v2ic > v1ic, `v2 ${v2ic ?? 'n/a'} vs v1 ${v1ic ?? 'n/a'}`);

  const v2td = h && h.v2TopDecile ? h.v2TopDecile.precision : null;
  const v1td = h && h.topDecile ? h.topDecile.precision : null;
  add('v2_top_decile', isNum(v2td) && isNum(v1td) && v2td > v1td, `v2 ${v2td ?? 'n/a'}% vs v1 ${v1td ?? 'n/a'}%`);

  add('acceptable_mae', isNum(h && h.avgMAE) ? h.avgMAE > -5 : false, `avg MAE ${h ? h.avgMAE : 'n/a'}%`);
  add('positive_forward_return', isNum(h && h.avgReturn) ? h.avgReturn > 0 : false, `avg 30m return ${h ? h.avgReturn : 'n/a'}%`);
  add('no_look_ahead_suspicion', !(isNum(v2ic) && Math.abs(v2ic) > 0.10), isNum(v2ic) && Math.abs(v2ic) > 0.10 ? 'IC > 0.10 — investigate leakage before trusting' : 'IC within believable range');
  add('multi_period_stability', false, 'walk-forward across >= 2 periods not yet evaluated');

  const passed = checks.every((c) => c.passed);
  return {
    status: 'SHADOW',                                  // v2 is never auto-promoted
    promotion: passed ? 'ELIGIBLE_FOR_REVIEW' : 'NOT_READY',
    checks, passedCount: checks.filter((c) => c.passed).length, totalChecks: checks.length,
    note: 'Promotion is a human decision. Even when every check passes, v2 stays SHADOW until a person promotes it.',
  };
}

// ---------------------------------------------------------------------------
// §13 Overall research readiness for the UI
// ---------------------------------------------------------------------------
export function researchReadiness({ report = null, rvol = null, ivSkew = null, sector = null, macro = null, journalCount = 0 } = {}) {
  const h = (k) => (report && report.byHorizon && report.byHorizon[k]) || null;
  const gate = promotionGate(report);
  return {
    signals: journalCount,
    resolved: { '15m': h('15m') ? h('15m').n : 0, '30m': h('30m') ? h('30m').n : 0, '60m': h('60m') ? h('60m').n : 0, close: h('close') ? h('close').n : 0 },
    features: {
      rvol: rvol ? rvol.state : FEATURE_STATE.UNAVAILABLE,
      ivSkew: ivSkew ? ivSkew.state : FEATURE_STATE.UNAVAILABLE,
      sector: sector ? sector.state : FEATURE_STATE.UNAVAILABLE,
      macro: macro ? macro.state : FEATURE_STATE.UNAVAILABLE,
    },
    metrics: {
      v1RankIC: h('30m') && h('30m').rankIC ? h('30m').rankIC.ic : null,
      v2RankIC: h('30m') && h('30m').v2RankIC ? h('30m').v2RankIC.ic : null,
      v1TopDecile: h('30m') && h('30m').topDecile ? h('30m').topDecile.precision : null,
      v2TopDecile: h('30m') && h('30m').v2TopDecile ? h('30m').v2TopDecile.precision : null,
    },
    v2Status: gate.status, promotion: gate.promotion, gate,
    dataSource: 'UNUSUAL_WHALES_ONLY',
    note: 'All values are actual. Features with no data report UNAVAILABLE or WARMING_UP rather than a placeholder number.',
  };
}
