# TradingAgents Fork Audit — evidence-based, AUDIT ONLY (no code changed)

Method: the exact names `AnTechAI/TradingAgents` and `SboTeaman/TradingAgents` 404 because the repos are
lowercase **`trading-agents`** (GitHub repo names are case-sensitive). I downloaded both via `codeload`
tarballs and inspected the real source (trees, README, agents, dataflows, llm_clients, graph, tests).

---

## A. Repo 1 — AnTechAI/trading-agents

1. **Accessible?** **YES** (as `AnTechAI/trading-agents`, default branch `main`, ~30 KB, Python; no LICENSE file — Apache‑2.0 upstream lineage).
2. **Differences from canonical:** a **slimmed, cleanly re‑documented** LangGraph reimplementation. Same 5‑phase / 11‑agent shape (4 analysts → bull/bear debate → research manager → trader → 3‑way risk debate → portfolio manager; ratings BUY/OVERWEIGHT/HOLD/UNDERWEIGHT/SELL). Its distinctive traits:
   - **OpenRouter‑ONLY** LLM layer (`llm_clients/client.py` = `NormalizedChatOpenAI` → `https://openrouter.ai/api/v1`).
   - **Per‑role model routing with a `reasoning` flag** (`default_config.py → llm_roles`): cheap flash models for analysts/debaters/trader, a strong reasoning model for research/portfolio managers.
   - **Response‑content normalization** that strips `reasoning`/`thinking` blocks to plain text.
   - Focused docs (`architecture.md`, `agents.md`, `dataflows.md`, `llm_config.md`, `memory.md`).
3. **Useful for us (concepts only):** the **OpenRouter per‑role model + reasoning routing** pattern; the **content‑normalization** helper (handles providers returning content arrays); tidy role/prompt separation.
4. **Do NOT use:** LangGraph + Python runtime; **yfinance** data layer (`y_finance.py`, `yfinance_news.py`, `stockstats_utils.py`) — **no options/GEX/PVE at all**; the trader/portfolio‑manager **decision authority** (LLM emits the BUY/SELL rating).
5. **Better than our current impl?** Only in **one** respect we don't yet have: **per‑role model routing** (we use a single model for one structured call). Everything else it does, our Node overlay already does (OpenRouter via fetch, roles, advisory‑only). It has **no options intelligence**, so nothing data‑side to take.

---

## B. Repo 2 — SboTeaman/trading-agents

1. **Accessible?** **YES** (as `SboTeaman/trading-agents`, `main`, ~3.7 MB, Python, **Apache‑2.0** LICENSE present). Tracks canonical closely through **v0.2.5**.
2. **Differences from canonical:** a **production‑leaning, enhanced** fork. Notable additions:
   - **Structured outputs** (`agents/schemas.py`, `agents/utils/structured.py`, `agents/utils/rating.py`): Pydantic schemas on the 3 decision agents using each provider's **native** structured mode (json_schema / response_schema / tool‑use), with a **render‑back‑to‑markdown** helper and a **5‑tier `PortfolioRating` enum**.
   - **LangGraph checkpoint resume** (`graph/checkpointer.py`, **per‑ticker SQLite**) + persistent decision log + **memory log**.
   - **Robust multi‑provider LLM abstraction** (`llm_clients/`: `factory.py`, `base_client.py`, `capabilities.py`, `model_catalog.py`, `validators.py`, `api_key_env.py`, + openai/anthropic/azure/google clients). **OpenRouter is one of the supported providers.**
   - **Grounded Sentiment Analyst** (reads real Reddit/StockTwits/Yahoo before writing).
   - Strong **tests**, incl. **ticker path‑traversal hardening** (`safe_ticker_component` rejects `.`/`..`), model validation, checkpoint‑resume, structured‑agent tests.
3. **Useful for us (concepts only):** the **structured‑output schema + render‑back** discipline; the **rating enum**; **light persistence** (decision/analysis + memory log) for our History/Replay; **ticker path‑traversal hardening**; the **capability/validation** mindset for model config.
4. **Do NOT use:** LangGraph + Python; the **Alpha Vantage / yfinance / Reddit / StockTwits** data layer (**no options/GEX/PVE**); the full multi‑provider SDK sprawl (we only need OpenRouter via fetch); decision‑authority agents; reflection/backtest loops.
5. **Better than our current impl?** Yes in **three** respects worth adopting **optionally**: (a) **provider‑native structured output** (stronger than our free‑text‑then‑parse, though we keep the fallback), (b) **persistent analysis/decision log** (we only cache in memory), (c) **stricter ticker sanitization**. It has **no options intelligence**.

---

## C. Side‑by‑side

| Component | AnTechAI | SboTeaman | Best for us | Why |
|---|---|---|---|---|
| Accessible | ✅ `trading-agents` | ✅ `trading-agents` | — | both downloaded & inspected |
| Size / maturity | small, docs‑clean | large, production‑leaning | SboTeaman | more battle‑tested patterns |
| Orchestration | LangGraph | LangGraph | **neither** | we stay native Node, zero‑dep |
| LLM gateway | **OpenRouter‑only** | multi‑provider incl. OpenRouter | AnTechAI (simplicity) | matches "OpenRouter is the gateway" |
| Per‑role model routing | ✅ + `reasoning` flag | partial (deep/quick) | **AnTechAI** | cheap analysts / strong managers |
| Structured output | prose only | ✅ Pydantic + render‑back + rating enum | **SboTeaman** | fewer parse failures, stable shape |
| Persistence / memory | memory.py | ✅ checkpoint + decision + memory log | **SboTeaman** | feeds History/Replay |
| Content normalization | ✅ strips reasoning blocks | (per‑provider clients) | **AnTechAI** | robust across models |
| Security hardening | basic | ✅ ticker path‑traversal guard | **SboTeaman** | we take the fix |
| Options / GEX / IV / PVE | ❌ none (yfinance) | ❌ none (AlphaVantage/Yahoo/social) | **neither** | our PVE layer is entirely ours |
| Decision authority | LLM rates BUY…SELL | LLM rates BUY…SELL | **neither** | violates determinism |
| License | (Apache‑2.0 lineage) | Apache‑2.0 | — | permissive |

---

## D. Selected architecture

**HYBRID — concepts only, adapted natively in Node.** Take **AnTechAI's OpenRouter per‑role model
routing (+ reasoning flag) and content normalization**, plus **SboTeaman's structured‑output schema
discipline, rating enum, light persistence, and ticker hardening.** Reject both codebases wholesale
(Python, LangGraph, their data layers, and their LLM decision authority). Keep exactly the shape you
approved and we already built:

```
PVE v1 (PRIMARY) → DATA NORMALIZATION → DETERMINISTIC ENGINE → SCORE/DIR/TIER (authoritative)
                                                        │
                          Analysts → Bull/Bear Debate → Research Summary → Risk Review → AI Commentary
                          (reads engine output + PVE data; OpenRouter; NEVER writes back)
```

Neither fork is "better" than our current overlay on the axes that matter (options data, determinism,
zero‑dep) — but each contributes a few concrete, optional upgrades below.

---

## E. Exact components to ADOPT (all optional, advisory‑layer only)

1. **Per‑role OpenRouter model routing** (from AnTechAI): config like `OPENROUTER_MODEL_ANALYST` (cheap) vs `OPENROUTER_MODEL_MANAGER` (stronger) with a `reasoning` toggle; default both to today's single model. Cost/quality knob.
2. **Provider‑native structured output** (from SboTeaman): when the model supports it, request `response_format`/json‑schema to cut parse failures; **keep our existing text‑extract fallback**.
3. **Rating/verdict enum discipline** (from SboTeaman): fixed `aiView` vocabulary (bullish/bearish/neutral) + confidence — we already do this; formalize it.
4. **Light persistence of AI runs** (from both): optional on‑disk log per ticker (currently in‑memory cache only) to power History/Replay.
5. **Ticker path‑traversal hardening** (from SboTeaman): tighten our sanitizer to reject `.`/`..` (today's regex allows `.`).
6. **Response content normalization** (from AnTechAI): in `providers/openrouter.js`, handle content returned as an array of blocks (strip reasoning/thinking).

## F. Exact components to REJECT

- **LangGraph** and any Python migration.
- Both **data layers** (yfinance, Alpha Vantage, Reddit, StockTwits) — PVE v1 is our source; do not add generic vendors.
- **LLM decision authority** (trader / portfolio‑manager emitting BUY…SELL as the outcome).
- **Reflection / outcome loops** that could feed back into scoring/backtest.
- Multi‑provider SDK layer — we only need **OpenRouter via `fetch`** (zero‑dep).

---

## G. Polygon — confirmation
**Polygon remains removed.** Neither fork uses options data at all, so there is nothing to reintroduce.
PVE v1 covers chain/Greeks/IV/OI and adds real GEX/flip/walls, sweeps, and IV‑rank. No change.

## H. PVE v1 — confirmation
**PVE v1 remains the PRIMARY (and sole) options data source.** The AI overlay consumes the **same real
PVE data** the deterministic engine uses (chain, Greeks, IV/IV‑rank, OI, GEX/flip/walls, unusual/sweeps,
net premium, stock context; optional news/13F/insider/congress only if PVE actually returns them).

## I. Deterministic scoring — confirmation
**Untouched.** Every adoption above is confined to the advisory AI layer. The deterministic engine
remains the sole authority for `finalScore`, `dir`, `tier`, classification, backtest labels, and signal
generation. The AI never writes back — enforced by the existing boundary tests (`ai.test.mjs`,
`boundaries.test.mjs`).

---

### Recommendation
Approve the **HYBRID (concepts‑only)** selection. If you want, I'll implement the six optional upgrades
in **E** incrementally (each behind config, each with tests), starting with the two highest‑value/lowest‑
risk: **per‑role model routing** and **ticker path‑traversal hardening**. No code changes until you say go.
