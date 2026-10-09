// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAiContext, runAnalysis, parseAiJson } from '../ai/agents.js';
import { OpenRouterClient } from '../providers/openrouter.js';

const sig = () => ({
  ticker: 'AAPL', finalScore: 72, dir: 'bull', tier: 'strong', optionsScore: 76, stockScore: 60,
  dataQuality: 100, dataQualityStatus: 'AVAILABLE', dataAvailability: { greeks: true, iv: true, oi: true, sweeps: true },
  agg: { cpVolRatio: 1.8, cpOIRatio: 1.2, atmIV: 0.44, gex: 1.2e9, gammaFlip: 448, maxPain: 450 },
  walls: { call: 460, put: 440 }, gexSource: 'pve', ivRank: 62.5, ivPercentile: 71,
});

const goodJson = JSON.stringify({
  analysts: { flow: { view: 'bullish', confidence: 70, points: ['golden sweeps on calls'] }, positioning: { view: 'bullish', confidence: 60, points: ['above gamma flip'] }, technical: { view: 'neutral', confidence: 50, points: [] }, news: { view: 'neutral', confidence: 40, points: [] } },
  bull_case: { thesis: 'flow + positioning supportive', points: ['call wall 460'] },
  bear_case: { thesis: 'IV rich', points: ['iv rank 62'] },
  risk_review: { level: 'medium', risks: ['earnings soon'] },
  summary: { text: 'Advisory: leans bullish, aligns with engine.', ai_view: 'bullish', ai_confidence: 65 },
});

const mockLLM = (text) => async () => ({ ok: true, text, model: 'mock/model' });

test('buildAiContext is pure and includes read-only deterministic verdict + real fields only', () => {
  const before = JSON.stringify(sig());
  const s = sig();
  const ctx = buildAiContext(s, {});
  assert.equal(JSON.stringify(s), before);                 // input not mutated
  assert.deepEqual(ctx.deterministic, { score: 72, direction: 'bull', tier: 'strong' });
  assert.equal(ctx.options.gex, 1.2e9); assert.equal(ctx.positioning.ivRank, 62.5);
  assert.equal('fabricated' in ctx, false);
});

test('runAnalysis returns structured advisory output and ECHOES deterministic values unchanged', async () => {
  const s = sig(); const before = JSON.stringify(s);
  const r = await runAnalysis({ signal: s, llm: mockLLM(goodJson) });
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(s), before);                 // BOUNDARY: signal never mutated
  assert.equal(r.ai.deterministicScore, 72);
  assert.equal(r.ai.deterministicDirection, 'bull');
  assert.equal(r.ai.deterministicTier, 'strong');
  assert.equal(r.ai.aiView, 'bullish');
  assert.ok(r.ai.disclaimer.includes('does not affect the Signal Score'));
});

test('BOUNDARY: AI opposite to engine does NOT change the deterministic score/direction', async () => {
  const s = sig(); // engine says bull/72
  const opp = JSON.stringify({ analysts: {}, bull_case: {}, bear_case: {}, risk_review: { level: 'high' }, summary: { text: 'AI disagrees', ai_view: 'bearish', ai_confidence: 90 } });
  const r = await runAnalysis({ signal: s, llm: mockLLM(opp) });
  assert.equal(r.ok, true);
  assert.equal(r.ai.aiView, 'bearish');                    // AI may disagree...
  assert.equal(r.ai.deterministicDirection, 'bull');       // ...engine direction unchanged
  assert.equal(r.ai.deterministicScore, 72);               // ...engine score unchanged
  assert.equal(s.finalScore, 72); assert.equal(s.dir, 'bull');
});

test('runAnalysis never throws on junk / non-JSON', async () => {
  const r = await runAnalysis({ signal: sig(), llm: mockLLM('the model rambled with no json') });
  assert.equal(r.ok, false); assert.ok(r.error);
});

test('runAnalysis handles llm failure/timeout gracefully', async () => {
  const failing = async () => ({ ok: false, error: 'timeout' });
  const r = await runAnalysis({ signal: sig(), llm: failing });
  assert.equal(r.ok, false); assert.match(r.error, /timeout|unavailable/);
  const throwing = async () => { throw new Error('network down'); };
  const r2 = await runAnalysis({ signal: sig(), llm: throwing });
  assert.equal(r2.ok, false); assert.match(r2.error, /failed/);
});

test('no API key → OpenRouter client unavailable, chat returns ok:false (app still works)', async () => {
  const c = new OpenRouterClient({ apiKey: null });
  assert.equal(c.available, false);
  const r = await c.chat({ messages: [] });
  assert.equal(r.ok, false);
});

test('parseAiJson strips code fences and extracts embedded object', () => {
  assert.equal(parseAiJson('```json\n{"a":1}\n```').a, 1);
  assert.equal(parseAiJson('sure, here: {"b":2} done').b, 2);
  assert.equal(parseAiJson('no json here'), null);
});

import { normalizeContent } from '../providers/openrouter.js';
test('normalizeContent: string, array-of-blocks, and reasoning stripped', () => {
  assert.equal(normalizeContent('hello'), 'hello');
  assert.equal(normalizeContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(normalizeContent([{ type: 'reasoning', text: 'secret chain' }, { type: 'text', text: 'final' }]), 'final');
  assert.equal(normalizeContent([{ type: 'thinking', thinking: 'x' }]), '');
  assert.equal(normalizeContent(null), '');
  assert.equal(normalizeContent(['raw', { text: 'y', type: 'output_text' }]), 'raw\ny');
});

import { AI_VIEWS } from '../ai/agents.js';
test('AI verdict enum: every view field is one of bullish/bearish/neutral + confidence bounded', async () => {
  assert.deepEqual(AI_VIEWS, ['bullish', 'bearish', 'neutral']);
  const weird = JSON.stringify({ analysts: { flow: { view: 'STRONG BUY', confidence: 999, points: [] }, positioning: { view: 'meh', confidence: -5 }, technical: {}, news: {} }, summary: { text: 't', ai_view: 'mooning', ai_confidence: 250 } });
  const r = await runAnalysis({ signal: sig(), llm: mockLLM(weird) });
  assert.equal(r.ok, true);
  for (const a of Object.values(r.ai.analysts)) assert.ok(AI_VIEWS.includes(a.view), `analyst view ${a.view} not in enum`);
  assert.ok(AI_VIEWS.includes(r.ai.aiView));
  assert.equal(r.ai.aiView, 'neutral');                 // 'mooning' → neutral
  assert.ok(r.ai.aiConfidence >= 0 && r.ai.aiConfidence <= 100); // 250 → clamped
  assert.equal(r.ai.analysts.flow.confidence, 100);     // 999 → 100
});

test('per-role routing: single call when models identical (default), two calls when different', async () => {
  const calls = [];
  const roleLLM = (text) => async (messages, o = {}) => { calls.push(o.role); return { ok: true, text, model: 'm-' + (o.role || '?') }; };
  // single-call default (split=false)
  calls.length = 0;
  await runAnalysis({ signal: sig(), llm: roleLLM(goodJson) });
  assert.equal(calls.length, 1, 'default is one call');
  // two-call split
  calls.length = 0;
  const analystJson = JSON.stringify({ analysts: { flow: { view: 'bullish', confidence: 60, points: [] }, positioning: {}, technical: {}, news: {} } });
  const twoLLM = async (messages, o = {}) => { calls.push(o.role); return { ok: true, text: o.role === 'analyst' ? analystJson : goodJson, model: 'm-' + o.role }; };
  const s = sig(); const before = JSON.stringify(s);
  const r = await runAnalysis({ signal: s, llm: twoLLM, split: true });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['analyst', 'manager']);
  assert.equal(JSON.stringify(s), before);              // still no mutation on split path
  assert.equal(r.ai.deterministicScore, 72);            // deterministic echo intact
});

test('structured output: uses JSON mode when supported, gracefully retries WITHOUT it on error', async () => {
  const c = new OpenRouterClient({ apiKey: 'k', model: 'm', timeoutMs: 5000 });
  const real = globalThis.fetch; const seen = [];
  globalThis.fetch = async (u, o) => {
    const body = JSON.parse(o.body); seen.push(!!body.response_format);
    if (body.response_format) return { ok: false, status: 400, json: async () => ({ error: { message: 'response_format unsupported' } }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"summary":{"ai_view":"neutral"}}' } }] }) };
  };
  try {
    const r = await c.chat({ messages: [{ role: 'user', content: 'json please' }], responseFormat: { type: 'json_object' } });
    assert.equal(r.ok, true); assert.equal(r.structuredFallback, true);
    assert.deepEqual(seen, [true, false]);              // tried with schema, then without
  } finally { globalThis.fetch = real; }
});

test('structured output: happy path returns without fallback', async () => {
  const c = new OpenRouterClient({ apiKey: 'k', model: 'm', timeoutMs: 5000 });
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":1}' } }] }) });
  try { const r = await c.chat({ messages: [], responseFormat: { type: 'json_object' } }); assert.equal(r.ok, true); assert.equal(r.structuredFallback, undefined); }
  finally { globalThis.fetch = real; }
});
