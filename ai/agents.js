// @ts-check
/*
 * ai/agents.js — ADVISORY multi-agent layer that sits ABOVE the deterministic engine.
 *
 * HARD BOUNDARY: this module is research/advisory only. It NEVER computes or alters finalScore,
 * direction, tier, classification, or backtests. The deterministic values are copied in read-only
 * and echoed back untouched. runAnalysis takes an injected `llm` (so it is fully mock-testable) and
 * NEVER throws and NEVER mutates the passed-in signal — it returns a separate `ai` object.
 *
 * Roles (reimplemented natively, TradingAgents-style — no Python/LangGraph):
 *   Flow Analyst · Positioning/GEX Analyst · Technical Analyst · News Analyst
 *   → Bull Researcher vs Bear Researcher → Risk Review → Final Summary.
 * Context is built ONLY from real fields present on the deterministic signal + provided extras;
 * anything unavailable stays absent (never fabricated).
 */

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clampConf = (x) => (isNum(x) ? Math.max(0, Math.min(100, Math.round(x))) : null);
/** The ONLY permitted AI verdict values. AI commentary only — never the engine's direction. */
export const AI_VIEWS = ['bullish', 'bearish', 'neutral'];
const normView = (v) => { const s = String(v || '').toLowerCase(); return s === 'bullish' || s === 'bull' ? 'bullish' : s === 'bearish' || s === 'bear' ? 'bearish' : 'neutral'; };

/** PURE: assemble a compact, real-only context object for prompting. Includes read-only deterministic verdict. */
export function buildAiContext(signal, extras = {}) {
  const s = signal || {};
  const a = s.agg || {};
  const da = s.dataAvailability || {};
  const det = { score: isNum(s.finalScore) ? s.finalScore : (isNum(s.optionsScore) ? s.optionsScore : null), direction: s.dir || 'neutral', tier: s.tier || null };
  const ctx = {
    ticker: s.ticker || extras.ticker || null,
    deterministic: det,
    dataQuality: { status: s.dataQualityStatus || null, score: isNum(s.dataQuality) ? s.dataQuality : null, available: da },
    options: {
      optionsScore: isNum(s.optionsScore) ? s.optionsScore : null,
      stockScore: isNum(s.stockScore) ? s.stockScore : null,
      callPutVolRatio: isNum(a.cpVolRatio) ? a.cpVolRatio : null,
      callPutOIRatio: isNum(a.cpOIRatio) ? a.cpOIRatio : null,
      atmIV: isNum(a.atmIV) ? a.atmIV : null,
      gex: isNum(a.gex) ? a.gex : null,
      gammaFlip: isNum(a.gammaFlip) ? a.gammaFlip : null,
      maxPain: isNum(a.maxPain) ? a.maxPain : null,
    },
    positioning: { walls: s.walls || null, gexSource: s.gexSource || null, ivRank: isNum(s.ivRank) ? s.ivRank : null, ivPercentile: isNum(s.ivPercentile) ? s.ivPercentile : null },
  };
  if (extras.netPremium && extras.netPremium.available) ctx.netPremium = { total: extras.netPremium.total_net_premium, bullish: extras.netPremium.total_bullish_premium, bearish: extras.netPremium.total_bearish_premium, trades: extras.netPremium.total_trades };
  if (extras.sweeps && extras.sweeps.length) ctx.topSweeps = extras.sweeps.slice(0, 8).map((t) => ({ side: t.side, premium: t.premium, golden: t.golden, type: t.type }));
  if (Array.isArray(extras.news) && extras.news.length) ctx.news = extras.news.slice(0, 6);
  return ctx;
}

function buildMessages(context) {
  const sys = [
    'You are a panel of sell-side options analysts producing an ADVISORY research note for a US-equity/options ticker.',
    'A separate deterministic engine has ALREADY decided the trade score, direction and tier — those are FINAL and shown to you as context.read-only. Do NOT try to override them; your job is to explain, contextualize, and surface bull/bear/risk views around them.',
    'Use ONLY the data provided. If a field is absent, say the data is unavailable — never invent chain/Greeks/IV/GEX/flow numbers.',
    'Return STRICT JSON ONLY (no prose, no markdown fences) matching exactly this schema:',
    '{"analysts":{"flow":{"view":"bullish|bearish|neutral","confidence":0-100,"points":["..."]},"positioning":{"view":"...","confidence":0-100,"points":["..."]},"technical":{"view":"...","confidence":0-100,"points":["..."]},"news":{"view":"...","confidence":0-100,"points":["..."]}},"bull_case":{"thesis":"...","points":["..."]},"bear_case":{"thesis":"...","points":["..."]},"risk_review":{"level":"low|medium|high","risks":["..."]},"summary":{"text":"...","ai_view":"bullish|bearish|neutral","ai_confidence":0-100}}',
  ].join(' ');
  const user = 'CONTEXT (JSON):\n' + JSON.stringify(context);
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

// Two-call path (used only when analyst and manager models differ).
function buildAnalystMessages(context) {
  const sys = [
    'You are four specialist options analysts (flow, positioning/GEX, technical, news) for a US-equity/options ticker.',
    'Use ONLY the provided data; if a field is unavailable, say so — never invent numbers.',
    'Return STRICT JSON ONLY: {"analysts":{"flow":{"view":"bullish|bearish|neutral","confidence":0-100,"points":["..."]},"positioning":{"view":"...","confidence":0-100,"points":["..."]},"technical":{"view":"...","confidence":0-100,"points":["..."]},"news":{"view":"...","confidence":0-100,"points":["..."]}}}',
  ].join(' ');
  return [{ role: 'system', content: sys }, { role: 'user', content: 'CONTEXT (JSON):\n' + JSON.stringify(context) }];
}
function buildSynthesisMessages(context, analysts) {
  const sys = [
    'You are the research manager + risk reviewer for a US-equity/options ticker.',
    'A deterministic engine has ALREADY set the final score/direction/tier (context.deterministic) — those are FINAL; explain around them, do not override.',
    'Use ONLY provided data and the analyst findings; never invent numbers.',
    'Return STRICT JSON ONLY: {"bull_case":{"thesis":"...","points":["..."]},"bear_case":{"thesis":"...","points":["..."]},"risk_review":{"level":"low|medium|high","risks":["..."]},"summary":{"text":"...","ai_view":"bullish|bearish|neutral","ai_confidence":0-100}}',
  ].join(' ');
  const user = 'CONTEXT (JSON):\n' + JSON.stringify(context) + '\n\nANALYST FINDINGS (JSON):\n' + JSON.stringify(analysts || {});
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

/** Extract the first balanced {...} JSON object from arbitrary model text. Returns object or null. */
export function parseAiJson(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  try { return JSON.parse(t); } catch {}
  const i = t.indexOf('{'); if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < t.length; j++) { const ch = t[j]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(i, j + 1)); } catch { return null; } } } }
  return null;
}

function shape(parsed, det) {
  const p = parsed || {};
  const an = p.analysts || {};
  const role = (r) => ({ view: normView((an[r] || {}).view), confidence: clampConf((an[r] || {}).confidence), points: Array.isArray((an[r] || {}).points) ? (an[r].points).slice(0, 6).map(String) : [] });
  const sm = p.summary || {};
  return {
    analysts: { flow: role('flow'), positioning: role('positioning'), technical: role('technical'), news: role('news') },
    bullCase: { thesis: String((p.bull_case || {}).thesis || ''), points: Array.isArray((p.bull_case || {}).points) ? p.bull_case.points.slice(0, 6).map(String) : [] },
    bearCase: { thesis: String((p.bear_case || {}).thesis || ''), points: Array.isArray((p.bear_case || {}).points) ? p.bear_case.points.slice(0, 6).map(String) : [] },
    riskReview: { level: ['low', 'medium', 'high'].includes(String((p.risk_review || {}).level).toLowerCase()) ? String(p.risk_review.level).toLowerCase() : 'medium', risks: Array.isArray((p.risk_review || {}).risks) ? p.risk_review.risks.slice(0, 8).map(String) : [] },
    summary: { text: String(sm.text || ''), aiView: normView(sm.ai_view), aiConfidence: clampConf(sm.ai_confidence) },
    aiView: normView(sm.ai_view),
    aiConfidence: clampConf(sm.ai_confidence),
    // read-only echo of the deterministic engine — the AI cannot change these
    deterministicScore: det.score, deterministicDirection: det.direction, deterministicTier: det.tier,
    disclaimer: 'AI analysis is advisory and does not affect the Signal Score.',
  };
}

/**
 * Run the advisory analysis. NEVER throws; NEVER mutates `signal`.
 * @param {{signal:object, context?:object, llm:(messages:any[], opts?:{role?:string})=>Promise<{ok:boolean,text?:string,error?:string,model?:string}>, extras?:object, split?:boolean}} args
 * - split=true → two calls (analysts via role 'analyst', synthesis via role 'manager'). Default (false) = single call.
 * @returns {Promise<{ok:boolean, ai?:object, error?:string, model?:string}>}
 */
export async function runAnalysis({ signal, context, llm, extras = {}, split = false }) {
  const det = {
    score: isNum(signal && signal.finalScore) ? signal.finalScore : (isNum(signal && signal.optionsScore) ? signal.optionsScore : null),
    direction: (signal && signal.dir) || 'neutral',
    tier: (signal && signal.tier) || null,
  };
  const ctx = context || buildAiContext(signal, extras);
  if (typeof llm !== 'function') return { ok: false, error: 'no llm function provided' };

  if (!split) {
    // Single-call path (default; also used when analyst and manager models are identical → avoids extra cost).
    let res; try { res = await llm(buildMessages(ctx), { role: 'manager' }); } catch (e) { return { ok: false, error: 'llm call failed: ' + (e && e.message) }; }
    if (!res || !res.ok || !res.text) return { ok: false, error: (res && res.error) || 'llm unavailable' };
    const parsed = parseAiJson(res.text);
    if (!parsed) return { ok: false, error: 'could not parse AI JSON', model: res.model };
    return { ok: true, ai: shape(parsed, det), model: res.model };
  }

  // Two-call path: analysts (cheap model) then synthesis (stronger model).
  let aRes; try { aRes = await llm(buildAnalystMessages(ctx), { role: 'analyst' }); } catch (e) { aRes = { ok: false, error: (e && e.message) }; }
  const analysts = (aRes && aRes.ok && aRes.text) ? (parseAiJson(aRes.text) || {}) : {};
  let sRes; try { sRes = await llm(buildSynthesisMessages(ctx, analysts.analysts || analysts), { role: 'manager' }); } catch (e) { return { ok: false, error: 'llm synthesis failed: ' + (e && e.message) }; }
  if (!sRes || !sRes.ok || !sRes.text) return { ok: false, error: (sRes && sRes.error) || 'llm unavailable' };
  const synth = parseAiJson(sRes.text);
  if (!synth) return { ok: false, error: 'could not parse AI JSON', model: sRes.model };
  const merged = { analysts: analysts.analysts || analysts, ...synth };
  return { ok: true, ai: shape(merged, det), model: sRes.model };
}
