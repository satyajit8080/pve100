# Signal Journal (`signal_log`) — design & operations

Event/outcome research dataset that logs **every production signal fired**, then fills **forward returns** so we can measure **which signal components actually predict**. It is strictly additive: it reads the already-built production signal and never changes it.

## Layering
- **Writer:** `store/signal-log.js` — server-side, fire-and-forget, imported by `server.js` (hooked in `buildTickerSignal`). Not in `public/`. Not in `research/` (keeps the server→research boundary intact; enforced by `test/no-research-import.test.mjs`).
- **Resolver:** `research/resolve-forward-returns.js` — offline; fills 1d/1w via `OPTIONS_PROVIDER` daily bars.
- **Report:** `research/signal-log-report.js` — offline attribution; no API/UI yet (by design).
- **Store:** JSONL at `research-data/signal-log/signal-log-YYYY-MM-DD.jsonl` (override with `SIGNAL_LOG_DIR`).

## Capture policy (deterministic)
One record **per ticker per 5-minute bucket**, and **only when `dir != neutral`**. No score floor — the journal represents the current engine honestly, not selectively. Deduped in-memory (safe across repeated dashboard/scan requests); the deterministic `id` (`TICKER:bucketISO`) lets the resolver/report dedupe across restarts.

## Source distinction (three separate buckets — never merged)
- **`scored` (A)** — values the production score **actually used**: chain-computed `gexChainComputed`, `atmIV`, `cpVolRatio`/`cpOIRatio`/`volOIRatio`, `strikeConcentration`, `avgSpread`, `oiChangeAvailable` (cold-start flag), and the full `components[]` with `scored:true` + `activeComponents`.
- **`displayedNotScored` (B)** — computed/overridden for display but **not** in the score: `gexPveOverride` (+`gexSource`), `gammaFlip`, `callWall`/`putWall`, `ivRank`/`ivPercentile`, `maxPain`, `price`/`prevClose`.
- **`shadowOnly` (C)** — **experimental**, never used in scoring: the shadow engine's sweep/flow classification (`quality`, `direction`, `netSignedPremium`, `goldenCount`, `sweepSampleSize`). Present so we can later test whether sweep info adds predictive value.

`composite` holds the outputs (finalScore/dir/tier/primary/optionsScore/stockScore/dataQuality); `pve` holds the prediction-market factor (currently inert).

## Forward returns
- **1h → `unavailable`** — `OPTIONS_PROVIDER` has no intraday historical data (documented, not faked).
- **1d** → next trading day's daily close vs `entryPrice`.
- **1w** → 5th trading day's close vs `entryPrice`.
- **Leakage prevention:** the resolver only uses daily bars with date **strictly after** the fire date — the fire-day bar and earlier bars are excluded by construction (`tradingBarsAfter`). Verified in `test/signal-log-pipeline.test.mjs`.
- **Basis note:** 1d/1w returns compare a daily close to the underlying price at fire time — a small intraday-vs-close basis, stated rather than hidden.

## Current-engine findings this journal is measuring (do NOT "fix" — reqs 8, 9)
- Production `largePremium` is **unavailable** because flow is not passed into `buildOptionsSignal` → **sweeps do not affect the production score** today.
- The prediction-market factor is **≈ 1.0** because the prediction-market feed is unavailable.
- **Scored GEX is chain-computed**, while the PVE GEX override happens **after** scoring (display-only).
- `oiChange` and momentum have **cold-start** behavior when no prior snapshot exists.

The journal exists to evaluate these later — it changes none of them.

## Operations
```bash
# resolver (fills 1d/1w; run after US close so the daily bar exists). Needs OPTIONS_API_KEY.
OPTIONS_API_KEY=pve_live_… SIGNAL_LOG_DIR=/opt/pve-signal-engine/research-data/signal-log \
  node research/resolve-forward-returns.js
# attribution report (offline; writes research-data/reports/SIGNAL_LOG_REPORT.md)
node research/signal-log-report.js
```
Systemd: `deploy/pve-resolve.{service,timer}` runs the resolver daily after the close.

## Retail technicals (Phase 1 — OBSERVE ONLY)
The resolver also stamps a **`technicals`** bucket onto each record (module: `research/technicals.js`), computed from the same PVE daily bars: RSI(14), MACD(12/26/9), SMA/EMA(20/50/200), Bollinger %B, ATR(14), plus derived `signals` (rsiZone, macdCross, priceVsSma50, smaTrend, bbZone).
- **Point-in-time / no look-ahead:** uses only daily bars **strictly before** the fire date (closed sessions), so an intraday signal never sees its own fire-day close. Null-safe: insufficient history → `available:false`, nothing fabricated. `source: 'pve-daily'`.
- **NOT used in production scoring.** This is purely to let the attribution report measure whether any indicator predicts. It is a fourth, clearly-labelled bucket alongside A/B/C — not merged into the score, and the frozen baseline is unaffected.
- **Promotion is a separate, evidence-gated step (Phase 2):** only if the report shows an indicator predicts would it be promoted — via the existing `validated/` model, as a bounded confirmation factor (e.g. ±5%) that gates conviction and never reverses direction. No Alpaca is required for Phase 1; intraday technicals (VWAP etc.) from Alpaca would be a later addition once daily technicals show promise.

The attribution report (`research/signal-log-report.js`) includes a "Retail technicals — OBSERVE-ONLY" section grouping hit-rate/return by whether each indicator agrees with the trade direction, sample-size gated.

## Safety guarantees (reqs 6, 10)
- Production signal is frozen by `test/baseline-engine.test.mjs` (BEFORE == AFTER).
- Logging is fire-and-forget and fully wrapped: if the store is unavailable or the shadow-flow fetch fails, the request still succeeds and the field is written honestly as `null` / a status flag.
