# PVE Signal Engine — US-Equity Upgrade (implementation report)

Honest, deterministic US-stock **prediction-market** intelligence engine. This document records
what was actually implemented, what was borrowed from the referenced GitHub projects, and what was
intentionally rejected. It is not marketing copy.

> **Data reality:** PVE.trade is a prediction-market API. It does **not** provide option chains,
> strikes, expirations, Greeks, IV, IV rank/surface, real OI, GEX, gamma flip, max pain, OPRA,
> options sweeps/blocks, real equity NBBO, or underlying equity OHLCV. Nothing here fabricates
> those values or relabels prediction-market data as options data.

---

## 1. GitHub research -> what was actually incorporated

Mapping: **repository -> useful component -> adapted file -> reason**. "Adapted (code/pattern)"
means an algorithm/structure was re-implemented here. "Methodology only" means a technique informed
new code but no source was copied. "NOT INTEGRATED" means it cannot work on PVE data.

| Repository | Useful component | Adapted into | Status / reason |
|---|---|---|---|
| **unusual-options-scanner** | Anomaly-vs-baseline detection (rolling-median baseline + ratio anomaly score; spike magnitude; persistence/confirmation) | `public/engine.js`: `baselineStats`, `anomalyRatio`, `acceleration`, `persistence`, `flowDiagnostics`; shown in scanner/stocks columns + detail modal | **Adapted (algorithm).** Core is anomaly detection over a volume baseline -> maps cleanly onto PVE prediction-market volume/flow. Renamed **"Prediction-Market Flow Anomaly."** Its options parts (OI, chains, OPRA) -> **NOT INTEGRATED - DATA INCOMPATIBILITY**. |
| **signal_engine_v1** | Modular feature-definition architecture (each feature = name/value/direction/weight/confidence/source/proxy/explanation); independently testable features | `public/engine.js`: `FEATURE_DEFS` registry + per-feature `proxy` flags; `test/engine.upgrade.test.mjs` | **Adapted (pattern).** Kept the existing deterministic `validate -> extract -> score -> build -> emit` pipeline; added the modular registry + metadata around it. Engine was **not** rewritten. |
| **KPH3802/options-backtest-engine** | Forward-outcome metric set: win rate, avg/median return, MFE/MAE, drawdown, sample size, score buckets, false-positive rate | `public/engine.js`: `bucketPerformance` (+`avgRange` drawdown proxy), `statsOf` (+`fpr`), `groupPerformance` (by direction/regime) | **Methodology only - equivalent lightweight Node impl, no source copied.** Metric definitions are inherently methodology; implemented in the existing Node/browser architecture with no new deps. |
| **vectorbt** | Vectorized forward-return / win-rate / drawdown over arrays | Same backtest functions (plain JS array math) | **Methodology only - NO dependency, NO Python.** Per instruction vectorbt is not imported; equivalent vectorized-style array math done in JS. |
| **gammagrid** | GEX / gamma flip / Greeks / IV / max-pain / OI heatmap | - | **NOT INTEGRATED - DATA INCOMPATIBILITY.** Every gammagrid metric requires an option chain PVE does not provide. Only the general dashboard-tiles UX *concept* loosely informed the System Health / stock table layout; **no code, algorithm, or metric was taken.** |

No repository was copied wholesale. No dependency was added for any of them.

---

## 2. Final verification

**1) Files changed / added**
- `classify.js` *(new)* - server-side US-equity classifier (pure, tested).
- `public/engine.js` - added versions, tiers, `FEATURE_DEFS`, flow-anomaly helpers (`baselineStats`, `anomalyRatio`, `acceleration`, `persistence`, `regimeFromFlow`, `flowDiagnostics`), signal enrichment (assetType/ticker/tier/diagnostics/proxies), **replay** (`captureSnapshot`, `replaySignal`), backtest additions (`fpr`, `avgRange`, `groupPerformance`). All additive - existing exports/behaviour unchanged.
- `server.js` - classifier gate on `/api/markets` + `/api/market/:slug`, cascade filtering of `/api/flow/spikes` & `/api/flow/top-traders`, new `/api/_classify`, versions + accept/reject stats on `/api/_monitor`.
- `public/app.js` - multi-snapshot history accumulation, replay-snapshot capture, tier/anomaly/proxy display, PVE relabeling, new tabs (US Stock Signals, US Options / PM Signals, Replay, System Health), monitor meta.
- `public/index.html` - nav + sections for the four new tabs, permanent options warning, monitor meta line.
- `.gitignore` *(new)* - protects `.env`, `node_modules/`, logs, secrets, credentials.
- `test/classify.test.mjs` *(new)*, `test/engine.upgrade.test.mjs` *(new)*.
- `README.md`, `SETUP.md`, `UPGRADE.md` updated.

**2) GitHub repositories actually incorporated/adapted**
- **unusual-options-scanner** - anomaly algorithm (code/pattern).
- **signal_engine_v1** - modular feature registry (pattern).
- **KPH3802/options-backtest-engine** & **vectorbt** - backtest *methodology* re-implemented in JS (no code, no deps).
- **gammagrid** - **NOT INTEGRATED - DATA INCOMPATIBILITY.**

**3) For each repository, exactly what was used** - see the table in section 1.

**4) What was intentionally NOT used**
- All option-chain constructs from every repo: strikes, expirations, Greeks, IV/IV-rank/surface, real OI, GEX, gamma flip, max pain, OPRA, sweeps/blocks.
- gammagrid's entire metric layer.
- vectorbt as a runtime dependency (and any Python).

**5) New dependencies** - **none.** `package.json` dependencies unchanged (Express only).

**6) Test count** - **49** (`node --test`): 26 original engine + 14 classifier + 9 upgrade.

**7) Test results** - **49 passed / 0 failed.** All 26 original tests remain green.

**8) New signal features / fields**
- Prediction-Market Flow Anomaly diagnostics: `flowAnomaly`, `volAnomaly`, `spikeMagnitude`, `flowAccel`, `persistence`, `persistenceStreak`, `regime`, `sentiment`, `samples`.
- Signal metadata: `assetType`, `ticker`, `tier`, `proxies[]`, `engineVersion`.
- Scoring weights are **unchanged** - anomaly/persistence feed **ranking + display + diagnostics**, not the 0-100 weighted score (this is what preserves the 26 original tests). The score formula is still `|net tilt| x coverage`.

**9) Current PVE data limitations** - prediction-market only. See the banner above and the permanent warning on the Options tab. Everything is labelled as prediction-market contract price / implied probability, contract volume, token order book, prediction-market flow. Proxy metrics (put/call, OI, PCR) are explicitly flagged as proxies.

**10) Current 403 status** - handled cleanly, not worked around. On 403 (or no key) the API returns `{ ok:false, error:<upstream message> }` with **no fabricated data**; the app boots and every tab shows *"Insufficient live PVE data - <error>"* / *"PVE access unavailable - agent authorization required."* System Health shows exact status. Verified in this build: with no key, `/api/markets` returns `ok:false`, `normalized:null`.

**11) How to verify live US-equity coverage once the PVE key is enabled**
1. Put a valid key in `.env` as `PVE_AGENT_KEY=...`, restart (`npm start`).
2. Log in -> **System Health**: confirm *PVE connection = reachable*, *Live key = yes*, non-zero *Markets received* / *US-equity accepted*.
3. Open **`/api/_classify`** (authenticated) for per-market ALLOW/REJECT decisions with reasons for the last `/markets` fetch.
4. Open **US Stock Signals** - high-scoring US-equity/ETF prediction markets ranked by score -> coverage -> agreement -> flow anomaly -> liquidity -> persistence.
5. Open **API / Data Monitor** - meta line shows engine/classifier versions + received/accepted/rejected counts.
6. Extend the universe via `.env`: `US_EQUITY_TICKERS=TSLA,AAPL,...` (merged with the built-in list).

---

## Discipline notes
- The deterministic engine still owns **all** scoring, risk gates, classification, backtesting, and signal generation. No LLM is in any decision path.
- Replay reproduces a signal purely from its persisted snapshot (raw normalized input, features, score, tier, direction, versions) - proven deterministic by `test/engine.upgrade.test.mjs`.
- The classifier errs toward exclusion: crypto/politics/sports/weather/etc are hard-denied; anything not confidently tied to a US stock/ETF is **REJECTED (UNKNOWN)**.
