# Code Audit — 2026-10-09

## Fixed in this branch
| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | Critical | Hard-coded default dashboard password in `server.js` (also in README/SETUP/DEPLOY). The session HMAC secret derives from it, so anyone reading the repo could log in **and** forge session cookies on any deploy without `DASHBOARD_PASSWORD`. | No fallback; random per-process password printed at startup. Docs updated. |
| 2 | High | No brute-force protection on `POST /auth/login`. | 10 failed attempts / IP / 15 min → 429. |
| 3 | High | `.env` loader kept inline comments as values. Copying `.env.example` set `OPENROUTER_API_KEY="# sk-or-..."` and `OPTIONS_API_KEY="# your pve_live_..."`, so the AI layer looked "configured" with a garbage key. | Strip unquoted `# …` comments; quoted values preserved. |
| 4 | Medium | `/api/options/:ticker` crashed with `Cannot read properties of null` whenever UW returned no contracts (outage, rate limit, bad ticker) instead of returning the intended `UNAVAILABLE` reason. `/api/ai` and `/api/validated` read a non-existent `built.error`. | Early return with `status/reason/detail`. |
| 5 | Medium | Unescaped upstream strings (`sector`, etc.) injected via `innerHTML` in the Signals table (`sigCell`). | `sigCell` now HTML-escapes. |
| 6 | Low | Malformed `pve_sess` cookie threw `URIError` → 500 with stack trace. | Caught → treated as unauthenticated. |
| 7 | Low | Test `phase2-boundary` hard-coded earnings date `2026-08-27`; it went stale and failed (285/286). | Date now relative to today. 286/286 pass. |
| 8 | Low | `.env.example` set `OPTIONS_PROVIDER` twice and lacked `DASHBOARD_PASSWORD`. | Deduped; added. |

## Fixed in follow-up
| # | Issue | Fix |
|---|-------|-----|
| 9 | `/api/validated/ranking` ran up to 50 full signal builds (~10+ UW calls each) on every page view and journaled each one. | Cached per limit for 5 min, single in-flight computation, ranking builds no longer written to the Signal Journal. |
| 10 | `readJournal()` re-read and re-parsed every journal file on each `/api/journal/*` request. | Parse cached; invalidated when any journal file's name/mtime/size changes. Test added. |
| 11 | `getCompanies([ticker])` (one UW call) on every signal build. | Sector cached 24h per ticker (failures not cached). |
| 12 | No security headers; cookie never `Secure`; `X-Powered-By` exposed. | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`; `Secure` cookie over HTTPS; opt-in `TRUST_PROXY` for reverse-proxy deploys. |

## Remaining (not bugs)
- Dead PVE code (`callPVE`, `ALIASES`, `N`, empty route table `R`, `/api/explore/markets`). `/api/_inspect` is still called by the UI's monitor tab, so removal needs a UI change too.
- `READINESS` shows whichever ticker was scored last (display-only, by design).
- No CSP: `public/index.html` relies on inline scripts/styles.
