// @ts-check
/*
 * research/signal-log-report.js — OFFLINE attribution report over the Signal Journal.
 * Answers: which signal COMPONENTS actually predict forward returns? Groups resolved records by
 * (1) each production-SCORED active component and (2) — separately, clearly labelled — the SHADOW-ONLY
 * sweep/flow classification, so we can later judge whether sweep info adds predictive value.
 * Never imported by the server. Reuses research/stats.js. Sample-size gated; nothing fabricated.
 *
 * CURRENT-ENGINE FINDINGS baked into the header (req 8): production largePremium is unavailable
 * (flow isn't passed into buildOptionsSignal) so sweeps DON'T affect the production score; the
 * prediction-market factor is ~1.0 (feed unavailable); scored GEX is chain-computed while the PVE
 * GEX override is display-only; oiChange/momentum have cold-start behavior without a prior snapshot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mean, median, bootstrapCI, isNum } from './stats.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const dirSign = (d) => (d === 'bull' ? 1 : d === 'bear' ? -1 : 0);

/** Compute hit-rate / avg return / CI for a set of resolved records at one horizon. */
function statsFor(records, h) {
  const rows = records.filter((r) => r.forward && r.forward[h] && r.forward[h].status === 'resolved' && isNum(r.forward[h].ret) && dirSign(r.composite.dir) !== 0);
  const rets = rows.map((r) => r.forward[h].ret);
  const hits = rows.map((r) => Math.sign(r.forward[h].ret) === dirSign(r.composite.dir));
  const ci = bootstrapCI(rets, { iters: 1000 });
  return { n: rows.length, hitRate: rows.length ? hits.filter(Boolean).length / rows.length : null, avgRet: mean(rets), medianRet: median(rets), retCI: rows.length ? [ci.lo, ci.hi] : null };
}

/**
 * Pure attribution. @returns grouped stats by production component and by shadow flow bucket.
 * @param {object[]} records resolved signal-log records @param {{minSample?:number}} [opts]
 */
export function attribute(records, opts = {}) {
  const minSample = opts.minSample ?? 30;
  const horizons = ['1d', '1w'];
  const gate = (s) => ({ ...s, verdict: s.n < minSample ? 'INSUFFICIENT DATA' : 'ok' });

  // (A) production-scored components: group by records where the component was active
  const compKeys = [...new Set(records.flatMap((r) => (r.scored && r.scored.activeComponents) || []))];
  const byComponent = {};
  for (const key of compKeys) {
    const subset = records.filter((r) => (r.scored && r.scored.activeComponents || []).includes(key));
    byComponent[key] = { scored: true }; for (const h of horizons) byComponent[key][h] = gate(statsFor(subset, h));
  }

  // (C) shadow-only sweep/flow buckets — clearly separated; NEVER part of production scoring
  const hasSweep = (r) => r.shadowOnly && r.shadowOnly.flow && r.shadowOnly.flow.available && ((isNum(r.shadowOnly.flow.sweepSampleSize) && r.shadowOnly.flow.sweepSampleSize > 0) || (isNum(r.shadowOnly.flow.goldenCount) && r.shadowOnly.flow.goldenCount > 0));
  const shadowFlow = { note: 'shadow-only / experimental — not used in production scoring' };
  for (const [label, pred] of [['sweep_present', hasSweep], ['no_sweep', (r) => !hasSweep(r)]]) {
    const subset = records.filter(pred); shadowFlow[label] = {}; for (const h of horizons) shadowFlow[label][h] = gate(statsFor(subset, h));
  }

  // overall + by tier
  const overall = {}; for (const h of horizons) overall[h] = gate(statsFor(records, h));
  const tiers = [...new Set(records.map((r) => r.composite.tier).filter(Boolean))];
  const byTier = {}; for (const t of tiers) { const subset = records.filter((r) => r.composite.tier === t); byTier[t] = {}; for (const h of horizons) byTier[t][h] = gate(statsFor(subset, h)); }

  // (TA) OBSERVE-ONLY retail technicals — grouped by whether each indicator agrees with the trade
  // direction (or its zone). NOT used in production scoring; here purely to test predictive value.
  const ta = (r) => (r.technicals && r.technicals.available ? r.technicals.signals || {} : {});
  const technicals = { note: 'OBSERVE-ONLY retail technicals — not used in production scoring' };
  const taBuckets = {
    macd_agrees: (r) => ta(r).macdCross && ta(r).macdCross === r.composite.dir,
    macd_disagrees: (r) => ta(r).macdCross && ta(r).macdCross !== r.composite.dir && ta(r).macdCross !== 'neutral',
    rsi_oversold: (r) => ta(r).rsiZone === 'oversold',
    rsi_overbought: (r) => ta(r).rsiZone === 'overbought',
    rsi_neutral: (r) => ta(r).rsiZone === 'neutral',
    above_sma50: (r) => ta(r).priceVsSma50 === 'above',
    below_sma50: (r) => ta(r).priceVsSma50 === 'below',
    trend_up_sma50_200: (r) => ta(r).smaTrend === 'up',
    trend_down_sma50_200: (r) => ta(r).smaTrend === 'down',
  };
  for (const [label, pred] of Object.entries(taBuckets)) { const subset = records.filter(pred); technicals[label] = {}; for (const h of horizons) technicals[label][h] = gate(statsFor(subset, h)); }

  return { minSample, totalRecords: records.length, resolvedRecords: records.filter((r) => r.resolved).length, overall, byComponent, shadowFlow, technicals, byTier };
}

// ---------- rendering + CLI ----------
const pct = (x) => (isNum(x) ? (x * 100).toFixed(1) + '%' : '—');
const rpct = (x) => (isNum(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%' : '—');
function table(title, groups) {
  const rows = Object.entries(groups).filter(([k]) => k !== 'scored' && k !== 'note').map(([k, g]) => `| ${k} | ${g['1d'].n} | ${pct(g['1d'].hitRate)} | ${rpct(g['1d'].avgRet)} | ${g['1d'].verdict} | ${g['1w'].n} | ${pct(g['1w'].hitRate)} | ${rpct(g['1w'].avgRet)} | ${g['1w'].verdict} |`);
  return `### ${title}\n| group | n(1d) | 1d hit | 1d avgRet | 1d verdict | n(1w) | 1w hit | 1w avgRet | 1w verdict |\n|---|---|---|---|---|---|---|---|---|\n${rows.join('\n') || '| — | | | | | | | | |'}`;
}
function render(a) {
  return [
    '# Signal Journal — Component Attribution Report', '',
    `Records: **${a.totalRecords}** · resolved: **${a.resolvedRecords}** · sample-size gate: n ≥ ${a.minSample} (else INSUFFICIENT DATA).`,
    '', '> Current-engine findings (do not "fix" — these are what the journal is measuring):',
    '> production `largePremium` is unavailable (flow not passed into buildOptionsSignal), so sweeps do NOT affect the production score; prediction-market factor ≈ 1.0 (feed unavailable); scored GEX is chain-computed while the PVE GEX override is display-only; `oiChange`/momentum have cold-start behavior without a prior snapshot.',
    '', table('Production-scored components (A)', a.byComponent),
    '', table('Shadow-only sweep/flow (C) — experimental, not scored', a.shadowFlow),
    '', table('Retail technicals — OBSERVE-ONLY, not scored', a.technicals),
    '', table('By tier', a.byTier),
    '', '### Overall', `1d: n=${a.overall['1d'].n}, hit ${pct(a.overall['1d'].hitRate)}, avgRet ${rpct(a.overall['1d'].avgRet)} (${a.overall['1d'].verdict}) · 1w: n=${a.overall['1w'].n}, hit ${pct(a.overall['1w'].hitRate)}, avgRet ${rpct(a.overall['1w'].avgRet)} (${a.overall['1w'].verdict})`,
  ].join('\n');
}

function logDir() { return process.env.SIGNAL_LOG_DIR || path.join(ROOT, 'research-data', 'signal-log'); }
function readResolved(dir) { const byId = new Map(); let files = []; try { files = fs.readdirSync(dir).filter((f) => f.startsWith('signal-log-') && f.endsWith('.jsonl')); } catch { return []; } for (const f of files) for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { if (!line.trim()) continue; try { const r = JSON.parse(line); if (r && r.id && !byId.has(r.id)) byId.set(r.id, r); } catch {} } return [...byId.values()]; }

function main() {
  const outDir = path.join(ROOT, 'research-data', 'reports'); fs.mkdirSync(outDir, { recursive: true });
  const records = readResolved(logDir());
  const a = attribute(records);
  const p = path.join(outDir, 'SIGNAL_LOG_REPORT.md'); fs.writeFileSync(p, render(a));
  console.log(`[report] ${records.length} records (${a.resolvedRecords} resolved) -> ${p}`);
  process.exit(0);
}
if (process.argv[1] && process.argv[1].endsWith('signal-log-report.js')) main();
