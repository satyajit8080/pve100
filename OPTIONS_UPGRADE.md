# Real US Options + Stock Upgrade — implementation report

Architecture pivot: **REAL options + stock = PRIMARY signal; PVE prediction-market = SECONDARY
confirmation.** Deterministic throughout. Nothing fabricates OI, Greeks, IV, GEX, PCR, option volume,
sweeps, blocks, NBBO, or chain data.

> **Environment honesty:** this build environment has **no network egress to any options vendor and no
> API key** (egress is restricted to GitHub/npm/PyPI). So live options fetches could not be exercised
> here, and no live field was received in this environment. The deterministic engine and the vendor
> **normalizers** are covered by automated tests using vendor-shaped fixtures; the HTTP adapter runs on
> your deployment once `OPTIONS_API_KEY` + egress exist. The end-to-end server path was verified with a
> stubbed provider (Polygon-shaped fixture): real chain → optionsScore 76, C/P 3.75, GEX positive, max
> pain 100, dataQuality AVAILABLE — and `sweeps` correctly reported UNAVAILABLE (not invented).

## Final output (16 points)

**1) Options provider selected/configured** — Vendor-agnostic `OptionsDataProvider` with a concrete
**Polygon.io** adapter (`providers/options.js`) + `NullOptionsProvider` fallback. Selected via env
`OPTIONS_PROVIDER` (`polygon` | `null`) + `OPTIONS_API_KEY` (+ optional `OPTIONS_BASE_URL`). Not
hard-coded — add adapters (Tradier, ORATS, etc.) by implementing `getChain`/`getUnderlying`.

**2) Endpoints used** (Polygon adapter)
- Option chain snapshot: `GET /v3/snapshot/options/{underlyingAsset}` (params `limit`, `expiration_date`, `contract_type`).
- Underlying snapshot: `GET /v2/snapshot/locale/us/markets/stocks/tickers/{ticker}`.
- API key passed as `?apiKey=` (server-side only; never sent to the browser).

**3) Fields successfully received** — **None in THIS environment** (no egress/key). The normalizers map
these real fields when present: per contract `details.strike_price`, `details.expiration_date`,
`details.contract_type`, `day.volume`, `open_interest`, `implied_volatility`, `greeks.{delta,gamma,theta,vega}`,
`last_quote.{bid,ask,midpoint}`, `last_trade.price`, and `underlying_asset.price`; underlying
`lastTrade.p` / `day.c` / `day.v` / `prevDay.c`. Each is flagged AVAILABLE/UNAVAILABLE from actual
presence — verified against Polygon-shaped fixtures in `test/options-provider.test.mjs`.

**4) Options features implemented** (`options-engine.js`, all from real chain; each has value/direction/
weight/confidence/source/availability/explanation)
- Call/Put volume pressure (directional), Volume/OI anomaly, OI change (from captured snapshots),
  IV behavior (level + change from snapshots), Gamma/GEX context (computed gamma×OI), Large-premium
  activity (if the vendor supplies flow), Strike concentration (HHI), Liquidity quality (spread + OI).
- Computed analytics from the real chain: **GEX**, **gamma flip**, **max pain**, per-strike gamma,
  call/put OI & volume, C/P ratios, ATM IV, **unusual** (volume > 1.5× OI).
- **Unavailable on Polygon (not fabricated):** classified **sweeps/blocks**; **historical** IV-rank /
  OI-change from a single call (derived from our snapshots instead).

**5) PVE features implemented (SECONDARY)** — unchanged prediction-market engine: prediction-market
flow anomaly, contract-volume anomaly, probability momentum, order-book imbalance, flow acceleration,
sentiment/regime. Surfaced as `predictionMarketConfirmation` and matched to the options ticker in the UI.

**6) Final scoring formula** —
`primary = (wOptions·optionsScore + wStock·stockScore) / (wOptions+wStock)` (defaults 0.60 / 0.25),
direction from options (fallback stock). PVE applies a **confirmation factor**: agree →
`1 + 0.12·(pve/100)`, disagree → `1 − 0.15·(pve/100)`, clamped to **[0.80, 1.15]** so PVE can never
dominate or reverse direction. `finalScore = round(primary · dataQualityFactor · pveFactor)`, clamped
0–100, mapped to tiers (90 Exceptional / 80 Very Strong / 70 Strong / 60 Moderate / <60 Weak). All
weights configurable (`DEFAULT_OPTIONS_WEIGHTS`, `DEFAULT_COMBINE`). Never called a probability of profit.

**7) GitHub code/algorithms actually adapted**
- **unusual-options-scanner** — anomaly-vs-baseline methodology → now applied to **real** option
  volume/OI (`volume > 1.5×OI` unusual; volume/OI anomaly) in `options-engine.js`. *(Adapted.)*
- **gammagrid** — now **INTEGRATED (conditionally on real chain data)**: GEX (gamma×OI×spot²×0.01, puts
  negative), gamma-flip (cumulative-GEX zero cross), max-pain (OI-weighted min payout), strike
  concentration. Computed from the real chain, exactly gammagrid's domain. *(Was "NOT INTEGRATED" when
  only PVE existed; real options data makes it integrable.)*
- **signal_engine_v1** — modular feature registry (`OPTIONS_FEATURE_DEFS`, per-feature metadata). *(Adapted pattern.)*
- **KPH3802/options-backtest-engine** & **vectorbt** — forward-outcome metric methodology (win/median,
  MFE/MAE, drawdown, buckets, FPR) → the backtest schema below; **no code copied, no dependency, no Python.**

**8) Files changed / added**
- `options-engine.js` *(new)* — primary options+stock engine (features, scores, combine, replay).
- `providers/options.js` *(new)* — provider abstraction + Polygon adapter + Null provider + normalizers.
- `server.js` — `GET /api/options/:ticker` (server-side fetch via provider, key server-side, per-ticker snapshot cache), provider status + versions on `/api/_monitor`.
- `public/app.js` — Options tab rewritten to real analytics + PVE confirmation via `combineScores`.
- `public/index.html` — Options tab markup (ticker input, source/status, summary, features, chain).
- `.env.example` — `OPTIONS_PROVIDER` / `OPTIONS_API_KEY` / `OPTIONS_BASE_URL`.
- `test/options-engine.test.mjs` *(new, 13)*, `test/options-provider.test.mjs` *(new, 6)*.
- (Prior US-equity upgrade files unchanged and still green.)

**9) Dependencies added** — **none.** Node's built-in `fetch`; Express only. No Python, no vectorbt.

**10) Test count / results** — **68 passed / 0 failed** (`node --test`): 26 engine + 14 classifier +
9 upgrade + **13 options-engine** + **6 options-provider**. Covers aggregation (C/P, GEX sign, max pain,
unusual), features, options-primary scoring, PVE-secondary combine (never reverses; bounded factor),
data-quality tiers, availability/no-fabrication, provider normalization + missing-field handling, and
options replay determinism.

**11) Backtest methodology** — store per signal: timestamp, underlying price, selected contract
(strike/expiration), option price/bid/ask, IV, Greeks, volume, OI, options flow, PVE state, finalScore,
and every component score (snapshot persisted by `captureOptionsSnapshot`). Evaluate forward-only
(no look-ahead): underlying return, option return, win rate, avg/median return, MFE, MAE, drawdown, max
loss, profit factor, sample size — reusing the existing bucket/group performance functions. Suppress
predictive claims below the configured minimum sample.

**12) Data unavailable / missing** — from Polygon: classified sweeps/blocks; single-call historical
IV-rank & OI-change (derived from our snapshots). Generally: any vendor-omitted field (e.g. quotes or
greeks on a lower plan) is marked UNAVAILABLE and lowers data-quality — never invented. If the real
chain is absent, the Options tab shows **“Insufficient options data”** and emits no options signal;
PVE-only signals appear separately under **US Stock Signals** (never mixed into the options ranking).

**13) API keys / environment variables required**
```
PVE_AGENT_KEY=...        # PVE prediction-market (secondary); server-side only
DASHBOARD_PASSWORD=...    # login
OPTIONS_PROVIDER=polygon  # or null
OPTIONS_API_KEY=...       # options+stock vendor key (server-side only)
# OPTIONS_BASE_URL=https://api.polygon.io
PORT=3000
```

## How to verify on your deployment
1. Set `OPTIONS_PROVIDER=polygon` + `OPTIONS_API_KEY` (and `PVE_AGENT_KEY` for confirmation), restart.
2. **API/Data Monitor** → confirm `optionsProvider.configured = true` and versions.
3. **US Options** tab → enter a ticker → real underlying, chain, Greeks/IV/OI, computed GEX/gamma-flip/
   max-pain, per-field availability, source = polygon, and PVE confirmation (agree/disagree) if a
   matching PVE market exists. Second load populates `stockScore` (needs one prior snapshot for momentum).
4. `GET /api/options/{TICKER}` returns the full signal JSON for scripting/backtests.

## Discipline
No LLM in any decision path. Options/stock dominate; PVE only adjusts confidence and never reverses
direction. Multi-ticker "70+ scanner" iterates this same route over a configurable watchlist once a
provider is set (not run here — no vendor egress/key in this environment).
