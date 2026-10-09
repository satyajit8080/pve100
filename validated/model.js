// @ts-check
/*
 * validated/model.js — PHASE 4 validated production score. Deterministic, transparent, PURE.
 *
 * Runs ALONGSIDE the current production score (never replaces it unless evidence + config say so).
 * It reads a PROMOTION CONFIG (approved features + Phase-3-derived weights + optional calibration).
 * If no features are approved (the honest state until real out-of-sample data exists), the validated
 * score EQUALS the current score and delta is 0.
 *
 * HARD RULES: no ML here, no LLM, no imports from research/. Weights come only from the promotion
 * config (which Phase 3 produces from evidence). Missing feature inputs never fabricate a value.
 */

export const VALIDATED_MODEL_VERSION = 'validated-1.0.0';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : x);

/** The empty/identity promotion config: nothing promoted, validated == current. */
export const IDENTITY_PROMOTION = { version: 'promotion-empty', approvedFeatures: [], weights: {}, calibration: null, baseline: 'current', primary: 'current', note: 'No features promoted (insufficient out-of-sample evidence). Validated score mirrors current.' };

/** Tier mapping from a 0-100 score (used only for the validated score's own tier label). */
function tierFromScore(s) { return s >= 80 ? 'Strong' : s >= 65 ? 'Moderate' : s >= 50 ? 'Watch' : 'Weak'; }

/**
 * Compute the validated score.
 * @param {{current:{score:number,dir?:string,tier?:string}, featureInputs?:Record<string,number>, promotion?:object}} args
 *   featureInputs: NORMALIZED feature values in roughly [-1,1] (e.g. percentile/50-1, regime sign,
 *   flowQuality/50-1). The promotion config decides which are used and with what weight.
 * @returns {{version, baseline, primary, current, validatedScore, delta, direction, tier, components, usedFeatures, calibratedProbability, probabilityShown, note}}
 */
export function computeValidated({ current = {}, featureInputs = {}, promotion } = {}) {
  const cfg = promotion && typeof promotion === 'object' ? promotion : IDENTITY_PROMOTION;
  const approved = Array.isArray(cfg.approvedFeatures) ? cfg.approvedFeatures : [];
  const weights = cfg.weights && typeof cfg.weights === 'object' ? cfg.weights : {};
  const base = isNum(current.score) ? current.score : null;

  const components = [{ name: 'baseline (current score)', contribution: base }];
  let adj = 0; const used = [];
  for (const f of approved) {
    const w = isNum(weights[f]) ? weights[f] : 0;
    const v = featureInputs[f];
    if (!isNum(v) || w === 0) { components.push({ name: f, contribution: 0, note: !isNum(v) ? 'input unavailable → 0 (not fabricated)' : 'zero weight' }); continue; }
    const c = w * v; adj += c; used.push(f);
    components.push({ name: f, contribution: r2(c) });
  }

  const validatedScore = isNum(base) ? Math.round(clamp(base + adj, 0, 100)) : null;
  const delta = isNum(validatedScore) && isNum(base) ? validatedScore - base : null;
  // direction/tier: mirror current when nothing changed the score; otherwise derive from validated score.
  const direction = (delta === 0 || delta == null) ? (current.dir || null) : (current.dir || null); // direction still comes from the deterministic engine; validated never invents a new direction
  const tier = (delta === 0 || delta == null) ? (current.tier || (isNum(validatedScore) ? tierFromScore(validatedScore) : null)) : (isNum(validatedScore) ? tierFromScore(validatedScore) : null);

  // calibration: only expose a probability if the promotion config carries a VALIDATED map.
  let calibratedProbability = null, probabilityShown = false;
  if (cfg.calibration && cfg.calibration.validated === true && isNum(validatedScore)) {
    calibratedProbability = applyCalibration(cfg.calibration, validatedScore);
    probabilityShown = isNum(calibratedProbability);
  }

  return {
    version: VALIDATED_MODEL_VERSION, baseline: cfg.baseline || 'current', primary: cfg.primary || 'current',
    current: base, validatedScore, delta, direction, tier,
    components, usedFeatures: used, calibratedProbability, probabilityShown,
    note: approved.length === 0 ? 'Validated score mirrors current (no promoted features yet).' : undefined,
  };
}

/** Apply a validated calibration map (isotonic step map or Platt sigmoid) to a 0-100 score. */
export function applyCalibration(cal, score) {
  if (!cal || !isNum(score)) return null;
  if (cal.type === 'platt' && isNum(cal.a) && isNum(cal.b)) return 1 / (1 + Math.exp(-(cal.a * score + cal.b)));
  if (cal.type === 'isotonic' && Array.isArray(cal.points) && cal.points.length) {
    // points: [{x, p}] sorted by x; piecewise-constant/linear interpolation
    const pts = cal.points.filter((p) => isNum(p.x) && isNum(p.p)).sort((a, b) => a.x - b.x);
    if (!pts.length) return null;
    if (score <= pts[0].x) return pts[0].p; if (score >= pts[pts.length - 1].x) return pts[pts.length - 1].p;
    for (let i = 1; i < pts.length; i++) if (score <= pts[i].x) { const a = pts[i - 1], b = pts[i]; const t = (score - a.x) / (b.x - a.x || 1); return a.p + t * (b.p - a.p); }
  }
  return null;
}
