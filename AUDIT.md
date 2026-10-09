# PVE Signal Engine — Technical Audit (Phase 1–2)

Written **before** the refactor, against the shipped Turn‑1 code. It records what the system
did, how each feature was computed, and every correctness risk found. The upgrade (see
`UPGRADE.md`) addresses these; nothing here is hypothetical — each finding maps to code.

Do **not** read a score of 70 as "70% probability". It never was one (see §7).

---

## 1. Architecture map

```
Browser (public/) ──HTTP──> Node/Express (server.js) ──HTTPS + X-Agent-Key──> api.pve.trade
   dashboard, scoring         proxy: cache · rate-limit · normalize · auth        prediction-markets API
```

- **server.js** — holds the agent key server-side (never shipped to the browser), adds a TTL
  cache + minimum-interval throttle + a call monitor, and *normalizes* each upstream shape
  through a single `ALIASES`/`N.*` layer. Also serves the static app and a cookie session.
- **public/app.js** — polled every `pollSec`, fetched `/flow`,`/flow/spikes`,`/flow/top-traders`,
  `/markets`, then deep‑fetched `/prices`+`/orderbook` for the top‑K markets, computed a
  per‑market signal, reconciled a live map, logged history to `localStorage`, evaluated forward
  outcomes, and rendered.
- **The signal engine lived entirely inside app.js.** This is finding §6a.

## 2. PVE endpoints used, and fields extracted

| Endpoint | Fields consumed | Used for |
|---|---|---|
| `/flow` | buyVol, sellVol, netFlow, sentiment, bullish, bearish, hourly | dashboard/flow KPIs |
| `/flow/spikes` | slug, tokenId, direction, magnitude, volume | **flow** feature |
| `/flow/top-traders` | name, volume, count, pnl, direction, slug | **smart‑money** feature, table |
| `/markets` | slug, title, tags, status, volume, liquidity, endDate, outcomes[{tokenId,price,volume}] | universe, **outcome/volume/liquidity** features |
| `/prices?token_id&interval` | series[{t,price}] | **price** feature, forward outcomes |
| `/orderbook?token_id` | bidDepth, askDepth, imbalance, mid | **liquidity** feature |

Unused despite being available: **WebSocket `/ws`** (streaming; would remove polling), the
**osint** channel, **`/me`**, `market/:slug` full detail, and `top-traders sortBy=count`.

## 3. Signal features — per‑feature audit (Phase 2)

| Feature | Raw input | Transform | Window | Independent? | Missing‑data | Outliers |
|---|---|---|---|---|---|---|
| Flow | spike magnitude+direction | `(mag−1.5)/3`, dir by YES/NO leg | snapshot | yes | self‑disables | clamped [0,1] |
| Outcome pressure | YES/NO volume | `(y−n)/(y+n)`, `/0.5` | snapshot | yes | self‑disables | clamped |
| Liquidity/depth | orderbook imbalance **or** liquidity | imbalance `/0.5`; else rel‑to‑median | snapshot | mostly | self‑disables | clamped |
| Volume | market volume | `rel = vol/median` | snapshot | **NO — see §6c** | self‑disables | clamped |
| Price | YES price series | `last − ref` over N points, `/0.06` | N points | yes | self‑disables | clamped |
| Smart money | top‑trader attribution | signed net, `count/3` | snapshot | yes | self‑disables | clamped |

Scoring (Turn‑1): `score = round(100·|Σ wᵢ·availᵢ·dirᵢ·strengthᵢ|)`; direction by sign vs an
epsilon band. Coverage was displayed but did **not** enter the score.

## 4. Timestamps & forward‑outcome calculation

- Signal time `T` = `Date.now()` at creation (client clock).
- Forward outcomes computed in a **separate** pass (`updateEvals`) that compares the *entry*
  price to the *current* live price once `now ≥ T + horizon`. MFE/MAE tracked as running
  extremes. This separation is good and is the seed of the leakage design in §7.

## 5. Concurrency / caching / performance

- **Race:** `scan()` guarded by a `scanning` flag → overlapping intervals return early. OK.
- **Caching:** server TTL cache + per‑endpoint minimum interval de‑duplicate upstream calls;
  deep calls limited to top‑K. Reasonable for continuous operation.
- **Polling only** — no WebSocket, so freshness is bounded by `pollSec` (Phase 12 opportunity).

## 6. Findings (defects & smells)

**a. Two sources of truth (highest priority).** All scoring math lived in `app.js`; the only
test re‑implemented the same formula separately. They could silently diverge, and the browser
math was untestable headlessly. → *Fixed:* extracted `public/engine.js`, imported by both the
browser and `node --test`.

**b. No shipped tests, no types.** Zero automated coverage; plain objects with no contracts.
→ *Fixed:* 26 `node --test` cases + JSDoc `@ts-check` typedefs.

**c. Volume was not independent evidence.** Volume borrowed the price feature's *direction*,
so a single price move counted twice (once as price, once as volume). → *Fixed:* volume is now
a **confirmation** feature (direction 0) — it raises coverage/confidence but never moves the
directional net. This is the one behavioural change to scoring, made for a clear reason.

**d. Coverage ignored in the score.** A lone strong feature and six aligned features could
produce similar headline numbers. → *Fixed:* `score = |net| × coverage × 100`, so breadth of
evidence now matters and sparse snapshots score low.

**e. No data‑quality gate.** Sparse/stale/impossible snapshots silently produced signals.
→ *Fixed:* `validateSnapshot` returns `ok|low|reject`; rejects never emit, lows are counted
and flagged in the UI.

**f. Minimal dedup, no cooldown.** Signals were keyed by slug+dir and refreshed in place, but
a market oscillating around neutral could churn bull↔bear history rows. → *Fixed:* pure
`emitDecision` with create/update/**flip‑with‑margin**/**cooldown**/suppress; original events
kept in history, updates don't create new rows.

**g. Leakage safe but not *enforced*.** The design didn't use future data, but nothing
prevented a future edit from passing a future price into a feature. → *Fixed:* features and
labels live in different functions with different inputs, plus a regression test that pollutes a
snapshot with `__future*` fields and asserts the feature vector is byte‑identical (§7).

**h. Per‑market freshness is scan‑level.** `/markets` is one fetch with one timestamp; there's
no per‑market snapshot time. Freshness uses the scan timestamp. Accepted limitation.

**i. Outcome eval can stall.** If a market drops out of the top‑50/top‑K, later‑horizon
outcomes stay pending because no fresh price arrives. Accepted; documented.

## 7. The "70% ≠ 70%" note

The score is a weighted, coverage‑scaled agreement measure across heterogeneous signals. There
is **no** historical mapping from score to win probability unless the buckets in the Backtest
tab demonstrate one on a real, sufficiently large out‑of‑sample set. The UI states this and the
backtest deliberately reports **descriptive** bucket performance with sample sizes, not a
calibrated probability.
