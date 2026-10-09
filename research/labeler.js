// @ts-check
/*
 * research/labeler.js — OFFLINE research only. Pure functions, no I/O, no network.
 * NOT imported by the server and NEVER feeds deterministic scoring. Computes dual outcome
 * labels from daily OHLC bars: directional correctness AND tradability (MFE/MAE excursions).
 *
 * Leakage guard: the forward window is strictly AFTER the entry bar (entry is taken at the
 * entry bar's close). The entry bar's own high/low never counts toward the outcome.
 */

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** First index whose bar.date equals (or starts with) `date`; -1 if not found. */
export function findIndexByDate(bars, date) {
  if (!Array.isArray(bars) || date == null) return -1;
  const d = String(date);
  for (let i = 0; i < bars.length; i++) {
    const bd = bars[i] && bars[i].date != null ? String(bars[i].date) : '';
    if (bd === d || bd.startsWith(d) || d.startsWith(bd)) return i;
  }
  return -1;
}

/**
 * Label one signal's outcome from daily OHLC bars.
 * @param {{bars:Array<{date?:string,high:number,low:number,close:number}>, entryIndex?:number, entryDate?:string, horizonDays?:number, direction?:string, entryPrice?:number}} args
 * @returns {object} outcome (see fields below). `insufficient:true` when no forward bars exist.
 *
 * MFE/MAE are signed against the position: mfe ≥ 0 (favorable), mae ≤ 0 (adverse).
 *  - bull: favorable = upside; adverse = downside.
 *  - bear: favorable = downside; adverse = upside.
 *  - neutral: direction-aware mfe/mae are null; rawUpMax / rawDownMin are still returned.
 */
export function labelOutcome({ bars, entryIndex, entryDate, horizonDays = 5, direction = 'neutral', entryPrice } = {}) {
  const dir = String(direction || 'neutral').toLowerCase();
  const H = Math.max(1, Math.floor(horizonDays || 1));
  const nullOut = { insufficient: true, direction: dir, horizonDays: H, entryPrice: null, entryDate: null, exitPrice: null, exitDate: null, ret: null, mfe: null, mae: null, timeToMfeDays: null, timeToMaeDays: null, rawUpMax: null, rawDownMin: null, usedBars: 0, hitDirection: null };
  if (!Array.isArray(bars) || bars.length === 0) return nullOut;
  let idx = Number.isInteger(entryIndex) ? entryIndex : findIndexByDate(bars, entryDate);
  if (!Number.isInteger(idx) || idx < 0 || idx >= bars.length) return nullOut;
  const entry = isNum(entryPrice) ? entryPrice : (isNum(bars[idx].close) ? bars[idx].close : null);
  if (!isNum(entry) || entry === 0) return nullOut;

  const start = idx + 1;                       // strictly AFTER entry bar — no look-ahead
  const end = Math.min(bars.length - 1, idx + H);
  if (start > end) return { ...nullOut, entryPrice: entry, entryDate: bars[idx].date ?? null };

  let upMax = -Infinity, upMaxAt = null, downMin = Infinity, downMinAt = null;
  for (let i = start; i <= end; i++) {
    const b = bars[i]; const step = i - idx;
    if (isNum(b.high)) { const up = (b.high - entry) / entry; if (up > upMax) { upMax = up; upMaxAt = step; } }
    if (isNum(b.low)) { const dn = (b.low - entry) / entry; if (dn < downMin) { downMin = dn; downMinAt = step; } }
  }
  const exitBar = bars[end];
  const exitPrice = isNum(exitBar.close) ? exitBar.close : entry;
  const ret = (exitPrice - entry) / entry;
  const rawUpMax = upMax === -Infinity ? null : upMax;
  const rawDownMin = downMin === Infinity ? null : downMin;

  let mfe = null, mae = null, timeToMfeDays = null, timeToMaeDays = null, hitDirection = null;
  if (dir === 'bull') {
    mfe = rawUpMax; mae = rawDownMin; timeToMfeDays = upMaxAt; timeToMaeDays = downMinAt; hitDirection = ret > 0;
  } else if (dir === 'bear') {
    mfe = rawDownMin == null ? null : -rawDownMin; mae = rawUpMax == null ? null : -rawUpMax;
    timeToMfeDays = downMinAt; timeToMaeDays = upMaxAt; hitDirection = ret < 0;
  }
  return {
    insufficient: false, direction: dir, horizonDays: H,
    entryPrice: entry, entryDate: bars[idx].date ?? null, exitPrice, exitDate: exitBar.date ?? null,
    ret, mfe, mae, timeToMfeDays, timeToMaeDays, rawUpMax, rawDownMin,
    usedBars: end - start + 1, hitDirection,
  };
}

/**
 * Multi-horizon dual labeling with target/adverse thresholds. Pure; no look-ahead.
 * For each horizon H (trading days) computes forward return, MFE/MAE (signed to the position),
 * whether a favorable target / adverse stop was reached first, and time-to-each.
 * @param {{bars:Array, entryIndex?:number, entryDate?:string, direction?:string, entryPrice?:number, horizons?:number[], targetPct?:number, adversePct?:number}} args
 */
export function labelMultiHorizon({ bars, entryIndex, entryDate, direction = 'neutral', entryPrice, horizons = [1, 3, 5, 10], targetPct = 0.03, adversePct = 0.03 } = {}) {
  const dir = String(direction || 'neutral').toLowerCase();
  const b = Array.isArray(bars) ? bars : [];
  let idx = Number.isInteger(entryIndex) ? entryIndex : findIndexByDate(b, entryDate);
  const entryOk = Number.isInteger(idx) && idx >= 0 && idx < b.length;
  const entry = entryOk ? (isNum2(entryPrice) ? entryPrice : (isNum2(b[idx].close) ? b[idx].close : null)) : null;
  const out = { entryDate: entryOk ? (b[idx].date ?? null) : null, entryPrice: entry, direction: dir, byHorizon: {} };
  if (!entryOk || !isNum2(entry) || entry === 0) { for (const H of horizons) out.byHorizon[H] = { insufficient: true }; return out; }

  for (const H of horizons) {
    const base = labelOutcome({ bars: b, entryIndex: idx, direction: dir, entryPrice: entry, horizonDays: H });
    let targetReached = null, adverseReached = null, timeToTargetDays = null, timeToAdverseDays = null;
    if (dir === 'bull' || dir === 'bear') {
      const end = Math.min(b.length - 1, idx + H);
      targetReached = false; adverseReached = false;
      for (let i = idx + 1; i <= end; i++) {
        const bar = b[i]; const step = i - idx;
        const fav = dir === 'bull' ? (isNum2(bar.high) ? (bar.high - entry) / entry : null) : (isNum2(bar.low) ? (entry - bar.low) / entry : null);
        const adv = dir === 'bull' ? (isNum2(bar.low) ? (bar.low - entry) / entry : null) : (isNum2(bar.high) ? (entry - bar.high) / entry : null);
        if (!targetReached && isNum2(fav) && fav >= targetPct) { targetReached = true; timeToTargetDays = step; }
        if (!adverseReached && isNum2(adv) && adv <= -adversePct) { adverseReached = true; timeToAdverseDays = step; }
      }
    }
    out.byHorizon[H] = {
      insufficient: base.insufficient, ret: base.ret, mfe: base.mfe, mae: base.mae,
      mfePct: isNum2(base.mfe) ? base.mfe * 100 : null, maePct: isNum2(base.mae) ? base.mae * 100 : null,
      directionCorrect: base.hitDirection, targetReached, adverseReached, timeToTargetDays, timeToAdverseDays,
      rawUpMax: base.rawUpMax, rawDownMin: base.rawDownMin, usedBars: base.usedBars,
    };
  }
  return out;
}
function isNum2(x) { return typeof x === 'number' && Number.isFinite(x); }
