# PVE Signal Engine

Real-time combined-signal scanner on the PVE.trade agent API. The server proxies PVE (keeps
`X-Agent-Key` server-side, fixes CORS, caches + rate-limits); the browser runs the scoring engine.

## Run
```bash
cp .env.example .env      # add your PVE_AGENT_KEY (optional — runs in DEMO mode without it)
npm install
npm start                 # http://localhost:4000
```
Password: set `DASHBOARD_PASSWORD` in `.env` (if unset, a random one is generated and printed at startup).

## Notes
- PVE.trade is a **prediction-markets** flow/intel API, not an equity option chain. Bullish = YES-side,
  Bearish = NO-side. "Outcome Pressure" ≈ PCR and "Liquidity/Depth" ≈ OI are honest analogs of real
  PVE fields — no option chain is invented.
- **Signal Score = |weighted signed contribution| × 100.** It bakes in data coverage (missing
  components lower it). It is a ranking/confidence score, **not** a probability of profit. Not advice.
- Field mapping lives in one place: the `ALIASES` block in `server.js`. If a value shows blank,
  open **API / Data Monitor**, read the raw JSON, and add the real field name there.
- Live outcomes (5m/15m/30m/1h, MFE/MAE) are measured from prices captured *after* each signal fires —
  no future data at signal time.

---

## v2 — Deterministic engine + tests (engineering upgrade)

The scoring, labelling and research math now lives in **`public/engine.js`** — one pure,
`@ts-check`‑typed module imported by *both* the browser and Node, so what ships is what's tested.

- **Run the tests:** `npm test`  (Node's built‑in runner, 26 cases, zero deps)
- **Typecheck (optional):** `npm run typecheck`  (needs `tsc`)
- **Read the engineering docs:** [`AUDIT.md`](AUDIT.md) (what was wrong) · [`UPGRADE.md`](UPGRADE.md) (what changed)

What's new in the app: a **Feature Research** tab (per‑feature & combination forward
performance), a Backtest **in‑sample / out‑of‑sample / walk‑forward** toggle, a **data‑quality**
gate + badges, cooldown/flip dedup, and a detail view that shows each feature's normalized value,
weight and contribution. The Signal Score is `|net tilt| × coverage` — a ranking/confidence
number, **not** a probability of profit.

---

## US-Equity Upgrade (v2.1)

This build turns the engine into an **honest, deterministic US-stock prediction-market** intelligence
tool. It does **not** invent options data. See `UPGRADE.md` for the full implementation report and the
exact GitHub-repo mapping.

**What's new**
- **Server-side US-equity classifier** (`classify.js`): only S&P 500 / major US equities / major ETFs
  and obvious US-stock event contracts pass. Crypto, politics, sports, weather, etc. are hard-excluded;
  anything ambiguous is **rejected**. Debug decisions at `GET /api/_classify`.
- **Prediction-Market Flow Anomaly** (adapted from unusual-options-scanner methodology): rolling-median
  baseline, volume/flow anomaly score, spike magnitude, acceleration, persistence, multi-snapshot
  confirmation. Feeds ranking + display (scoring weights unchanged).
- **Modular feature registry** (`FEATURE_DEFS`, signal_engine_v1 pattern): every feature carries
  name/value/direction/weight/confidence/source/**proxy flag**/explanation.
- **Backtesting** (KPH3802 / vectorbt methodology, no deps): score buckets (70-79/80-89/90-100),
  win rate, avg/median return, MFE/MAE, hypothetical-hold drawdown, false-positive rate, and grouped
  performance by direction and market regime. A score is **never** a probability of profit.
- **Deterministic replay**: every signal persists its raw normalized snapshot + features + score + tier
  + versions; the **Replay** tab reproduces the identical signal without calling PVE.
- **New tabs**: US Stock Signals, US Options / Prediction-Market Signals (permanent "NOT real options
  data" warning), Replay, System Health.
- **LIVE only**: no demo/synthetic data. On 403 / no markets / no key, the UI shows the precise upstream
  error ("Insufficient live PVE data"), never a fabricated signal.

**Signal tiers** (ranking, not win probabilities): 90-100 Exceptional, 80-89 Very Strong, 70-79 Strong,
60-69 Moderate, <60 Weak.

## Phase 3 (offline validation) + Phase 4 (validated score)

Offline research pipeline lives in `research/` and is **never imported by the server**:
- `research/capture-signals.js` — cron this on the VPS to accumulate signal-time feature vectors (feeds the dataset).
- `research/run-phase3.js` — builds the dataset, runs walk-forward validation (purge+embargo), score buckets, benchmarks, feature importance, and writes `research-data/reports/PHASE3_REPORT.md`. It regenerates `validated/promotion.json` **from evidence** (empty until real out-of-sample data exists). `--synthetic N` proves the pipeline without touching production config.

Phase 4 validated score (`validated/model.js`, pure, deterministic) runs **alongside** the current score via `GET /api/validated/:ticker` and `GET /api/validated/ranking`. With no promoted features it mirrors the current score (delta 0); the current score always remains production. Calibrated probability is shown only if `promotion.json` marks calibration validated.

VPS capture (cron 3×/day):
```
cd /opt/pve-signal-engine
OPTIONS_API_KEY=pve_live_… RESEARCH_SIGNAL_DIR=./research-data/signals \
RESEARCH_TICKERS=AAPL,MSFT,NVDA,AMZN,GOOGL,META,SPY,QQQ node research/capture-signals.js
```
Then, after data accumulates: `node research/run-phase3.js` and review the report before changing `promotion.json`.
