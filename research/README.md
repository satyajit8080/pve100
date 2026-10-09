# Research harness (Phase 0) — OFFLINE, advisory, decoupled

This folder is a **research-only** toolkit. It is **not imported by the server**, is **not part of the
zero-dependency runtime**, and it **never computes or influences** `finalScore` / `dir` / `tier` /
`classification` / backtest / replay. Its only job is to make future validation possible by (a)
capturing the PVE series that are **live-only** and (b) turning emitted signals into labeled outcomes.

Everything here uses **PVE v1 only** (no Polygon or other vendor) and Node built-ins (`fetch`, `fs`) —
no new npm packages.

## What Phase 0 adds

- **Read-only PVE adapters** on `PveOptionsProvider` (`providers/pve.js`): `getByStrikeGex`,
  `getSkew`, `getTermStructure`, `getOhlc`, `getDarkpool`, `getMarketTide`. Pure, defensive
  normalizers; a field PVE omits stays `null` (never fabricated).
- **`snapshot-store.js`** — builds a flat, whitelisted **scalar** record (see `SNAPSHOT_FIELDS`) from
  those adapters and appends it as JSONL under a dated file. Captures the live-only series
  (`/gex` summary, IV-rank, 25Δ skew, term slope, market tide, DIX) plus derived
  flip/wall distances and near-spot GEX concentration. **No keys or secrets are ever written.**
- **`signals-store.js`** — persists, at signal-emission time, the feature vector + deterministic
  `score/dir/tier`, then backfills an outcome **label** later.
- **`labeler.js`** — pure **MFE/MAE + direction** labeler from daily OHLC. Dual labeling separates
  "right direction" from "tradable." **No look-ahead**: the forward window is strictly *after* the
  entry bar (entry taken at its close).
- **`capture-snapshot.js`** — a standalone CLI that wires the real provider to the snapshot store.

## Why snapshots are required

PVE serves `/gex` summary and point-in-time IV-rank **live only** (no history endpoint). To ever build
ΔGEX / GEX-regime history / calibration, we must capture our own timestamped rows now. (Flow is 90d,
IV/skew surface 3y, OHLC 2y — those can be re-fetched; the live-only series cannot.)

## Running capture on the VPS

```bash
cd /opt/pve-signal-engine   # live app dir (has the real .env with OPTIONS_API_KEY)
OPTIONS_API_KEY=pve_live_… \
RESEARCH_SNAPSHOT_DIR=./research-data/snapshots \
RESEARCH_TICKERS=AAPL,MSFT,NVDA,SPY,QQQ \
node research/capture-snapshot.js
# → writes research-data/snapshots/snapshots-YYYY-MM-DD.jsonl
```

Schedule a few captures per session (e.g. open / midday / close) with a **systemd timer** or cron:

```
# crontab -e  (times in the server's TZ; adjust to US market hours)
35 13 * * 1-5  cd /opt/pve-signal-engine && OPTIONS_API_KEY=… RESEARCH_SNAPSHOT_DIR=./research-data/snapshots RESEARCH_TICKERS=AAPL,MSFT,NVDA,SPY,QQQ /usr/bin/node research/capture-snapshot.js >> ./research-data/capture.log 2>&1
0  16 * * 1-5  cd /opt/pve-signal-engine && OPTIONS_API_KEY=… RESEARCH_SNAPSHOT_DIR=./research-data/snapshots RESEARCH_TICKERS=AAPL,MSFT,NVDA,SPY,QQQ /usr/bin/node research/capture-snapshot.js >> ./research-data/capture.log 2>&1
0  20 * * 1-5  cd /opt/pve-signal-engine && OPTIONS_API_KEY=… RESEARCH_SNAPSHOT_DIR=./research-data/snapshots RESEARCH_TICKERS=AAPL,MSFT,NVDA,SPY,QQQ /usr/bin/node research/capture-snapshot.js >> ./research-data/capture.log 2>&1
```

`research-data/` should be git-ignored. Respect PVE limits (100k req/day, 10 req/s per account) —
each ticker is ~8 calls per capture, so a 500-name universe ≈ 4k calls per capture (well within limits).

## Leakage guards (already enforced)

- Outcome labeling uses the signal's own date as entry (bar **close**); the forward window is strictly
  later, so the entry bar's high/low never counts.
- Snapshots are timestamped at capture; when you later join snapshot → outcome, use only snapshots
  **prior** to the label window.
- For any historical backtest, use **point-in-time** S&P 500 membership (avoid survivorship bias).

## What Phase 0 deliberately does NOT do

- It does **not** modify deterministic scoring or wire any of these features into the live signal.
- It does **not** add ML, Python, or any data vendor.
- Folding *validated* features into scoring is **Phase 3**, behind config, one at a time — only after
  walk-forward + control + bootstrap + calibration prove they help.
