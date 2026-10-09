// @ts-check
/*
 * providers/unusualwhales.js — Unusual Whales v1 provider. Drop-in for PveOptionsProvider: same
 * method interface + normalized shapes, so production scoring is untouched. Field mappings below are
 * LOCKED against real responses captured by scripts/uw-diagnostic.mjs (2026-08-24). Base
 * https://api.unusualwhales.com, Bearer UNUSUAL_WHALES_API_TOKEN. Every method degrades to
 * { available:false } on error — a bad field never crashes the app. UW numbers often arrive as
 * strings; n() coerces them.
 */
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const n = (x) => (isNum(x) ? x : (typeof x === 'string' && x.trim() !== '' && Number.isFinite(+x) ? +x : null));
const pick = (o, ...keys) => { if (!o) return null; for (const k of keys) { const v = n(o[k]); if (v != null) return v; } return null; };
const str = (o, ...keys) => { if (!o) return null; for (const k of keys) { const v = o[k]; if (v != null && v !== '') return v; } return null; };
const sum = (o, ...keys) => { let t = 0, seen = false; for (const k of keys) { const v = n(o && o[k]); if (v != null) { t += v; seen = true; } } return seen ? t : null; };
const arr = (j) => (Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []));
const enc = encodeURIComponent;
const last = (a) => (Array.isArray(a) && a.length ? a[a.length - 1] : null);

// OCC option symbol → {type, strike, expiration}. e.g. NVDA261218P00019000 → put 190 2026-12-18
function parseOcc(sym) {
  const m = /^[.]?([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(sym || '').trim());
  if (!m) return null;
  const [, , yy, mm, dd, cp, k8] = m;
  return { type: cp === 'C' ? 'call' : 'put', expiration: `20${yy}-${mm}-${dd}`, strike: parseInt(k8, 10) / 1000 };
}

export class UnusualWhalesOptionsProvider {
  constructor({ apiKey, baseUrl = 'https://api.unusualwhales.com', limiter = null } = {}) { this.name = 'uw'; this.apiKey = apiKey; this.limiter = limiter; this.baseUrl = String(baseUrl).replace(/\/$/, ''); }
  // §7 rate-limit aware fetch: dedupe identical in-flight calls, honour UW headers,
  // exponential backoff on 429/5xx, and NEVER leak the token in an error message.
  async _get(pathq, { attempt = 0, maxAttempts = 3 } = {}) {
    const limiter = this.limiter;
    const run = async () => {
      if (limiter) {
        const gate = limiter.canRequest();
        if (!gate.ok) {
          if (gate.reason === 'RATE_WINDOW_FULL' && attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, Math.min(gate.retryAfterMs || 1000, 5000)));
            return this._get(pathq, { attempt: attempt + 1, maxAttempts });
          }
          const err = new Error(`UW request refused: ${gate.reason}`); err.rateLimited = true; throw err;
        }
        limiter.record();
      }
      let res;
      try { res = await fetch(`${this.baseUrl}${pathq}`, { headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json, text/plain' } }); }
      catch (e) { if (limiter) limiter.logFailure(pathq, e.message, attempt); throw new Error(`UW network error on ${pathq}`); }
      if (limiter) limiter.readHeaders(res.headers);
      // 429 with an explicit "0 remaining" means the quota is gone — retrying only burns time
      // and more requests, so fail fast and let the caller report a partial scan (§7).
      if (res.status === 429 && limiter && isNum(limiter.remaining) && limiter.remaining <= 0) {
        limiter.logFailure(pathq, 'quota exhausted (429, remaining=0)', attempt);
        const err = new Error('UW quota exhausted'); err.rateLimited = true; throw err;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        if (limiter) limiter.logFailure(pathq, `status ${res.status}`, attempt);
        await new Promise((r) => setTimeout(r, limiter ? limiter.backoffMs(attempt) : 500 * 2 ** attempt));
        return this._get(pathq, { attempt: attempt + 1, maxAttempts });
      }
      if (!res.ok) { if (limiter) limiter.logFailure(pathq, `status ${res.status}`, attempt); throw new Error(`UW ${res.status} on ${pathq}`); }
      return res.json();
    };
    return limiter ? limiter.dedupe(`${pathq}`, run) : run();
  }

  // underlying (real-time): GET /api/stock/{t}/stock-state → close/prev_close/volume/market_time
  async getUnderlying(ticker) {
    try {
      const t = ticker.toUpperCase();
      const d = (await this._get(`/api/stock/${enc(t)}/stock-state`)).data || {};
      const price = pick(d, 'close', 'last', 'price'), prevClose = pick(d, 'prev_close', 'previous_close');
      return { available: isNum(price), underlying: { price, prevClose, volume: pick(d, 'volume', 'total_volume'), session: str(d, 'market_time'), available: isNum(price) } };
    } catch (e) { return { available: false, error: e.message }; }
  }

  // chain: GET /api/stock/{t}/option-contracts (per-contract stats) + OCC-symbol parse + merged flow
  async getChain(ticker) {
    const t = ticker.toUpperCase();
    const emptyChain = { ticker: t, asOf: new Date().toISOString(), underlying: { available: false }, contracts: [], fieldsAvailable: { chain: false }, flow: { available: false, largeTrades: [] } };
    try {
      let underlying = null; try { const u = await this.getUnderlying(t); if (u.available) underlying = u.underlying; } catch {}
      const rows = arr(await this._get(`/api/stock/${enc(t)}/option-contracts`));
      const contracts = rows.map((r) => {
        const sym = typeof r === 'string' ? r : str(r, 'option_symbol', 'symbol', 'option_chain', 'chain', 'id');
        const occ = parseOcc(sym);
        const o = typeof r === 'string' ? {} : (r || {});
        const bid = pick(o, 'bid', 'nbbo_bid', 'bid_price'), ask = pick(o, 'ask', 'nbbo_ask', 'ask_price');
        const type = (str(o, 'type', 'option_type', 'right') || '').toLowerCase();
        return {
          type: occ ? occ.type : (type.startsWith('c') ? 'call' : type.startsWith('p') ? 'put' : type),
          strike: occ ? occ.strike : pick(o, 'strike', 'strike_price'),
          expiration: occ ? occ.expiration : str(o, 'expiry', 'expiration', 'expiration_date'),
          volume: pick(o, 'volume', 'total_volume', 'day_volume'), openInterest: pick(o, 'open_interest', 'oi', 'prev_oi', 'open_interest_change'),
          iv: pick(o, 'implied_volatility', 'iv', 'iv_end'),
          delta: pick(o, 'delta'), gamma: pick(o, 'gamma'), theta: pick(o, 'theta'), vega: pick(o, 'vega'),
          bid, ask, mid: isNum(bid) && isNum(ask) ? (bid + ask) / 2 : pick(o, 'mid', 'last', 'last_price', 'avg_price'),
          last: pick(o, 'last', 'last_price', 'avg_price', 'close'),
        };
      }).filter((c) => c.type === 'call' || c.type === 'put');
      const spot = underlying && isNum(underlying.price) ? underlying.price : null;
      const any = (f) => contracts.some(f);
      const chain = {
        ticker: t, asOf: new Date().toISOString(),
        underlying: underlying || { price: spot, volume: null, prevClose: null, available: isNum(spot) },
        contracts,
        fieldsAvailable: { chain: contracts.length > 0, greeks: any((c) => isNum(c.gamma)), iv: any((c) => isNum(c.iv)), oi: any((c) => isNum(c.openInterest)), quotes: any((c) => isNum(c.bid) && isNum(c.ask)), trades: any((c) => isNum(c.last)), underlying: isNum(spot), sweeps: false },
        flow: { available: false, largeTrades: [] },
      };
      try { const f = await this.getFlowDetailed(t, { limit: 100 }); if (f.available) { chain.flow = { available: true, largeTrades: f.trades }; chain.fieldsAvailable.sweeps = true; } } catch { /* optional */ }
      return { available: contracts.length > 0, chain };
    } catch (e) { return { available: false, error: e.message, chain: emptyChain }; }
  }

  // GEX: GET /api/stock/{t}/greek-exposure → latest date; net = call+put per greek
  async getGex(ticker) {
    try {
      const d = last(arr(await this._get(`/api/stock/${enc(ticker.toUpperCase())}/greek-exposure`))) || {};
      const net_gex = sum(d, 'call_gamma', 'put_gamma');
      return {
        available: isNum(net_gex) || isNum(sum(d, 'call_delta', 'put_delta')),
        net_gex, net_dex: sum(d, 'call_delta', 'put_delta'), net_vanna: sum(d, 'call_vanna', 'put_vanna'), net_charm: sum(d, 'call_charm', 'put_charm'), net_theta: null,
        call_gex: pick(d, 'call_gamma'), put_gex: pick(d, 'put_gamma'),
        gamma_flip: null, call_wall: null, put_wall: null, // not provided by this endpoint (display-only)
        asOf: str(d, 'date'),
      };
    } catch (e) { return { available: false, error: e.message }; }
  }

  // GEX by strike: GET /api/stock/{t}/greek-exposure/strike → latest date rows; netGex = call+put gex
  async getByStrikeGex(ticker) {
    try {
      const rows = arr(await this._get(`/api/stock/${enc(ticker.toUpperCase())}/greek-exposure/strike`));
      const latestDate = rows.reduce((m, r) => (String(r.date) > m ? String(r.date) : m), '');
      const strikes = rows.filter((r) => !latestDate || String(r.date) === latestDate).map((r) => ({ strike: pick(r, 'strike'), netGex: sum(r, 'call_gex', 'put_gex'), callGex: pick(r, 'call_gex'), putGex: pick(r, 'put_gex') })).filter((r) => isNum(r.strike));
      return { available: strikes.length > 0, strikes };
    } catch (e) { return { available: false, error: e.message }; }
  }

  // IV rank: GET /api/stock/{t}/iv-rank → latest; iv_rank = iv_rank_1y, current_iv = volatility
  async getIvRank(ticker) {
    try {
      const d = last(arr(await this._get(`/api/stock/${enc(ticker.toUpperCase())}/iv-rank`))) || {};
      const iv_rank = pick(d, 'iv_rank_1y', 'iv_rank');
      return { available: isNum(iv_rank), iv_rank, iv_percentile: pick(d, 'iv_percentile'), current_iv: pick(d, 'volatility', 'iv') };
    } catch (e) { return { available: false, error: e.message }; }
  }

  // skew: GET /api/stock/{t}/historical-risk-reversal-skew → latest risk_reversal (25-delta)
  async getSkew(ticker) {
    try {
      const rows = arr(await this._get(`/api/stock/${enc(ticker.toUpperCase())}/historical-risk-reversal-skew`));
      const d = last(rows.filter((r) => n(r.delta) === 25)) || last(rows) || {};
      const skew25 = pick(d, 'risk_reversal', 'skew_25');
      return { available: isNum(skew25), skew25, percentile: null, windowDays: null, observations: rows.length };
    } catch (e) { return { available: false, error: e.message }; }
  }

  // term structure: GET /api/stock/{t}/volatility/term-structure → compute slope_30_90 from dte curve
  async getTermStructure(ticker) {
    try {
      const pts = arr(await this._get(`/api/stock/${enc(ticker.toUpperCase())}/volatility/term-structure`)).map((p) => ({ dte: pick(p, 'dte'), iv: pick(p, 'volatility', 'implied_volatility') })).filter((p) => isNum(p.dte) && isNum(p.iv)).sort((a, b) => a.dte - b.dte);
      const ivAt = (target) => { if (!pts.length) return null; let best = pts[0]; for (const p of pts) if (Math.abs(p.dte - target) < Math.abs(best.dte - target)) best = p; return best.iv; };
      const iv30 = ivAt(30), iv90 = ivAt(90);
      return { available: pts.length > 0, slope3090: isNum(iv30) && isNum(iv90) ? iv90 - iv30 : null, front: pts[0] ? pts[0].iv : null, points: pts, observations: pts.length };
    } catch (e) { return { available: false, error: e.message }; }
  }

  // flow: GET /api/stock/{t}/flow-alerts → trades[] for computeFlowQuality
  async getFlowDetailed(ticker, { limit = 200 } = {}) {
    try {
      const rows = arr(await this._get(`/api/stock/${enc(ticker.toUpperCase())}/flow-alerts?limit=${enc(limit)}`));
      const nowMs = Date.now();
      const trades = rows.map((r) => {
        const right = (str(r, 'type', 'option_type') || '').toLowerCase().startsWith('p') ? 'put' : 'call';
        const askPrem = pick(r, 'total_ask_side_prem'), bidPrem = pick(r, 'total_bid_side_prem');
        const askDominant = isNum(askPrem) && isNum(bidPrem) ? askPrem > bidPrem : null;
        const direction = askDominant == null ? null : (right === 'call' ? (askDominant ? 'bullish' : 'bearish') : (askDominant ? 'bearish' : 'bullish'));
        const exp = str(r, 'expiry'); const dte = exp && !Number.isNaN(Date.parse(exp)) ? Math.max(0, Math.round((Date.parse(exp) - nowMs) / 86400000)) : pick(r, 'dte');
        const spot = pick(r, 'underlying_price'), strike = pick(r, 'strike');
        return {
          premium: pick(r, 'total_premium'), size: pick(r, 'total_size', 'volume'), right, side: right, direction, golden: !!(r.has_sweep && r.all_opening_trades),
          is_golden_sweep: !!(r.has_sweep && r.all_opening_trades), is_sweep: !!r.has_sweep, is_opening: !!r.all_opening_trades,
          trade_type: str(r, 'alert_rule'), dte, otm_percent: isNum(spot) && isNum(strike) && spot > 0 ? Math.abs(strike - spot) / spot : null,
          open_interest: pick(r, 'open_interest'), volOiRatio: pick(r, 'volume_oi_ratio'),
        };
      });
      return { available: trades.length > 0, trades };
    } catch (e) { return { available: false, error: e.message }; }
  }

  // net premium: GET /api/stock/{t}/net-prem-ticks → sum net_call/net_put premium
  async getNetPremium(ticker) {
    try {
      const rows = arr(await this._get(`/api/stock/${enc(ticker.toUpperCase())}/net-prem-ticks`));
      let bull = 0, bear = 0, seen = false;
      for (const r of rows) { const c = n(r.net_call_premium), p = n(r.net_put_premium); if (c != null) { bull += c; seen = true; } if (p != null) { bear += p; seen = true; } }
      return { available: seen, total_net_premium: seen ? bull - bear : null, total_bullish_premium: seen ? bull : null, total_bearish_premium: seen ? bear : null, total_trades: rows.length };
    } catch (e) { return { available: false, error: e.message }; }
  }

  // OI CHANGE: GET /api/stock/{t}/oi-change → real net call vs put open-interest change.
  // Activates the engine's `oiChange` directional feature (previously dead: "no prior snapshot").
  async getOiChange(ticker, { limit = 500 } = {}) {
    try {
      const rows = arr(await this._get(`/api/stock/${enc(ticker.toUpperCase())}/oi-change?limit=${enc(limit)}`));
      if (!rows.length) return { available: false };
      let dCall = 0, dPut = 0, prevCall = 0, prevPut = 0, seen = 0;
      for (const r of rows) {
        const sym = str(r, 'option_symbol', 'symbol'); if (!sym) continue;
        const occ = parseOcc(sym); if (!occ || !occ.type) continue;
        // prefer explicit diff; else derive from curr/prev OI
        const curr = pick(r, 'curr_oi', 'current_oi'), prv = pick(r, 'prev_oi', 'previous_oi');
        let d = pick(r, 'oi_diff_plain', 'oi_change', 'oi_diff');
        if (d == null && isNum(curr) && isNum(prv)) d = curr - prv;
        if (d == null) continue;
        seen++;
        if (occ.type === 'call') { dCall += d; if (isNum(prv)) prevCall += prv; }
        else if (occ.type === 'put') { dPut += d; if (isNum(prv)) prevPut += prv; }
      }
      if (!seen) return { available: false };
      return { available: true, callOIChange: dCall, putOIChange: dPut, netOIChange: dCall - dPut, prevCallOI: prevCall || null, prevPutOI: prevPut || null, contracts: seen };
    } catch (e) { return { available: false, error: e.message }; }
  }

  // INTRADAY: GET /api/stock/{t}/ohlc/5m → today's session VWAP + open (the real-time intraday benchmark)
  async getIntraday(ticker, { candle = '5m', limit = 120 } = {}) {
    try {
      const rows = arr(await this._get(`/api/stock/${enc(ticker.toUpperCase())}/ohlc/${enc(candle)}?limit=${enc(limit)}`));
      const bars = rows.map((b) => ({ date: String(str(b, 'start_time', 'date', 'timestamp') || '').slice(0, 10), h: pick(b, 'high'), l: pick(b, 'low'), c: pick(b, 'close'), o: pick(b, 'open'), v: pick(b, 'volume') })).filter((b) => isNum(b.c) && isNum(b.v) && b.date);
      if (bars.length < 2) return { available: false };
      const latest = bars.reduce((m, b) => (b.date > m ? b.date : m), '');   // most recent session present
      const session = bars.filter((b) => b.date === latest);
      let pv = 0, vol = 0; for (const b of session) { const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vol += b.v; }
      const vwap = vol > 0 ? pv / vol : null;
      // rawBars carry epoch timestamps so the outcome resolver can slice a leakage-safe window.
      const rawBars = bars.map((b, i) => ({ t: Date.parse(str(rows[i], 'start_time', 'date', 'timestamp') || ''), price: b.c, high: b.h, low: b.l, volume: b.v })).filter((b) => Number.isFinite(b.t) && isNum(b.price));
      return { available: isNum(vwap), vwap, sessionOpen: session[0] ? session[0].o : null, last: session[session.length - 1].c, sessionDate: latest, bars: session.length, rawBars };
    } catch (e) { return { available: false, error: e.message }; }
  }

  // daily OHLC (intraday later via candle): GET /api/stock/{t}/ohlc/{candle}
  async getOhlc(ticker, { candle = '1d', limit = 500 } = {}) {
    try {
      const rows = arr(await this._get(`/api/stock/${enc(ticker.toUpperCase())}/ohlc/${enc(candle)}?limit=${enc(limit)}`));
      const bars = rows.map((b) => { const ts = str(b, 'date', 'start_time', 'timestamp'); return { date: String(ts || '').slice(0, 10), time: str(b, 'start_time', 'end_time') || null, open: pick(b, 'open'), high: pick(b, 'high'), low: pick(b, 'low'), close: pick(b, 'close'), volume: pick(b, 'volume') }; }).filter((b) => isNum(b.close) && b.date);
      return { available: bars.length > 0, bars };
    } catch (e) { return { available: false, error: e.message }; }
  }

  // dark pool: GET /api/darkpool/{t} → aggregate off-exchange prints (no DIX from UW)
  async getDarkpool(ticker) {
    try {
      const rows = arr(await this._get(`/api/darkpool/${enc(ticker.toUpperCase())}`));
      let vol = 0, prem = 0; for (const r of rows) { vol += n(r.size) || 0; prem += n(r.premium) || 0; }
      return { available: rows.length > 0, dix: null, offExchangeVolume: rows.length ? vol : null, darkPoolPremium: rows.length ? prem : null, prints: rows.length, shortVolume: null };
    } catch (e) { return { available: false, error: e.message }; }
  }

  // screener (active universe + sector/name): GET /api/screener/stocks
  async getScreener({ limit = 100 } = {}) {
    try {
      const rows = arr(await this._get(`/api/screener/stocks?limit=${enc(limit)}`));
      const mapped = rows.map((r) => ({
        ticker: (str(r, 'ticker', 'symbol') || '').toUpperCase(), sector: str(r, 'sector') || null, name: str(r, 'full_name') || null,
        premium: sum(r, 'call_premium', 'put_premium'), totalPremium: sum(r, 'call_premium', 'put_premium'),
        net_premium: (isNum(pick(r, 'net_call_premium')) || isNum(pick(r, 'net_put_premium'))) ? (n(r.net_call_premium) || 0) - (n(r.net_put_premium) || 0) : null,
        // camelCase alias — consumers (cross-section, scan) read netPremium
        netPremium: (isNum(pick(r, 'net_call_premium')) || isNum(pick(r, 'net_put_premium'))) ? (n(r.net_call_premium) || 0) - (n(r.net_put_premium) || 0) : null,
        bullishPremium: pick(r, 'bullish_premium'), bearishPremium: pick(r, 'bearish_premium'),
        callVolume: pick(r, 'call_volume'), putVolume: pick(r, 'put_volume'), putCallRatio: pick(r, 'put_call_ratio'),
        ivRank: pick(r, 'iv_rank'), gexRatio: pick(r, 'gex_ratio'), marketcap: pick(r, 'marketcap'),
      })).filter((r) => r.ticker);
      return { available: mapped.length > 0, rows: mapped };
    } catch (e) { return { available: false, error: e.message }; }
  }

  // sector/company — prefer screener; fall back to bounded per-ticker /info
  async getCompanies(tickers = []) {
    const map = {}; const list = [...new Set(tickers.map((t) => String(t).toUpperCase()))].slice(0, 60);
    for (const t of list) { try { const d = (await this._get(`/api/stock/${enc(t)}/info`)).data || {}; map[t] = { sector: str(d, 'sector') || null, industry: str(d, 'issue_type') || null, name: str(d, 'full_name', 'short_name') || null }; } catch { map[t] = { sector: null, industry: null, name: null }; } }
    return map;
  }
  async getTopIvRank({ limit = 250 } = {}) {
    try { const rows = arr(await this._get(`/api/screener/stocks?limit=${enc(limit)}`)); return { available: rows.length > 0, rows: rows.map((r) => ({ ticker: (str(r, 'ticker') || '').toUpperCase(), ivRank: pick(r, 'iv_rank'), ivPercentile: null })).filter((r) => r.ticker) }; }
    catch (e) { return { available: false, error: e.message }; }
  }
  async getEarnings(ticker) {
    try { const d = (await this._get(`/api/stock/${enc(ticker.toUpperCase())}/info`)).data || {}; const next = str(d, 'next_earnings_date'); if (!next || Number.isNaN(Date.parse(next))) return { available: false, nextDate: null, daysToEarnings: null }; return { available: true, nextDate: String(next).slice(0, 10), daysToEarnings: Math.round((Date.parse(next) - Date.now()) / 86400000) }; }
    catch (e) { return { available: false, error: e.message }; }
  }
  async getMaxPain(ticker) {
    try { const d = last(arr(await this._get(`/api/stock/${enc(ticker.toUpperCase())}/max-pain`))) || {}; const mp = pick(d, 'max_pain'); return { available: isNum(mp), maxPain: mp, expiry: str(d, 'expiry') }; }
    catch (e) { return { available: false, error: e.message }; }
  }
  async getSectorTide() { try { const rows = arr(await this._get(`/api/market/sector-tide`)); return { available: rows.length > 0, rows: rows.map((r) => ({ sector: str(r, 'sector') || null, net: pick(r, 'net_premium', 'total_net_premium') })).filter((r) => r.sector) }; } catch (e) { return { available: false, error: e.message }; } }
  async getMarketTide() { try { const d = (await this._get(`/api/market/market-tide`)).data || {}; return { available: isNum(pick(d, 'net_call_premium', 'net_premium')), net: pick(d, 'net_call_premium', 'net_premium') }; } catch (e) { return { available: false, error: e.message }; } }
}
