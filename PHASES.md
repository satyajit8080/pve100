# Redesign implementation status

Production scoring remains **opt-1.1.0** (frozen). The v2 path runs in **shadow** and is
compared against v1 on the same observations. Per §3/§28, v2 only gets promoted when our
own out-of-sample data says it is better — not because the research says it should be.

| Phase | Spec | Status | Where |
|---|---|---|---|
| 1 Measurement | §2,3,21,22 | done | `store/journal.js`, `store/journal-store.js`, `store/evaluation.js`, `research/resolve-outcomes.js` |
| 2 Core signal | §4,5,6 | done | `store/normalize.js`, `engine/features.js` (`signedFlow`, `flowAcceleration`) |
| 3 Regime | §7,8 | done | `engine/features.js` (`gammaRegime`, 0.25-ATR dead-band) |
| 4 Confirmation | §9–14 | done | `engine/features.js` (price/VWAP, RVOL, market, IV-skew change, event gates) |
| 5 Stability | §18,19 | done | `engine/state.js` (7 states, N-confirm, flip margin, cooldown, EWMA) |
| 6 Infrastructure | §26,27 | partial | `engine/quality.js` done; WebSocket **not** done (needs UW Advanced tier) |
| 4b Context inputs | §10,11,12,13,14,23 | done | `engine/context.js` — RVOL, SPY/QQQ regime, IV-skew change, earnings, OPEX, cross-sectional rank |
| 7 ML | §24 | intentionally not built | requires stable out-of-sample v2 baseline first |

## Score composition (v2, spec §16/§17)
FLOW .45 · PRICE .20 · GAMMA .15 · MARKET .10 · CONTEXT .10 over **available** components,
then regime/RVOL/market/event multipliers, **capped to [0.6, 1.25]** so confirmations can
never overpower primary flow evidence. Coverage penalty applies when evidence is thin.

## Integrity guarantees (test-enforced)
- Original signal records are immutable; outcomes are append-only patches merged at read time.
- Rolling baselines are strictly backward-looking (a later observation cannot alter an earlier z-score).
- `pendingOutcomes` refuses to resolve a checkpoint before its wall-clock time has passed.
- Missing data → `null` + a quality flag. Never 0.

## Not done, and why
- **WebSocket hot paths (§26)** — UW WebSocket requires the Advanced tier; REST is still used.
- **RVOL** now computes from real same-time-of-day volume baselines, but returns `null`
  until ~10 sessions of history exist for that ticker/time bucket. It builds itself as the
  engine runs; it is never faked to 1.0 in the meantime.
- **Sector relative strength** — SPY/QQQ market regime is wired; per-sector ETF tide is NOT.
  UW `/sector-tide` exists but sector→ETF mapping for the universe isn't built, so
  `sectorTrend` stays null rather than guessed.
- **FOMC/CPI flags** — need an external macro calendar; only OPEX (third Friday) is inferred.
- **Gradient boosting (§24)** — explicitly deferred until v2 shows stable out-of-sample IC.

## Promotion criteria (§3, §28)
A v2 promotion requires, on our own data: rank IC ≥ ~0.02 stable out-of-sample, top-decile
precision above base rate, and stability across regimes — measured in Signal Journal →
Baseline Evaluation (`v2 IC` column, `By v2 state` breakdown).


---

## UW-ONLY COMPLIANCE (completed)

| Requirement | Status |
|---|---|
| §1 Manual scanning only | **done** — systemd timers deleted; Run Scan / Resolve Outcomes are the only triggers |
| §2 Verify every UW endpoint | **done** — no invented endpoints; unavailable ones return `UW_ENDPOINT_UNAVAILABLE` |
| §3 RVOL readiness | **done** — READY / WARMING_UP / UNAVAILABLE with observation counts |
| §4 IV-skew readiness | **done** — WARMING_UP until a second snapshot exists |
| §5 Sector relative strength | **done** — from UW `/market/sector-tide` + per-ticker sector; UNAVAILABLE otherwise |
| §6 Macro events | **UNAVAILABLE** — UW exposes no FOMC/CPI calendar and no external provider is permitted |
| §7 Rate-limit management | **done** — counting, scan budget, UW header tracking, backoff, dedupe, failure log, prioritization |
| §8 WebSocket | **not applicable** — not in the current subscription; REST retained, nothing faked |
| §9 Journal immutability | **done** (test-enforced, byte-identical signal files) |
| §10 Outcome resolution | **done** — UW-only prices, append-only, no look-ahead |
| §11 V1 vs V2 evaluation | **done** — same snapshot, `v2RankIC` / `v2TopDecile` / `byV2State` |
| §12 Promotion gate | **done** — 8 checks; never auto-promotes |
| §13 Data-readiness UI | **done** — Signal Journal → Research Status |
| §14 Data-quality states | **done** — VALID/STALE/MISSING/INVALID/UNAVAILABLE |
| §15 Key security | **done in code** — masked everywhere (`********1234`); **rotation is still your action** |
| §16 No ML | **respected** |
| §17 Testing | **281 passing** (was 264) |

### Removed (§18)
- `providers/pve.js` — deleted
- PVE Trade agent API (`/api/me`, `/api/markets`, `/api/flow`, …) — routes removed, `BASE_URL: null`
- PVE Data Explorer UI tabs (PVE Smart Data / Flow & Spikes / Raw Markets) — removed
- `deploy/*.timer` and `deploy/*.service` — deleted so no scheduler can ship

### Bug found while doing this
UW `getScreener` emitted `net_premium` but the cross-section consumer read `netPremium`, so every
sector direction resolved to `neutral` on UW. Fixed with a camelCase alias.


---

## Final pass — gaps closed

**Run Scan now completes the research loop (§1).** It previously computed only v1 and wrote
nothing to the journal, so pressing the button never produced research data. It now:
1. fetches the UW snapshot, 2. computes **v1**, 3. computes **v2** from the same snapshot,
4. records per-ticker flow baselines, 5. **persists to the Signal Journal** (>=70 gate,
5-minute dedupe), 6. ranks the universe cross-sectionally.

**Two real defects found by writing the tests:**
- A rate-limited or failed UW request produced a **score of 0**, which §14 forbids. `/api/options`
  now returns `{ ok:false, status:'UNAVAILABLE', reason:'UW_REQUEST_FAILED' }` instead of scoring
  absent data.
- On HTTP 429 with `remaining=0` the client retried three times per call, so a throttled
  100-ticker scan would stall for minutes. It now **fails fast** when UW says the quota is gone
  and reports a partial scan.

**§17 test coverage added** (`test/ops-manual.test.mjs`): manual Run Scan, manual Resolve
Outcomes, UW network/429/5xx failures, duplicate-scan refusal, token non-leakage across four
endpoints, V1-vs-V2 side-by-side metrics, readiness states, and outcome immutability with
duplicate patches.
