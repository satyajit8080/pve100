# PVE Signal Engine — Setup Guide

A real-time signal scanner built on the **PVE.trade agent API** (a prediction-markets flow/intel
API). A small Node server proxies PVE (keeping your API key private) and serves a browser
dashboard that runs a deterministic, tested scoring engine.

Works with **zero setup in DEMO mode** (synthetic data, clearly labelled) so you can click around
before adding a real key.

---

## 1. Prerequisites

- **Node.js 18 or newer** (Node 20/22 recommended). Check with:
  ```bash
  node -v
  ```
  If you don't have it: https://nodejs.org (download the LTS installer).
- That's it. The only runtime dependency is Express; the test suite uses Node's built-in runner.

## 2. Quick start (DEMO mode — no key needed)

From inside the project folder:

```bash
cp .env.example .env      # macOS/Linux
#   copy .env.example .env   (Windows PowerShell/CMD)

npm install               # installs express (one dependency)
npm start                 # starts the server
```

Then open **http://localhost:4000** and log in with the `DASHBOARD_PASSWORD` from your `.env`
(if unset, a random password is printed in the server log at startup).

You'll see a "DEMO DATA" banner. The scanner drifts every scan; wait a few cycles and 70%+
signals will appear in the Fast Signal Scanner.

## 3. Run the tests (optional, no install required)

```bash
npm test
```

Expected: **26 passing** (`node --test`). These cover scoring, feature extraction, the
data-leakage guard, validation, dedup/cooldown, outcome/MFE-MAE, and the research aggregations.

Optional type-check (needs TypeScript's `tsc` installed globally): `npm run typecheck`.

## 4. Go LIVE (use your real PVE.trade data)

1. Get an **agent key** from PVE.trade — it looks like `pve_agent_...`.
2. Open `.env` in a text editor and set:
   ```
   PVE_AGENT_KEY=pve_agent_your_key_here
   ```
3. (Recommended) change the dashboard password:
   ```
   DASHBOARD_PASSWORD=your_own_password
   ```
4. Restart the server (`Ctrl+C`, then `npm start`). The banner switches from DEMO to LIVE, or use
   the **LIVE/DEMO** toggle in the top bar. The key stays on the server and is never sent to the browser.

## 5. `.env` reference

| Variable | Default | Meaning |
|---|---|---|
| `PVE_AGENT_KEY` | *(empty)* | Your `pve_agent_...` key. Empty ⇒ DEMO mode. |
| `PVE_BASE_URL` | `https://api.pve.trade/api/agent` | PVE API base; change only if told to. |
| `DASHBOARD_PASSWORD` | *(required — random per run if unset)* | Login password for the dashboard. |
| `PORT` | `4000` | Port the server listens on. |
| `CACHE_TTL_MS` | `4000` | How long upstream responses are cached. |
| `MIN_UPSTREAM_INTERVAL_MS` | `1200` | Minimum gap between identical upstream calls (rate-limit guard). |

## 6. First-run walkthrough

- **Dashboard** — live signal count, net flow, data-quality summary, top signals, top traders.
- **Fast Signal Scanner** — ranked signals; filter by score/side/volume. Each row shows direction,
  confidence, a data-quality badge, and the Signal Score. Click any row for the full breakdown.
- **Signal detail** (click a row) — every feature's normalized value, weight and contribution, plus
  net tilt, coverage, data-quality reasons, and snapshot age.
- **Markets / Flow** — raw market table and flow/spikes/hourly activity.
- **Signal History** — every signal is logged locally with forward outcomes (5m/15m/30m/1h) as time passes.
- **Backtest** — performance by score bucket with sample sizes, an **all / in-sample / out-of-sample**
  toggle, and a walk-forward table.
- **Feature Research** — which features and combinations actually precede favourable moves, vs baseline.
- **API / Data Monitor** — every upstream call, latency, and the raw vs normalized JSON.
- **Settings** — live-edit the engine weights and parameters.

## 7. If a value shows blank against a LIVE key

PVE may name a field differently than assumed. This is self-service to fix:

1. Open **API / Data Monitor**, pick the endpoint, and read the **raw** JSON.
2. Find the real field name.
3. Open `server.js`, find the **`ALIASES`** block near the top (the single field-mapping edit point),
   and add the real name to the relevant list.
4. Restart. No other code changes needed.

## 8. Project structure

```
pve-signal-engine/
├── server.js            Express proxy: key handling, cache, rate-limit, normalization, auth, monitor
├── public/
│   ├── index.html       Dashboard shell + styles
│   ├── app.js           Client: polling, rendering, state (thin shell)
│   └── engine.js        Deterministic signal engine — single source of truth (browser + tests)
├── test/
│   └── engine.test.mjs  26 tests (node --test)
├── package.json         scripts: start · test · typecheck
├── .env.example         copy to .env
├── README.md            short overview
├── AUDIT.md             technical audit of the codebase
└── UPGRADE.md           engineering-upgrade deliverable (what changed, methodology, limitations)
```

## 9. How the score works (short version)

`Signal Score = |net directional tilt| × data coverage × 100`.

- **net** — weighted agreement of the *directional* features (flow, outcome pressure, orderbook
  imbalance, price momentum, smart money), in −1…+1.
- **coverage** — share of total weight that actually had data (including *confirmation* features
  like volume, which raise confidence but never set direction).
- **confidence** — coverage as 0–100, shown alongside the score.

It is a **ranking / confidence** number, **not** a probability of profit — see the Backtest tab
for what a score has actually meant historically on your data.

## 10. Troubleshooting

- **`command not found: node`** → install Node.js (step 1).
- **Port 4000 in use** → set `PORT=4001` in `.env` (or stop the other process) and restart.
- **Login fails** → the password is `DASHBOARD_PASSWORD` in `.env` (if unset, a random one is printed in the server log at startup); it's
  case-sensitive.
- **LIVE shows errors / empty** → confirm `PVE_AGENT_KEY` is set and valid; check **API / Data
  Monitor** for the exact status. Fields blank but calls succeed ⇒ see §7.
- **Blank page / import error** → the app uses ES modules; serve it via `npm start` (opening
  `index.html` directly with `file://` won't work).

## 11. Disclaimer

This is an analysis/visualization tool, not financial advice. "Signal Score" is a ranking, not a
probability of profit. Prediction-market trading carries risk; do your own research.

---

## US-Equity upgrade config (v2.1)

**Classifier universe (optional env, all merged with the built-in lists):**
```
US_EQUITY_TICKERS=TSLA,AAPL,NVDA        # extra equity tickers to allow
US_EQUITY_ETFS=SPY,QQQ,IWM              # extra ETFs to allow
EXTRA_DENY_TICKERS=FART,MEME            # extra tickers to hard-exclude
```
No env is required - sensible defaults ship in `classify.js`.

**Debugging classifier decisions:** `GET /api/_classify` (authenticated) returns, for the last
`/markets` fetch: `classifierVersion`, `engineVersion`, accept/reject `stats`, per-market `decisions`
(`{slug,title,asset_type,classification,reason,confidence}`), and the `rejected` list with reasons.

**LIVE only:** there is no demo mode. If `PVE_AGENT_KEY` is missing or PVE returns 403, endpoints return
`{ ok:false, error }` and the UI shows the exact error - it will **not** fabricate markets or signals.
Check **System Health** for connection status, versions, and accepted/rejected market counts.
