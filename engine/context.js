// Phase 4 input providers (spec §10, §11, §12, §13, §14).
// These produce the REAL values that engine/features.js consumers were previously fed null for.
// Every fetch is cached and shared across tickers so the rate-limit cost stays flat.

import { timeBucket } from '../store/normalize.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const r2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : null);

// ---------------------------------------------------------------------------
// RVOL vs the ticker's OWN same-time-of-day volume baseline (spec §10)
// ---------------------------------------------------------------------------
// Cumulative session volume up to now, compared with what this ticker normally
// has done by this clock time. Insufficient history => null (never a fake 1.0).
export async function computeRvol({ baselines, ticker, intraday, at, record = true }) {
  if (!baselines || !intraday || !intraday.available || !Array.isArray(intraday.rawBars)) {
    return { available: false, rvol: null, reason: 'no_intraday_volume' };
  }
  const sessionVol = intraday.rawBars.reduce((a, b) => a + (isNum(b.volume) ? b.volume : 0), 0);
  if (!sessionVol) return { available: false, rvol: null, reason: 'no_volume_data' };

  const norm = baselines.normalize(ticker, 'sessionVolume', sessionVol, at);
  if (record) { try { await baselines.record(ticker, 'sessionVolume', sessionVol, at); } catch { /* non-fatal */ } }
  if (!isNum(norm.mean) || norm.mean <= 0 || norm.n < 10) {
    return { available: false, rvol: null, reason: 'insufficient_history', observations: norm.n, sessionVolume: sessionVol };
  }
  return { available: true, rvol: r2(sessionVol / norm.mean), sessionVolume: sessionVol, baselineMean: r2(norm.mean), observations: norm.n, percentile: norm.percentile, bucket: norm.bucket };
}

// ---------------------------------------------------------------------------
// MARKET REGIME from SPY/QQQ (spec §11) — fetched ONCE per cycle, shared by all tickers
// ---------------------------------------------------------------------------
export class MarketContext {
  constructor(provider, { ttlMs = 5 * 60000 } = {}) { this.p = provider; this.ttlMs = ttlMs; this.cache = null; this.at = 0; }

  async get() {
    if (this.cache && Date.now() - this.at < this.ttlMs) return this.cache;
    const out = { available: false, spyTrend: null, qqqTrend: null, spyVsVwap: null, qqqVsVwap: null, fetchedAt: new Date().toISOString() };
    try {
      const trend = async (sym) => {
        if (!this.p || !this.p.getIntraday) return { trend: null, vsVwap: null };
        const iv = await this.p.getIntraday(sym).catch(() => null);
        if (!iv || !iv.available || !isNum(iv.vwap) || !isNum(iv.last)) return { trend: null, vsVwap: null };
        const vsVwap = ((iv.last - iv.vwap) / iv.vwap) * 100;
        return { trend: vsVwap > 0.05 ? 'up' : vsVwap < -0.05 ? 'down' : 'flat', vsVwap: r2(vsVwap) };
      };
      const [spy, qqq] = await Promise.all([trend('SPY'), trend('QQQ')]);
      out.spyTrend = spy.trend; out.spyVsVwap = spy.vsVwap;
      out.qqqTrend = qqq.trend; out.qqqVsVwap = qqq.vsVwap;
      out.available = !!(spy.trend || qqq.trend);
    } catch (e) { out.error = e.message; }
    this.cache = out; this.at = Date.now();
    return out;
  }
}

// ---------------------------------------------------------------------------
// IV SKEW CHANGE (spec §14) — needs a prior observation; levels alone are not used
// ---------------------------------------------------------------------------
export class IvSkewTracker {
  constructor({ maxAgeMs = 30 * 60000 } = {}) { this.prev = new Map(); this.maxAgeMs = maxAgeMs; }

  // contracts: normalized chain contracts with {type, strike, iv}
  snapshot(contracts, spot) {
    if (!Array.isArray(contracts) || !isNum(spot)) return null;
    const near = contracts.filter((c) => isNum(c.iv) && c.iv > 0 && isNum(c.strike));
    if (near.length < 4) return null;
    const atmOf = (type) => {
      const set = near.filter((c) => c.type === type);
      if (!set.length) return null;
      return set.reduce((b, c) => (Math.abs(c.strike - spot) < Math.abs(b.strike - spot) ? c : b), set[0]).iv;
    };
    // OTM put = 5-15% below spot; used for the smirk
    const otmPuts = near.filter((c) => c.type === 'put' && c.strike < spot * 0.95 && c.strike > spot * 0.85);
    const otmPutIv = otmPuts.length ? otmPuts.reduce((a, c) => a + c.iv, 0) / otmPuts.length : null;
    return { callIv: atmOf('call'), putIv: atmOf('put'), otmPutIv, at: Date.now() };
  }

  // Returns CHANGES vs the previous snapshot for this ticker, then stores the new one.
  update(ticker, contracts, spot) {
    const snap = this.snapshot(contracts, spot);
    if (!snap) return { available: false, reason: 'insufficient_iv_data' };
    const prev = this.prev.get(ticker);
    this.prev.set(ticker, snap);
    if (!prev || Date.now() - prev.at > this.maxAgeMs) return { available: false, reason: 'no_prior_snapshot' };
    const d = (a, b) => (isNum(a) && isNum(b) ? a - b : null);
    return {
      available: true,
      callIvChange: d(snap.callIv, prev.callIv),
      putIvChange: d(snap.putIv, prev.putIv),
      atmIvChange: d((snap.callIv + snap.putIv) / 2, (prev.callIv + prev.putIv) / 2),
      otmPutIvChange: d(snap.otmPutIv, prev.otmPutIv),
      elapsedMs: snap.at - prev.at,
    };
  }
}

// ---------------------------------------------------------------------------
// EARNINGS PROXIMITY (spec §13) — cached per ticker per day
// ---------------------------------------------------------------------------
export class EarningsCalendar {
  constructor(provider, { ttlMs = 12 * 3600000 } = {}) { this.p = provider; this.ttlMs = ttlMs; this.cache = new Map(); }

  async daysAway(ticker) {
    const hit = this.cache.get(ticker);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.days;
    let days = null;
    try {
      if (this.p && this.p.getEarnings) {
        const e = await this.p.getEarnings(ticker).catch(() => null);
        const raw = e && (e.nextEarningsDate || e.next_earnings_date || e.date);
        const ts = raw ? Date.parse(raw) : NaN;
        if (Number.isFinite(ts)) days = Math.round((ts - Date.now()) / 86400000);
      }
    } catch { days = null; }
    this.cache.set(ticker, { days, at: Date.now() });
    return days;
  }
}

// ---------------------------------------------------------------------------
// EVENT-DAY FLAGS (spec §12) — derived from the calendar, no external call
// ---------------------------------------------------------------------------
export function eventFlags(at = new Date()) {
  const d = new Date(at);
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = et.getDay(), dom = et.getDate();
  // monthly OPEX = third Friday
  const isOpex = dow === 5 && dom >= 15 && dom <= 21;
  return { isOpex, timeBucket: timeBucket(d), dayOfWeek: dow, note: 'FOMC/CPI flags require an external macro calendar; not inferred' };
}

// ---------------------------------------------------------------------------
// CROSS-SECTIONAL RANKING (spec §23)
// ---------------------------------------------------------------------------
export function crossSectionalRank(rows, { scoreKey = 'productionScore' } = {}) {
  const valid = rows.filter((r) => isNum(r[scoreKey]));
  const n = valid.length;
  if (!n) return { available: false, ranked: rows, reason: 'no_scores' };
  const sorted = [...valid].sort((a, b) => b[scoreKey] - a[scoreKey]);
  const rankOf = new Map(sorted.map((r, i) => [r.ticker, i + 1]));
  const ranked = rows.map((r) => {
    const rank = rankOf.get(r.ticker) ?? null;
    const pctile = rank ? Math.round(((n - rank) / n) * 1000) / 10 : null;
    return { ...r, scoreRank: rank, scorePercentile: pctile, decile: pctile == null ? null : Math.min(10, Math.floor((100 - pctile) / 10) + 1), topDecile: pctile != null && pctile >= 90 };
  });
  const bull = sorted.filter((r) => r.dir === 'bull' || r.signal === 'CALL').slice(0, 10).map((r) => r.ticker);
  const bear = sorted.filter((r) => r.dir === 'bear' || r.signal === 'PUT').slice(0, 10).map((r) => r.ticker);
  return { available: true, universe: n, ranked, topBullish: bull, topBearish: bear, topDecileTickers: ranked.filter((r) => r.topDecile).map((r) => r.ticker) };
}
