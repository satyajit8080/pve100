# AI‑Layer & Data‑Source Audit (approval required before any code change)

Scope: (1) audit both TradingAgents forks + pick the best agent architecture, (2) plan OpenRouter as
the AI layer, (3) remove Polygon only where PVE v1 already covers it. **PVE v1 is the primary data
source. The existing deterministic signal engine is kept unchanged.** No code has been changed.

---

## 0. The load‑bearing constraint (read first)

This project has one non‑negotiable rule, enforced by tests: **no LLM in scoring / classification /
backtest / signal generation.** TradingAgents is the opposite by design — it lets LLM agents *make the
trading decision* ("the trader makes the trading decision"; "non‑deterministic factors"; "not financial
advice"). So we must **not** drop TradingAgents in as the decision engine.

**Reconciliation (what I recommend):** adopt TradingAgents' *role architecture and debate structure* as
an **AI Analysis overlay** — implemented natively in Node — that **reads** the deterministic engine's
real outputs + PVE v1 real data and produces **narrative research, a bull/bear debate, and a risk
review**. The LLM **never** sets, overrides, or nudges `finalScore` / `dir` / `tier`. If the AI's view
disagrees with the deterministic signal, that's shown as commentary; the deterministic score stands.
This gives you the TradingAgents experience without breaking determinism.

---

## 1. TradingAgents audit

### 1a. Fork access — honest status
- **Canonical upstream:** `TauricResearch/TradingAgents` — Apache‑2.0, Python, **LangGraph**, ~99k★. Fully readable; this is the architecture all forks inherit.
- **`AnTechAI/TradingAgents` and `SboTeaman/TradingAgents`:** **could not be accessed** — they don't appear in search and can't be fetched (likely private / new / unindexed). I did **not** guess their contents.
- Every *public* fork in this ecosystem (CN, astock, MCPmode, LLM, ch0731, …) differs from upstream in the **same few dimensions**, never in the core roles: data‑source localization, extra LLM providers / OpenAI‑compatible gateways (all include **OpenRouter**), UI stack (Streamlit → FastAPI/Vue), a few added agent roles, MCP integration, and persistence (checkpoint resume + decision log).
- **What I need from you** to fold in anything fork‑specific: paste each fork's `README` + `tradingagents/` tree (or make them public for one fetch). Absent that, the plan below adopts the canonical architecture + the genuinely useful upstream additions.

### 1b. Architecture (canonical, LangGraph)
```
I.  Analysts (parallel):  Fundamentals · Sentiment · News · Technical
II. Research (debate):    Bull researcher  ⇄  Bear researcher   → Research Manager
III.Trader:               synthesizes analysts + debate → proposed stance
IV. Risk team (debate):   Risky · Neutral · Safe               → Risk Manager
V.  Portfolio Manager:    approve / reject
Modules: agents/ · dataflows/ (Alpha Vantage, Yahoo, Finnhub) · graph/ (LangGraph state machine,
         checkpoint resume, persistent decision log) · llm_clients/ (OpenAI, Anthropic, Google, xAI,
         DeepSeek, Qwen, GLM, **OpenRouter**, Ollama, Azure, openai_compatible)
Recent upstream adds worth taking: structured‑output agents (Research Manager/Trader/PM), 5‑tier
rating scale, LangGraph checkpoint resume, persistent decision log.
```

### 1c. Components to ADOPT vs REJECT (for our Node/PVE/deterministic system)

| Component | Verdict | Why |
|---|---|---|
| Role decomposition (analysts → bull/bear debate → risk → summary) | **ADOPT (as overlay)** | High‑value, explains a signal from multiple angles; maps cleanly onto our real data. |
| Structured outputs per agent (typed JSON verdicts + rationale) | **ADOPT** | Keeps AI output parseable and displayable; avoids free‑text drift. |
| Persistent decision/analysis log | **ADOPT (light)** | Store each AI run per ticker for the Replay/History tabs. |
| `llm_clients` unified provider incl. OpenRouter | **ADOPT the pattern** | We implement a tiny Node OpenRouter client (see §2), not the Python module. |
| LangGraph state machine | **REJECT** | Python + heavy dep; our flow is a short sequential/parallel orchestration — reimplement in ~1 file of Node, zero deps. |
| `dataflows/` (Alpha Vantage / Yahoo / Finnhub) | **REJECT** | **PVE v1 already provides superior data** (chain+Greeks+IV+OI+GEX+sweeps+IV‑rank+news+13F+congress+insider). No new vendors. |
| Trader/PM that **makes/executes** the decision | **REJECT** | Violates determinism. The deterministic engine owns the decision; AItrader role becomes *commentary only*. |
| Python framework import / running their graph | **REJECT** | Would replace our engine and add a Python runtime. Not doing it. |

**Net:** take the *ideas* (roles, debate, structured verdicts, decision log) — not the code, not LangGraph, not their data layer, not their decision authority.

---

## 2. OpenRouter integration plan (the AI layer)

- **Endpoint:** `https://openrouter.ai/api/v1/chat/completions` — OpenAI‑compatible. **Auth:** `Authorization: Bearer sk-or-…` (server‑side only). **Model:** `author/slug` (e.g. `anthropic/claude-…`, `openai/gpt-…-mini`, `google/gemini-…-flash`). Optional `HTTP-Referer` / `X-Title`.
- **No new dependency:** call it with the built‑in `fetch` (same approach as the PVE provider). Zero‑dep policy preserved.
- **Where it plugs in:** a new **server‑side** module `providers/openrouter.js` + an orchestrator `ai/agents.js`. A new route `POST /api/ai/analyze/:ticker`:
  1. builds the **deterministic** signal (options‑engine over **PVE v1** chain/GEX/IV/sweeps) — the same numbers the dashboard already shows;
  2. gathers PVE v1 context (chain summary, GEX/flip/walls, IV‑rank, top unusual sweeps, net‑premium, optional congress/insider/13F/news);
  3. runs the role prompts through OpenRouter (analysts → bull/bear → risk → summary), each returning structured JSON;
  4. returns narrative + verdicts **plus the unchanged deterministic score**.
- **Cost / limits control:** pay‑as‑you‑go (+~5.5% fee); default to a cheap model, **configurable** (`OPENROUTER_MODEL`) with a fallback model; **opt‑in per request** (a button — never auto‑run on every poll); **cache** AI results per ticker for a few minutes; hard timeout + graceful "AI unavailable" on error/quota.
- **Safety:** key server‑side only (same boundary tests as PVE/options keys); prompts instruct the models to **explain the provided real numbers, not invent any**; every AI panel carries a disclaimer and "does not affect the Signal Score."

---

## 3. Polygon → PVE v1 equivalence & removal

We only ever used Polygon for two things. PVE v1 covers both — and more.

| What Polygon gave us | PVE v1 equivalent | Verdict |
|---|---|---|
| Option chain (strikes/expiries/Greeks/IV/OI/quotes) via `/v3/snapshot/options/{t}` | `/options/{ticker}/contracts` (quote, volume, OI, IV, Greeks) | **Redundant → remove** |
| Underlying price/volume via `/v2/snapshot/.../{t}` | `/stock/{ticker}/profile` (price) + `/stock/{ticker}/ohlc` (daily OHLCV, prevClose) | **Redundant → remove** |
| GEX / gamma‑flip / walls | *(Polygon didn't provide — we computed it)* → `/gex/{ticker}` gives it **real** | PVE **superior** |
| Unusual / sweeps | *(Polygon didn't classify)* → `/flow/unusual` real sweeps/golden | PVE **superior** |
| IV rank | *(Polygon didn't provide)* → `/volatility/{ticker}/iv-rank` | PVE **superior** |

**Only nuance:** Polygon's stock snapshot is near‑real‑time last trade; PVE `/profile` price can be
slightly delayed and `/ohlc` is daily. The deterministic **stockScore uses momentum vs prior close**, so
daily/profile data is sufficient — no functional loss. (If you ever want sub‑minute underlying ticks,
that's the single thing to revisit; the engine doesn't use it today.)

**Removal plan (on approval):** delete the Polygon adapter + its normalizers + its tests from
`providers/options.js` / `test/options-provider.test.mjs`; keep `NullOptionsProvider` + the **PVE
provider** + `makeOptionsProvider` (now `pve | null` only); drop Polygon mentions from `.env.example`.
Net test delta: −6 Polygon‑normalizer tests (PVE provider tests already cover the real path).

---

## 4. Proposed target architecture (text)

```
                                   PVE.trade v1 (PRIMARY, Bearer)
        chain·Greeks·IV·OI · GEX/flip/walls · IV‑rank · unusual sweeps · net‑premium · 13F/congress/insider/news
                                            │
                 ┌──────────────────────────┴───────────────────────────┐
                 ▼                                                        ▼
   DETERMINISTIC ENGINE (unchanged)                        AI ANALYSIS OVERLAY (new, OpenRouter)
   options+stock primary · PVE confirm ·                   analysts → bull/bear debate → risk → summary
   score/dir/tier/features/backtest/replay                 reads engine outputs + PVE data
                 │   ▲ sole source of the score                         │  narrative + structured verdicts only
                 │   └──────────────────  NO WRITE‑BACK  ───────────────┘  (never sets score/dir/tier)
                 ▼
             DASHBOARD:  Signal (deterministic)  +  "AI Analysis" panel (commentary, disclaimered)
   Keys (PVE_API, OPENROUTER_API_KEY): server‑side only, never in browser.   Polygon: removed.
```

---

## 5. Files to change (only after you approve)

| File | Change |
|---|---|
| `providers/openrouter.js` *(new)* | OpenRouter client: `fetch`, Bearer, model+fallback, timeout, error handling. Key server‑side. |
| `ai/agents.js` *(new)* | Role prompts + orchestration (analysts/bull/bear/risk/summary) → structured JSON. Pure given (signal, pveData, llmFn); LLM calls isolated & mockable. Returns narrative only. |
| `server.js` | New `POST /api/ai/analyze/:ticker` (deterministic signal + PVE context → OpenRouter → narrative). Add `OPENROUTER_*` config + AI status on `/api/_monitor`. **Remove Polygon** from provider wiring. |
| `providers/options.js` | Remove Polygon adapter/normalizers; keep PVE + Null. |
| `public/index.html` + `public/app.js` | "AI Analysis" panel on the ticker/Options view: run‑button, analyst cards, bull/bear debate, risk review, disclaimer "does not affect the Signal Score." |
| `test/ai.test.mjs` *(new)* | (a) context/prompt builder deterministic given inputs (mock LLM); (b) **boundary:** AI output cannot change `finalScore`/`dir`/`tier` — score identical with and without AI. |
| `test/options-provider.test.mjs` | Drop Polygon normalizer tests. |
| `.env.example`, `README.md` | Add `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`; remove Polygon. |

**Dependencies added: none** (OpenRouter via `fetch`; no Python, no LangGraph). Deterministic engine,
classifier, backtest, replay: **unchanged**.

---

## 6. Decisions I need before coding

1. **Confirm the boundary:** AI overlay is **advisory only**; the deterministic engine remains the sole source of the score/decision. (Recommended — required to keep your determinism guarantees.)
2. **The two forks:** share `AnTechAI/TradingAgents` + `SboTeaman/TradingAgents` READMEs / trees (or make public) if you want anything fork‑specific; otherwise I proceed with the canonical architecture + upstream additions above.
3. **Default model + budget:** pick a default OpenRouter model (cheap vs premium) and whether AI runs **on demand only** (recommended) vs auto. Confirm caching TTL.
4. **Polygon removal:** confirm full removal (PVE v1 covers everything we used). 
5. **Scope of AI context:** minimum = chain/GEX/IV/sweeps/net‑premium; optional extras = congress/insider/13F/news. Which do you want the agents to see?

On your answers I'll implement incrementally, keep the deterministic tests green, add the AI boundary
test, and remove Polygon.
