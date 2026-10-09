// @ts-check
/*
 * providers/openrouter.js — minimal OpenRouter chat client (built-in fetch, no dependency).
 * Server-side only: the key never reaches the browser. Used exclusively by the ADVISORY AI layer
 * (ai/agents.js). It cannot and does not touch the deterministic engine — it only returns text.
 *
 * OpenAI-compatible: POST https://openrouter.ai/api/v1/chat/completions,
 * Authorization: Bearer sk-or-..., body { model, messages, ... }.
 */

const BASE = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Normalize an OpenRouter/OpenAI message.content into a plain string.
 * Handles: a plain string; or an array of blocks (concatenating only text, ignoring
 * reasoning/thinking blocks so hidden reasoning is never surfaced as the answer).
 * @param {*} content @returns {string}
 */
export function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (typeof b === 'string') { parts.push(b); continue; }
      if (b && typeof b === 'object') {
        const type = b.type;
        if (type === 'reasoning' || type === 'thinking') continue;      // never expose hidden reasoning
        if (type === 'text' && typeof b.text === 'string') { parts.push(b.text); continue; }
        if (typeof b.text === 'string' && type !== 'reasoning' && type !== 'thinking') parts.push(b.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

export function configFromEnv(env = {}) {
  const model = env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';   // cheap, widely available; override via env
  return {
    apiKey: env.OPENROUTER_API_KEY || null,
    model,
    // Per-role routing. Default both to `model` so existing single-model behavior is unchanged.
    models: {
      analyst: env.OPENROUTER_MODEL_ANALYST || model,
      manager: env.OPENROUTER_MODEL_MANAGER || model,
    },
    reasoning: {
      analyst: env.OPENROUTER_REASONING_ANALYST === 'true',
      manager: env.OPENROUTER_REASONING_MANAGER === 'true',
    },
    fallbackModel: env.OPENROUTER_FALLBACK_MODEL || null,
    structured: env.AI_STRUCTURED ? env.AI_STRUCTURED !== 'false' : true,   // prefer native JSON mode; falls back to text parser
    enabled: (env.AI_ENABLED ? env.AI_ENABLED !== 'false' : true) && !!env.OPENROUTER_API_KEY,
    timeoutMs: Number(env.OPENROUTER_TIMEOUT_MS || 30000),
    cacheTtlMs: Number(env.AI_CACHE_TTL_MS || 600000),      // 10 min
    maxTokens: Number(env.OPENROUTER_MAX_TOKENS || 1200),
    temperature: Number(env.OPENROUTER_TEMPERATURE || 0.3),
  };
}

export class OpenRouterClient {
  constructor(cfg = {}) { this.cfg = { model: 'openai/gpt-4o-mini', timeoutMs: 30000, maxTokens: 1200, temperature: 0.3, ...cfg }; }
  get available() { return !!this.cfg.apiKey; }

  /** Low-level single completion. Returns assistant text. Throws on non-OK / timeout. */
  async _once(model, messages, opts = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    try {
      const payload = { model, messages, max_tokens: this.cfg.maxTokens, temperature: this.cfg.temperature };
      if (opts.reasoning) payload.reasoning = { effort: 'medium' };            // opt-in; ignored by models without support
      if (opts.responseFormat) payload.response_format = opts.responseFormat;  // native structured output when requested
      const res = await fetch(BASE, {
        method: 'POST', signal: ctl.signal,
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'PVE Signal Engine' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) { let msg = `OpenRouter HTTP ${res.status}`; try { const b = await res.json(); if (b && b.error) msg = b.error.message || msg; } catch {} throw new Error(msg); }
      const b = await res.json();
      const raw = b && b.choices && b.choices[0] && b.choices[0].message && b.choices[0].message.content;
      const text = normalizeContent(raw);
      if (!text) throw new Error('OpenRouter: empty completion');
      return text;
    } finally { clearTimeout(timer); }
  }

  /**
   * chat({messages, model, reasoning, responseFormat}) with fallback on error — never throws.
   * If responseFormat is set and the request errors, retry ONCE without it (graceful degrade to the
   * text parser) before trying the fallback model.
   */
  async chat({ messages, model, reasoning, responseFormat } = {}) {
    if (!this.available) return { ok: false, error: 'OPENROUTER_API_KEY not set' };
    const primary = model || this.cfg.model;
    try { return { ok: true, text: await this._once(primary, messages, { reasoning, responseFormat }), model: primary }; }
    catch (e1) {
      if (responseFormat) {
        try { return { ok: true, text: await this._once(primary, messages, { reasoning }), model: primary, structuredFallback: true }; } catch (e1b) { /* fall through */ }
      }
      if (this.cfg.fallbackModel && this.cfg.fallbackModel !== primary) {
        try { return { ok: true, text: await this._once(this.cfg.fallbackModel, messages, { reasoning }), model: this.cfg.fallbackModel }; }
        catch (e2) { return { ok: false, error: `${e1.message}; fallback: ${e2.message}` }; }
      }
      return { ok: false, error: e1.message };
    }
  }
}
