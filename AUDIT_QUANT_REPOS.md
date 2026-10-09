# PVE v1 Options → US‑Stock Signal Engine — Research Audit (AUDIT ONLY, no code changed)

All five repos were downloaded and inspected from source (not README‑only). Every feature below is
mapped to the **real** PVE v1 fields this project already reaches. Nothing here is implemented.

Availability legend: **A** = available directly · **C** = calculable from PVE · **H** = needs our own
historical snapshots · **N** = not available.

---

## 1. Repository‑by‑repository audit

**1) NavnoorBawa/Options‑Flow‑Predictor** — a single Jupyter notebook. Data: **yfinance** (Yahoo option chains + prices). Features: PCR family, unusual volume, IV, 25‑delta risk‑reversal, regime features. Targets: multi‑horizon forward returns (1/3/5‑day) + Sharpe‑based + "strong‑move" + direction. Models: RandomForest + XGBoost + a Keras **LSTM** ensemble; `feature_importances_`; `TimeSeriesSplit`. Notably includes an explicit **leakage fix** (drops all `target_*`/`return_*` from the feature matrix). Weakness: yfinance options are thin/delayed; single‑file; no fill realism; no walk‑forward beyond TimeSeriesSplit; small universe. Vendor: yfinance.

**2) MitchelTurner/GEX** — a serious production GEX system (212 py). Data: **Unusual Whales → PostgreSQL** (snapshots summary JSONB + `snapshot_strikes` per‑strike GEX; timestamped). Core: `gex_core/structural.py` (`attribute_last_move`, `structural_forward_delta(history, decay)`), `calibration.py` (regress forward returns on ΔGEX: `fit_move_per_delta_gex`, `expected_directional_move_pct`, empirical `fit_close_above_flip_rate`, `calibrate_confidence` = shrinkage of raw toward empirical), `order_flow.py` (signed ΔGEX flow trend, `flow_imbalance`), plus XGBoost + LSTM trainers and many **walk‑forward backtests** (`backtest_signal_outcomes` with `_wall_respected`, `backtest_gex_prediction`, `compare_wall_gex_backtest`, `backtest_improvement_sweep`) and **Monte‑Carlo** near‑walls. Best‑in‑class: **calibration** and **historical GEX snapshots**. Weakness: heavy infra (Postgres/Railway), UW dependency, some LLM advisory coupling.

**3) BitraAI/gex_app ("GammaEx")** — Streamlit analytics (17 py). Data: **Schwab API** (+ ETF‑proxy backfill for index chains). Computes GEX **and VEX (vanna) and CEX (charm)**, per‑strike walls/flip, **dealer curve** (cumulative GEX/VEX/CEX), **arbitrage‑free SSVI/SVI vol surface** for clean skew/IV, **VRP** (IV vs RV), **expected move**, **absorption** (volume per $1 of GEX), net flow / buy‑sell imbalance, Telegram alerts. Formula seen: `vex = vega·oi·100·spot·0.01` (signed by right). Best: **VEX/CEX + SSVI skew + absorption + VRP**. Weakness: visualization‑heavy, Schwab‑bound, no backtest/labeling.

**4) zrack/gex‑terminal** — intraday GEX research terminal (100 py, snapshot jsonl). Data: **Databento / CBOE / yfinance** fixtures. Strong on **replay** (`replay_lab`, `databento_replay`, session capture/snapshots), `regime.py`, **`price_action_validation.py`** (validate signals against subsequent price action), `performance_lab.py`, `model_evidence`/`model_profiles`, provider certification/fault labs. Best: **snapshot + replay + price‑action validation** discipline (research workflow). Weakness: intraday‑vendor bound; no production trading.

**5) DevDizzle/gammarips‑engine** — the most sophisticated (260 py, 32 sql, GCP/BigQuery/dbt). Microservices: overnight‑scanner, enrichment, **signal‑judge** (advisory LLM ranker with `case_memory`/rubric — a direct precedent for our AI overlay), x‑poster/blog (LLM), **`backtesting_and_research/`**. Methodology gold:
  - **Dual labeling**: directional correctness **and** an **opportunity‑surface (3‑day MFE/MAE) fill‑health** labeler (`mfe=(high.max−fill)/fill`, `mae=(low.min−fill)/fill`).
  - **Fill realism**: entry fill window (e.g. 10:00 ET = bar close ×1.02 within 15 min), bracket +40%/−30% with **STOP checked before TARGET intrabar**, flat 15:45 exit paying 2%, **UNFILLABLE** when no real print (with sensitivity scoring UNFILLABLE MFE=0).
  - **Significance**: **day‑clustered bootstrap paired by scan_date, 10,000 resamples, 90% CI**.
  - **Control arms** (A/B/C: signal vs pool‑benchmark vs matched control) — compare to a control, never to zero.
  - **Filter research pipeline**: `build_labeled_signals` → `find_winning_filter` (univariate deciles both directions, categoricals, pairwise intersections; **OOS chronological holdout newer‑30% + minimum‑n floor to suppress overfit**) → **`bootstrap_validate_filter`** (5000× bootstrap OOS 5/50/95; **compare filtered vs baseline CI overlap → if overlapping, the filter doesn't help**; walk‑forward half‑split stability) → bracket sweep.
  - **Overnight scanner scoring**: additive point score with **divergence resolved FIRST** (institutions fading the tape = highest‑information), dollar‑volume skew tiers, **cluster boost** (≥4 qualifying names same industry+direction), liquidity floor (min OI). 
  Best overall for **flow‑quality + MFE/MAE + validation**. Weakness: BigQuery/dbt/GCP heavy; vendor flow upstream.

---

## 2. What each repo does best
OFP → multi‑horizon **targets + leakage discipline + feature importance**. GEX → **calibration (score→probability) + historical GEX snapshots + walk‑forward "wall respected"**. GammaEx → **VEX/CEX + SSVI skew + absorption + VRP**. gex‑terminal → **snapshot/replay + price‑action validation + regime**. gammarips → **dual MFE/MAE labeling + fill realism + paired bootstrap + control arms + filter bootstrap‑validation + shadow/paper**.

---

## 3 & 4. Feature matrix + PVE compatibility (merged)

| Feature | Repos | Measures | PVE availability | PVE source | Historical? | Leakage risk |
|---|---|---|---|---|---|---|
| PCR (vol & OI) | OFP,gammarips | call/put balance | **C** | chain volume/OI; `/overview` put/call | flow 90d / snapshots | low |
| OI | all | open positioning | **A** | chain `open_interest` | snapshots for change | low |
| OI change (ΔOI) | GEX,gammarips | new positioning | **H** | chain over time | **needs snapshots** | med (opening vs closing) |
| Volume, Vol/OI | all | activity vs base | **A/C** | chain volume, OI | — | low |
| Unusual volume | OFP,gammarips | vol≫OI | **A** | flow `is_unusual` | flow 90d | med |
| Sweeps / golden | GEX,gammarips | aggressive multi‑exch | **A** | flow `trade_type`,`is_golden_sweep` | flow 90d | low |
| Net premium; call/put premium; imbalance | all | aggressor‑aware $ | **A** | `/stock/{t}/net-premium`, `/market/tide` | ≤7d intraday / snapshots | low |
| GEX (net/call/put) | all | dealer gamma | **A** | `/gex/{t}` | **snapshots** (no history endpoint) | low |
| GEX per‑strike / concentration | GEX,GammaEx,term | profile shape | **C** | `/gex/{t}/by-strike` | snapshots | low |
| Gamma flip; flip distance | all | regime pivot; (spot−flip)/spot | **A / C** | `/gex/{t}` gamma_flip + spot | snapshots | low |
| Call wall / put wall; wall distance | all | magnets; (wall−spot)/spot | **A / C** | `/gex/{t}` | snapshots | low |
| ΔGEX; GEX acceleration | GEX | flow of dealer gamma | **A (flow) / H (summary)** | `/gex/{t}/flow` (7d signed) ; summary Δ needs snapshots | 7d / snapshots | med |
| GEX regime (long/short/near‑zero) | all | sign of net_gex | **A** | `/gex/{t}` net_gex sign | snapshots | low |
| IV; IV rank; IV percentile | all | vol level/context | **A** | chain IV; `/volatility/{t}/iv-rank` | `/volatility/{t}/history` 3y | low |
| IV skew / 25Δ risk‑reversal | OFP,GammaEx | put−call IV @25Δ | **A** | `/volatility/{t}/skew` | history in‑endpoint | low |
| IV term structure / slope | GammaEx | contango/backwardation | **A** | `/volatility/{t}/term-structure` | — | low |
| Expected move | GammaEx,term | ATM IV·√(DTE) | **C** | chain ATM IV + dte | — | low |
| Delta/Gamma/Theta/Vega | all | greeks | **A** | chain + flow | — | low |
| VEX (vanna) / CEX (charm) | GammaEx | vol/time hedging | **A (agg) / C (strike)** | `/gex/{t}` net_vanna,net_charm; vega·oi per strike | snapshots | low |
| 0DTE exposure | GEX | same‑day gamma | **C (exposure) / N (intraday outcome)** | chain/flow dte==0 | intraday underlying N | high (intraday) |
| Dealer positioning | all | net_gex/dex/vanna | **A** | `/gex/{t}` net_dex etc. | snapshots | low |
| Price momentum; volume momentum | OFP,gammarips | trend | **C** | `/stock/{t}/ohlc` daily | 2y daily | low |
| Realized volatility | GEX,GammaEx | historical vol | **C** | ohlc returns | 2y | low |
| VRP (IV−RV) | GammaEx | vol premium | **C** | IV − RV | — | low |
| Market regime | all | risk‑on/off | **C** | `/market/tide`, sector tide, SPY ohlc | session/2y | low |
| Flow acceleration / imbalance | GEX,GammaEx,gammarips | flow dynamics | **A/C** | `/flow` time‑bucketed, net‑premium buckets | ≤7d / snapshots | med |
| Absorption | GammaEx | volume per $1 GEX | **C** | volume ÷ GEX | snapshots | low |
| Divergence (flow vs tape) | gammarips | smart‑money fade | **C** | net‑premium sign vs price change | — | low |
| Flow quality / opportunity | gammarips | tradability | **C** | premium+size+dte+otm+OI+golden+GEX+IV+price | flow 90d for labels | med |
| MFE / MAE (swing, multi‑day) | GEX,gammarips | favorable/adverse excursion | **C** | `/stock/{t}/ohlc` daily high/low | 2y daily | med (label window) |
| MFE / MAE (intraday) | gammarips,term | intraday excursion | **N (underlying) / C‑ish (option)** | ohlc is daily; `/contracts/{occ}/intraday` 90d option‑price only | — | high |
| Historical setup performance | GEX,gammarips | prior outcomes | **C+H** | flow/vol history + our GEX snapshots | flow 90d + snapshots | high (overfit) |
| Cluster (industry+direction) | gammarips | breadth confirmation | **C** | `/companies` sector/industry | — | low |
| Dark pool index | (context) | off‑exchange | **A** | `/stock/{t}/darkpool` | — | low |
| Earnings/event proximity | (risk) | event risk | **A** | earnings endpoints | — | low |
| Congress / insider / 13F | (context) | positioning | **A** | dedicated endpoints | quarterly | low |

Headline: **PVE v1 covers almost everything these five repos do — often better** (it *serves* GEX/flip/walls/vanna/charm/skew/IV‑rank/classified sweeps that the repos had to compute). The **one true gap** is a **historical time series of the `/gex` summary** (net_gex/flip/walls) and **point‑in‑time IV‑rank** — PVE serves those **live only**, so ΔGEX‑of‑summary, GEX regime *history*, and absorption *history* **require our own timestamped snapshots**. Intraday **underlying** OHLC is also absent (daily only) → intraday/0DTE outcome labeling is limited. **No vendor reintroduction is warranted.**

---

## 5. Consensus feature map (independently supported across repos)

| Feature | # repos | PVE | Hypothesis | Data need | Leakage |
|---|---|---|---|---|---|
| GEX regime (sign of net_gex) | 5 | A | short‑gamma amplifies, long‑gamma mean‑reverts | snapshots for history | low |
| Gamma‑flip distance | 5 | C | proximity/side of flip conditions next move | snapshots | low |
| Call/Put wall distance | 5 | C | walls act as magnets/barriers | snapshots | low |
| Net premium / aggressor imbalance | 5 | A | directional $ leads short‑term drift | ≤7d/snapshots | low |
| Sweeps / golden sweeps | 4 | A | urgency = information (only *with* context) | flow 90d | med |
| IV rank / IV context | 5 | A | conditions payoff & move size | history A | low |
| Realized vol / VRP | 3 | C | vol regime & richness | ohlc | low |
| Price/volume momentum confirmation | 4 | C | flow needs tape confirmation | ohlc | low |
| MFE/MAE outcome labeling | 3 | C | separates "right" from "tradable" | daily ohlc | med |
| Walk‑forward + calibration | 3 | — | score ≠ probability | history | (method) |

Features backed by ≥4 repos get first priority: **GEX regime, flip distance, wall distance, net‑premium imbalance, IV context** — all PVE‑native.

---

## 6. Best flow methodology (from gammarips, adapted to PVE)
Reject "unusual call = bullish." Build a **flow‑quality score** from real flow fields — premium size, premium/OI, `is_golden_sweep`/`trade_type`, moneyness (`otm_percent`), `dte`, `is_opening`, aggressor `direction` — **gated by** GEX regime + IV context + **underlying tape confirmation** + **cluster breadth**, then **validated by historical setup outcomes** before it is ever trusted. Divergence (heavy put premium into a rally / call premium into a selloff) is a distinct high‑information signal.

## 7. Best GEX methodology (from MitchelTurner/GEX)
Treat static GEX as features via **regime (sign), signed distance to flip, signed distance to walls, concentration near spot (`/gex/by-strike`), ΔGEX (`/gex/flow` for transacted greeks; summary Δ from snapshots), and interaction with price momentum** — then **calibrate** the score to realized outcomes (regress forward return on ΔGEX; empirical close‑above‑flip rate; shrink raw confidence toward empirical). This is the antidote to "score = probability."

## 8. Best options→stock methodology
It is an **interaction** problem, not single indicators. Candidate composite (hypothesis, to be tested, not assumed): `GEX regime × flip‑distance × net‑premium imbalance × sweep‑direction/quality × IV regime × price‑momentum confirmation`, with **divergence** and **cluster breadth** as modifiers. Prove/reject via the framework in §10.

## 9. Best MFE/MAE methodology (gammarips)
**Dual labeling**: (a) directional correctness at H days; (b) **opportunity‑surface** — swing MFE/MAE from daily `/stock/{t}/ohlc` high/low over the hold, plus time‑to‑MFE/time‑to‑MAE and signal survival. Distinguishes "correct direction" from "tradable." Underlying intraday MFE/MAE is **not** available (daily bars) — keep labeling at **daily/swing** horizon, and treat any intraday claim as out of scope with current PVE data.

## 10. Best backtesting methodology (gammarips + GEX)
Timestamped snapshots; **train/validation/test split chronologically**; **walk‑forward**; **OOS chronological holdout (newer‑30%) with a minimum‑n floor**; **paired‑by‑day block bootstrap (10k resamples, 90% CI)**; **control arms** (signal vs matched control vs random); **filter discoveries must pass `bootstrap_validate` (filtered‑vs‑baseline CI must not overlap; OOS halves must be stable)**; **calibration/reliability** (is a 70 empirically better than a 50?). Leakage guards: never read future IV/OI/GEX; snapshot at signal time only; no intraday/EOD mixing; no overlapping train/test days; **shadow/paper** before any production weighting change. **Explicitly test that 70+ signals beat lower‑scoring ones OOS** — do not assume score = probability.

---

## 11. Features worth adopting (PVE‑native, high value)
GEX regime; signed gamma‑flip distance; signed wall distances; GEX concentration near spot; net‑premium aggressor imbalance; sweep **quality** (premium/OI, golden, opening, DTE, moneyness) not raw count; IV rank + skew (25Δ risk‑reversal) + term‑structure slope; VRP (IV−RV); realized‑vol regime; price/volume momentum confirmation; divergence; cluster breadth; VEX/CEX (net_vanna/net_charm) as regime context; dual MFE/MAE labeling; calibration.

## 12. Features to reject (now)
Raw "unusual = directional"; ML *inside* production scoring; intraday/0DTE **underlying** outcome features (no intraday underlying data); SSVI surface fitting (heavy; PVE already gives skew/IV‑rank — revisit only if skew proves insufficient); any Schwab/Databento/CBOE/UW/yfinance vendor coupling; LLM anywhere in the deterministic path.

## 13. Features requiring historical data (our snapshots or PVE history)
Our **timestamped snapshots** required: GEX summary time series (net_gex/flip/walls), ΔGEX‑of‑summary, GEX regime history, absorption history, OI change, point‑in‑time IV‑rank series, and **historical setup performance / calibration tables**. Available from **PVE history** (no self‑capture): flow (90d), IV/skew surface (3y), OHLC (2y), per‑contract daily (90d), transacted greek flow (7d).

## 14. Features vulnerable to leakage (guard explicitly)
OI change (opening vs closing ambiguity — use `is_opening`); ΔGEX (must use snapshot at t, never t+1); IV/GEX/net‑premium (never pull the post‑move value); MFE/MAE label window (compute strictly after signal time); historical‑setup/filter mining (OOS holdout + bootstrap‑validate or it overfits); intraday/EOD mixing; overlapping train/test days.

---

## 15. Proposed stronger deterministic architecture (design only)
```
PVE v1 → DATA QUALITY (availability flags; stale/oi_estimated) → NORMALIZATION
  → FEATURE ENGINE
      OPTIONS: flow‑quality · OI/ΔOI · premium/imbalance · IV/IV‑rank/skew/term · greeks · GEX · flip/walls/concentration · VEX/CEX
      UNDERLYING: price · momentum · volume · realized‑vol · VRP · regime(market tide)
  → FLOW‑QUALITY FILTER (premium/OI, golden, opening, DTE, moneyness, liquidity floor)
  → FEATURE INTERACTIONS (regime×flip‑distance×imbalance×sweep‑quality×IV×momentum; divergence; cluster)
  → DETERMINISTIC SIGNAL (existing math, unchanged) → SCORE 0–100 → DIRECTION → TIER
  → [offline] WALK‑FORWARD VALIDATION + CALIBRATION → SIGNAL‑QUALITY REPORT
Separately (unchanged): SIGNAL + PVE data → OpenRouter AI → explanation/bull/bear/risk (advisory; cannot modify score).
```
The **existing deterministic scoring stays authoritative**; new features would be added **only after** each passes §10 validation, introduced behind config and defaulting off.

## 16. Proposed feature interactions (hypotheses to test, not truths)
(a) short‑gamma regime + price beyond flip + confirming net‑premium → momentum continuation; (b) long‑gamma regime + price into a wall → mean‑reversion/pin; (c) high‑quality golden sweep + opening + supportive GEX + tape confirmation → directional; (d) divergence (flow vs tape) + IV‑rank low → fade the tape; (e) cluster breadth (≥N same industry+direction) as a confidence multiplier. Each tested via walk‑forward + control + bootstrap.

## 17. ML research architecture (offline only)
Use ML **only for research**: LogisticRegression/RandomForest/XGBoost/LightGBM for **feature importance + interaction discovery**; KNN/regime clustering for **regime detection**; isotonic/Platt for **calibration**; LSTM only as a comparison baseline. Gate: production ML is recommended **only if** rigorous walk‑forward + control + bootstrap shows it beats the deterministic engine OOS. Default: **no ML in production scoring** (unchanged rule).

## 18. Data‑storage requirements
A lightweight **timestamped snapshot store** (JSONL/SQLite/Parquet) capturing, per (ticker, timestamp): `/gex` summary + `/gex/by-strike`, IV‑rank, net‑premium buckets, top unusual flow, spot — the minimum needed for ΔGEX/regime‑history/absorption/calibration. Plus a **labeled‑signals table** (signal snapshot + forward daily OHLC → direction + MFE/MAE) and a **calibration/reliability table**. Reuse the existing optional `ai-runs` persistence pattern (off by default; no secrets).

## 19. Exact PVE endpoints/fields required
`/options/{t}/contracts` (strike,right,expiry,volume,open_interest,implied_volatility,delta,gamma,theta,vega,bid,ask; meta.available_expirations) · `/gex/{t}` (net_gex,call_gex,put_gex,net_dex,net_vanna,net_charm,gamma_flip,call_wall,put_wall) · `/gex/{t}/by-strike`,`/by-expiry`,`/flow` · `/volatility/{t}/iv-rank`,`/skew`,`/term-structure`,`/history` · `/flow`,`/flow/history`,`/flow/unusual`,`/flow/ticker/{t}` (premium,size,right,trade_type,is_golden_sweep,is_opening,direction,dte,otm_percent,spot,open_interest,implied_volatility) · `/stock/{t}/net-premium`,`/ohlc`,`/profile`,`/darkpool`,`/analyst` · `/companies` (sector/industry) · `/market/tide`,`/tide/sectors` · earnings/congress/insiders/13F (context) · `/stream/token` (optional live). No non‑PVE vendor required.

## 20. Expected implementation complexity
- Snapshot store + labeled‑signals + MFE/MAE labeler: **medium**.
- Feature engine additions (regime, distances, concentration, imbalance, skew, VRP, flow‑quality, divergence, cluster): **medium** (pure functions, unit‑testable, zero‑dep).
- Walk‑forward/bootstrap/calibration research harness: **medium‑high** (offline; may use a separate research venv with numpy/pandas — **not** shipped into the zero‑dep server).
- Wiring validated features into deterministic scoring (behind flags): **low‑medium**.
- Interaction/ML research: **high** (offline only).

## 21. Exact files that would eventually change (only after approval, phase‑gated)
- **New (offline research, separate from server):** `research/snapshot_store.*`, `research/labeler_mfe_mae.*`, `research/walk_forward.*`, `research/calibration.*`, `research/find_filter.*` (kept out of the runtime dependency graph).
- **New (runtime, pure):** `features/flow_quality.js`, `features/gex_features.js`, `features/vol_features.js`, `features/interactions.js` (+ tests each).
- **Modified (only for validated features, behind config):** `public/options-engine.js` (consume new feature values — **scoring math untouched unless a feature passes validation and you approve a weight change**), `providers/pve.js` (add `getByStrikeGex`,`getSkew`,`getTermStructure` adapters), `server.js` (optional snapshot capture endpoint; feature exposure), `.env.example`, `public/index.html`/`app.js` (signal‑quality report view).
- **Never:** classification/backtest/replay authority, deterministic math (without explicit approval), or any vendor add.

## 22. Tests required
Pure‑function tests for every new feature (known inputs → known outputs; null‑safety = no fabrication); leakage tests (labeler never reads future bars; snapshot used at t only); calibration monotonicity test; **boundary tests preserved** (AI can't change score; PVE sole options source; Polygon absent); a **research‑harness test** proving walk‑forward split has no train/test day overlap; and a regression test that **existing finalScore/dir/tier are unchanged** until a feature is explicitly enabled.

## 23. Recommended implementation phases
- **Phase 0 (enablers):** snapshot store + labeled‑signals + MFE/MAE labeler + provider adapters (`by-strike`, `skew`, `term-structure`). No scoring change.
- **Phase 1 (features, shadow):** compute new PVE‑native features + flow‑quality score in **shadow** (exposed/logged, not scored).
- **Phase 2 (validation):** walk‑forward + control + bootstrap + calibration; **prove 70+ beats lower OOS**; publish signal‑quality report.
- **Phase 3 (selective adoption):** fold only validated features into deterministic scoring behind config, one at a time, each with before/after regression + your approval.
- **Phase 4 (optional):** research ML for importance/calibration; production ML only if it beats deterministic OOS.

## 24. Top 10 highest‑value improvements (ranked)
1. **Timestamped snapshot store** (unlocks ΔGEX, regime history, calibration, backtests). 
2. **Dual MFE/MAE swing labeler** (tradability, not just direction). 
3. **Walk‑forward + paired bootstrap + control‑arm harness** (truthful evaluation). 
4. **Calibration** (map score→empirical probability; kill the "70=70%" assumption). 
5. **Flow‑quality score** (premium/OI, golden, opening, DTE, moneyness) replacing raw "unusual". 
6. **GEX interaction features** (signed flip/wall distance + concentration + regime × momentum). 
7. **Divergence signal** (flow vs tape). 
8. **IV context pack** (IV‑rank + 25Δ skew + term slope + VRP). 
9. **Cluster breadth** confirmation (sector/industry). 
10. **Signal‑quality report** in the dashboard (per‑tier/per‑setup OOS stats + reliability curve).

## 25. Final recommendation
Adopt the **ideas**, not the code or vendors. PVE v1 already supplies (and often pre‑computes) the data all five repos work hard to derive; the only genuine gaps are a **historical GEX‑summary/IV‑rank time series** (fixable with our own lightweight snapshots) and **intraday underlying bars** (accept a **daily/swing** horizon). The single most important change is **not** more features — it is a **validation + calibration harness** proving, out of sample with control arms and bootstrap, that higher scores are actually more tradable. Proceed **phase‑gated**: build enablers → shadow features → validate → adopt only what passes, behind config, with the deterministic engine, PVE‑sole‑source, Polygon‑removed, and AI‑advisory‑only rules all intact.

**No code changed. Awaiting approval to begin Phase 0.**
