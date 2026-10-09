# PVE Signal Engine → US Equity Refocus — Pre‑Implementation Audit (A–K)

Audit only. **No code has been changed.** This maps what is already built, what PVE can and
cannot supply, what the reference projects need, and exactly what I propose to change — so you can
approve before implementation.

> **Load‑bearing conclusion:** PVE.trade is a *prediction‑markets flow/intel* API. It does **not**
> expose equity option chains, strikes, Greeks, IV, real open interest, equity NBBO bid/ask, or
> options sweeps. A real US‑equity *options* analytics engine cannot be built from it. The honest,
> buildable target is a **US‑equity prediction‑market signal engine** (signals derived from
> prediction‑market activity on stock‑related event contracts) with every proxy labelled as a proxy.

---

## A. Current architecture audit

```
Browser (public/)                     Node/Express (server.js)                 api.pve.trade
  app.js  poll loop, render     →  auth · TTL cache · rate-limit · normalize  →  X-Agent-Key (server-side)
  engine.js deterministic core  ←  (ALIASES) · call monitor                   ←  raw JSON
  localStorage  history/backtest
```

- **server.js** — proxy: keeps `X-Agent-Key` server‑side; TTL cache (`CACHE_TTL_MS`) + per‑endpoint
  min‑interval throttle (`MIN_UPSTREAM_INTERVAL_MS`); normalizes every response through one `ALIASES`
  map; call monitor; cookie session auth (timing‑safe). Demo mode was fully removed in the last change;
  LIVE‑only, and a missing key returns a clear error rather than synthetic data.
- **public/engine.js** — deterministic, pure, `@ts-check`‑typed, unit‑tested (26 tests). Pipeline:
  `validateSnapshot → extractFeatures → scoreFeatures → buildSignal`; labels (`evaluateOutcome`,
  `updateExcursion`) are a **separate** path (structural leakage protection); `emitDecision`
  (dedup/cooldown/flip); research aggregations (`bucketPerformance`, `featurePerformance`,
  `combinationPerformance`, `splitByTime`, `walkForward`).
- **public/app.js / index.html** — dashboard shell; tabs: Dashboard, Markets, Flow, Fast Signal
  Scanner, Signal History, Backtest, Feature Research, API/Data Monitor, Settings.
- **Scoring today** — `score = |net tilt| × data coverage × 100`; `confidence = coverage`.
  Directional features vote on `net`; confirmation features raise coverage only.

**What is NOT there today:** any asset‑class filter. Markets pass through unfiltered — so if PVE
returns crypto/politics/sports markets, they currently reach the engine. (See G.)

## B. Current PVE endpoint / data audit

| Endpoint (proxied) | Fields normalized | What it really is |
|---|---|---|
| `/markets` | slug, title, tags, status, volume, liquidity, endDate, outcomes[{tokenId, price, volume}] | Event‑contract list; `outcomes` are YES/NO tokens, not option legs |
| `/market/:slug` | same, single | — |
| `/prices?token_id&interval` | series[{t, price}] | **Prediction‑market token price** (implied probability), **not** the stock's share price |
| `/orderbook?token_id` | bids, asks, bidDepth, askDepth, imbalance, mid | Order book **for the event token**, not equity NBBO |
| `/flow` | netFlow, buyVol, sellVol, sentiment, bullish, bearish, hourly | Aggregate prediction‑market flow |
| `/flow/spikes` | slug, tokenId, direction, magnitude, volume, ts | Unusual **prediction‑market** flow events |
| `/flow/top-traders` | name, volume, count, pnl, direction, slug | Leaderboard; per‑market attribution is often absent |
| `/me` | name, balance, stats | Account |

**Critical nuance:** PVE `price`/`volume` describe the *contract*, not the underlying equity. Momentum
computed from `/prices` is the market's probability momentum, **not** the stock's price momentum. This
must be labelled; calling it a "US stock price signal" would misrepresent the source.

PVE does **not** provide: option chains, strikes, expirations, Greeks, IV/IV‑rank, real per‑contract
open interest, equity bid/ask (NBBO), OPRA time‑&‑sales, options sweeps/blocks, or a real underlying
equity price/volume feed.

## C. GitHub research findings

| Project | What it does | Data it requires | Fits PVE? |
|---|---|---|---|
| unusual-options-scanner | Flags unusual **option** volume vs baseline | Equity option volume + OI (broker/OPRA) | **No** — no option volume/OI in PVE. Concept (anomaly‑vs‑baseline) already realized via `/flow/spikes`. |
| gammagrid | Dealer GEX, max pain, IV surface, OI delta, Greeks screener | Full CBOE option chain + Greeks + OI | **No** — 100% chain/Greeks dependent. Only the *heatmap UX* idea is transferable (cosmetic). |
| signal_engine_v1 | Modular feature → weight → score pipeline | Generic | **Concept only** — already embodied in `engine.js`; reinforces the deterministic modular design. |
| KPH3802/options-backtest-engine | Backtests option strategies historically | Historical option chains/prices | **No** for options; the *entry → forward‑outcome → bucketed metrics* methodology already applies to PVE price series. |
| vectorbt | Vectorized backtesting + portfolio stats (win rate, drawdown, Sharpe) | OHLCV price series | **Methodology yes, code no** — adopt metric definitions (median return, max drawdown on a hypothetical hold) over the token price series we already capture; the library itself is heavy Python, our stack is Node/browser. |

Take‑away: the *options* content of these projects is unavailable on PVE; the *methodology* content
(anomaly detection, modular scoring, forward‑outcome backtesting with sample sizes) is already largely
implemented and can be sharpened.

## D. Feature capability matrix

Legend — Reliability: H/M/L; Priority: P1 (core) → P3 (nice); PROXY = labelled analog, not the real thing.

| Feature | Required data | PVE endpoint | Available? | Derivable? | Reliability | Priority | Decision |
|---|---|---|---|---|---|---|---|
| Unusual flow | spike direction+magnitude | `/flow/spikes` | Yes | — | M‑H | P1 | IMPLEMENT (have) |
| Volume anomaly | contract volume vs median | `/markets` | Yes | rel‑to‑median | M | P1 | IMPLEMENT (have, confirmation) |
| Outcome pressure (put/call **PROXY**) | YES/NO outcome volume | `/markets` | Yes (proxy) | — | M | P1 | IMPLEMENT AS PROXY (have) |
| Liquidity/depth (OI **PROXY**) | token order‑book imbalance | `/orderbook` | Yes (proxy) | — | M | P2 | IMPLEMENT AS PROXY (have) |
| Price/probability momentum | token price series | `/prices` | Yes (contract, not equity) | windowed return | M | P1 | IMPLEMENT, RELABEL (have) |
| Smart‑money | top‑trader net, per market | `/flow/top-traders` | Partial (attribution often missing) | — | L‑M | P2 | IMPLEMENT GUARDED (have, self‑disables) |
| Flow acceleration | hourly activity / spikes over time | `/flow`, `/flow/spikes` | Derivable | yes | M | P2 | ADD |
| Sentiment / regime context | aggregate sentiment | `/flow` | Yes | — | L‑M | P3 | ADD (context/regime tag) |
| Cross‑signal confirmation | internal agreement | derived | Yes | yes | — | P1 | HAVE (coverage/agreement) |
| **Call/Put ratio (REAL)** | option call vs put volume | none | **No** | No | — | — | **NOT AVAILABLE — DO NOT IMPLEMENT** |
| **Open interest (REAL)** | per‑contract OI | none | **No** | No | — | — | **NOT AVAILABLE** |
| **Greeks / GEX / gamma flip / max pain** | chain + Greeks | none | **No** | No | — | — | **NOT AVAILABLE** |
| **Implied volatility / IV surface** | chain IV | none | **No** | No | — | — | **NOT AVAILABLE** |
| **Equity bid/ask (NBBO)** | L1 equity quotes | none | **No** | No | — | — | **NOT AVAILABLE** |
| **Options sweeps / blocks** | OPRA time‑&‑sales | none | **No** | No | — | — | **NOT AVAILABLE** |
| **Unusual *options* volume** | option volume vs avg | none | **No** | No | — | — | **NOT AVAILABLE** |
| **Underlying equity price/volume** | exchange feed | none | **No** | No | — | — | **NOT AVAILABLE** |

## E. Features that CAN be implemented (from real PVE data)

Unusual prediction‑market flow; contract‑volume anomaly; outcome (YES/NO) pressure [proxy];
order‑book depth imbalance [proxy]; probability momentum [relabelled]; smart‑money [guarded];
flow acceleration [derive]; sentiment/regime context [derive]; cross‑signal confirmation;
coverage/data‑quality scoring; dedup/cooldown; forward‑outcome backtest (win rate, avg/median return,
MFE, MAE, drawdown‑on‑hypothetical‑hold, by score bucket, by component, by regime, false‑positive rate,
sample size); train/test split; walk‑forward; deterministic replay (if input snapshots are persisted);
server‑side US‑equity classification / crypto exclusion (heuristic).

## F. Features that CANNOT be implemented (no PVE data)

Real option chains, strikes, expirations, Greeks, IV / IV‑rank / IV‑surface, GEX / gamma‑flip /
max‑pain, real open interest, equity NBBO bid/ask, options sweeps/blocks, unusual *options* volume,
real put/call ratio, OPRA/OCC anything, and a true underlying‑equity price/volume feed. These will be
**explicitly marked unavailable** and never fabricated.

## G. Crypto‑related code that must be removed

After the demo removal you already approved, there is **no crypto‑specific code left** to delete (the
old demo generator that used BTC/ETH tickers is gone; the only `crypto` references are Node's built‑in
crypto module for auth). The real gap is the opposite: **there is currently no asset‑class filter**, so
crypto/politics/sports markets from PVE would flow straight through. The work is therefore **additive** —
a server‑side US‑equity classifier applied before the engine — not deletion.

Proposed classifier (server‑side, runs on normalized markets before anything downstream):
1. **Denylist** (hard exclude): crypto/politics/sports/weather terms and tickers — bitcoin, btc, eth,
   ethereum, solana, sol, xrp, doge, crypto, token, coin, election, president, senate, nfl, nba, ufc,
   weather, temperature, etc.
2. **Allowlist / positive signal:** a curated US‑equity universe (e.g., S&P 500 + major ETFs/megacaps)
   matched against the market's ticker/title, plus equity phrase patterns ("close above $", "shares",
   "stock", "$AAPL"‑style cashtags, Nasdaq/NYSE mentions).
3. **Exclude when uncertain** (your rule): if a market can't be confidently classified as US
   equity/equity‑event, drop it rather than guess.
4. Cascade the filtered set to `/flow/spikes` and `/flow/top-traders` (keep only rows whose slug is in
   the allowed set) and to deep `/prices`/`/orderbook` calls.
5. Make allow/deny lists configurable (env/file) and visible in the Data Monitor, with a `/api/_classify`
   debug view showing why each market was kept or dropped.

**Honest caveat:** prediction‑market metadata is not a clean asset‑class taxonomy, so this classifier is
**heuristic (reliability: MODERATE)**. It will err toward exclusion. If PVE's stock‑linked coverage is
thin, the scanner may legitimately show few or zero signals — which is the correct, honest outcome, not a
bug to paper over with demo data.

## H. Proposed upgraded signal architecture

```
PVE.trade
  → US‑EQUITY CLASSIFIER (allow/deny, exclude‑ambiguous)        ← NEW, server-side
  → normalize (existing ALIASES) + asset_type tag               ← extended
  → deterministic engine (UNCHANGED CORE)
       validate → extract → score → build   (+ flow‑acceleration, regime context)
  → scoring with tiers (configurable)
  → ranking
  → dashboard (Overview · Scanner · Detail · US Stock Signals · [Options: honest] ·
               History · Backtest · Replay · Feature Research · Data Monitor · System Health · Settings)
```

Preserve the existing engine; extend, don't rebuild. Every proxy stays labelled ("PCR‑analog",
"OI‑analog", "probability momentum — not share price").

## I. Proposed scoring methodology

Keep the validated formula: `score = |net| × coverage × 100`, `confidence = coverage × 100`.
Directional agreement drives `net`; conflicts reduce it; data quality/coverage scales it. Add **tier
labels** with a **configurable** cutoff:

`90–100 Exceptional · 80–89 Very Strong · 70–79 Strong · 60–69 Moderate · <60 Weak`.

No score is presented as a probability of profit unless the Backtest tab demonstrates that mapping on a
sufficient out‑of‑sample sample.

## J. Backtesting methodology

Outcomes captured **forward** from live prices after the signal timestamp — never backfilled. Metrics per
score bucket (70–79 / 80–89 / 90–100) **and** per component **and** per regime: win rate, average return,
median return, MFE, MAE, max drawdown (on a hypothetical hold of the contract), false‑positive rate,
sample size. Add **train/test split** (already present) and **walk‑forward** (present) with sample sizes
shown everywhere; suppress any predictiveness claim below a configurable minimum sample. For **replay**
(Section 12), persist the raw normalized input snapshot per signal so the engine can reproduce the exact
historical signal from only‑then‑available data (today history stores derived components, not the raw
inputs — this is the one addition replay requires).

## K. Exact files I intend to modify

| File | Change |
|---|---|
| `server.js` | Add US‑equity classifier + config (allow/deny, exclude‑ambiguous); apply to `/markets`; cascade to `/flow/spikes` + `/flow/top-traders` + deep calls; tag `asset_type`; add `/api/_classify` debug; keep proxy/cache/auth intact. |
| `public/engine.js` | Pass through `asset_type`; add `flowAcceleration` + `regimeContext` (PVE‑derived) features; add tier labels; capture input snapshot for replay; core scoring unchanged. |
| `public/app.js` | New tabs: **US Stock Signals**, **US Options** (honest‑labelled or removed — your call), **Replay**, **System Health**; show `asset_type`, source endpoint, tier, and proxy labels; keep the LIVE‑unavailable banner. |
| `public/index.html` | Nav + sections for the new tabs; ensure no crypto UI. |
| `test/engine.test.mjs` + new `test/classify.test.mjs` | Add: crypto exclusion, US‑equity inclusion, ambiguous exclusion, mixed‑response filtering (US stocks + options + crypto + other → only US equity passes), more leakage tests, replay determinism; keep the 26 existing tests green. |
| `.gitignore` | **ADD** (currently missing — `.env`, `node_modules/` are unprotected). Section 14 gap. |
| `README.md`, `SETUP.md`, `UPGRADE.md`, setup PDF | Update for US‑equity focus and finish removing demo‑mode wording. |

## Open items / decisions needed before I implement

1. **Options tab:** PVE has no option‑chain data. Do you want the "US Options Signals" tab **removed**,
   or **kept but explicitly labelled** "prediction‑market signals on stock‑related contracts — not
   option‑chain/Greeks/OI data"? (I will not present proxies as real options data.)
2. **Relabelling:** OK to label PVE `price`/`volume` as *prediction‑market contract* metrics (probability
   momentum / contract volume), not the underlying equity's share price/exchange volume?
3. **Classifier universe:** should I curate the US‑equity allowlist (e.g., S&P 500 + megacaps + major
   ETFs), or will you supply the ticker list? Confirm "exclude when uncertain" is the desired bias.
4. **Coverage reality:** the live key currently returns **403** (agent access disabled), so I cannot yet
   measure how many US‑stock‑linked markets PVE actually returns. Proceed to build the classifier + tabs
   regardless (accepting the scanner may show few/zero signals until PVE both authorizes the key *and*
   carries stock‑linked markets)?

On your answers I'll implement incrementally, keep the 26 tests green, add the new tests, and preserve
the systemd/Caddy/HTTPS deployment.
