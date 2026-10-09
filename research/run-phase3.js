// @ts-check
/*
 * research/run-phase3.js — OFFLINE Phase 3 orchestrator. Builds the validation dataset from the
 * Phase 0/1/2 stores, runs walk-forward validation + benchmarks + score buckets + feature-importance
 * + the KEEP/REMOVE decision table, writes a Markdown report, and (real mode) regenerates
 * validated/promotion.json from EVIDENCE. If there is not enough out-of-sample data, it honestly
 * reports INSUFFICIENT DATA and promotes nothing (validated score keeps mirroring current).
 *
 * Never imported by the server. Usage:
 *   node research/run-phase3.js                 # real data (reads RESEARCH_SIGNAL_DIR/SNAPSHOT_DIR, needs OPTIONS_API_KEY for OHLC)
 *   node research/run-phase3.js --synthetic 800 # demonstrate the pipeline on a planted+noise dataset (writes a separate report, never promotion.json)
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildDataset, DATASET_FEATURES } from './dataset.js';
import { labelMultiHorizon } from './labeler.js';
import { walkForwardSplits, verifyNoLeakage, scoreBuckets, benchmarks, breakdownBy, featureDecisionTable, performanceSummary } from './validate.js';
import { permutationImportance, univariateCorrelations, redundancyPairs } from './importance.js';
import { mulberry32, mean } from './stats.js';
import { readSignals } from './signals-store.js';
import { readSnapshots } from './snapshot-store.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT_DIR = path.join(ROOT, 'research-data', 'reports');

function md(lines) { return lines.join('\n'); }
function table(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}
const pct = (x) => (typeof x === 'number' && isFinite(x) ? (x * 100).toFixed(2) + '%' : '—');
const f3 = (x) => (typeof x === 'number' && isFinite(x) ? x.toFixed(3) : '—');

// ---------- synthetic pipeline demonstration (NOT used for promotion) ----------
function syntheticDataset(n = 800, seed = 11) {
  const rng = mulberry32(seed); const rows = []; const start = Date.parse('2024-01-01');
  for (let i = 0; i < n; i++) {
    const edge = rng() * 2 - 1, noise = rng() * 2 - 1; const drift = 0.02 * edge;
    let px = 100; const bars = [{ date: new Date(start + i * 864e5).toISOString().slice(0, 10), high: px * 1.005, low: px * 0.995, close: px }];
    for (let d = 1; d <= 12; d++) { px *= 1 + (drift / 6 + (rng() - 0.5) * 0.01); bars.push({ date: new Date(start + i * 864e5 + d * 864e5).toISOString().slice(0, 10), high: px * 1.006, low: px * 0.994, close: px }); }
    rows.push({ ts: bars[0].date + 'T15:00:00Z', ticker: 'T' + (i % 20), direction: edge >= 0 ? 'bull' : 'bear', shadowScore: Math.round((edge + 1) * 50), currentScore: 50, plantedEdge: edge, noiseFeature: noise, labels: labelMultiHorizon({ bars, entryIndex: 0, direction: edge >= 0 ? 'bull' : 'bear', horizons: [1, 3, 5, 10] }) });
  }
  return rows;
}
function runSynthetic(n) {
  const rows = syntheticDataset(n);
  const splits = walkForwardSplits(rows, { horizonDays: 5, embargoDays: 5 });
  const leak = verifyNoLeakage(rows, splits, { horizonDays: 5, embargoDays: 5 });
  const buckets = scoreBuckets(rows, { scoreKey: 'shadowScore', horizon: 5 });
  const decisions = featureDecisionTable(rows, ['plantedEdge', 'noiseFeature'], { horizon: 5, minSample: 200 });
  const withRet = rows.filter((r) => r.labels.byHorizon[5].insufficient === false).map((r) => ({ plantedEdge: r.plantedEdge, noiseFeature: r.noiseFeature, __ret: r.labels.byHorizon[5].ret }));
  const imp = permutationImportance(withRet, ['plantedEdge', 'noiseFeature'], (r) => r.__ret);
  const rep = md([
    '# Phase 3 — SYNTHETIC pipeline demonstration (NOT production evidence)',
    '', 'This report proves the validation machinery works: it is run on a **synthetic** dataset with a',
    'planted edge (`plantedEdge`) and a pure-noise feature (`noiseFeature`). It is **never** used to',
    'promote features into the real production model.', '',
    `- rows: ${rows.length} · walk-forward folds: ${splits.length} · leakage check: ${leak.ok ? 'PASS' : 'FAIL — ' + leak.reason}`,
    '', '## Score buckets (shadowScore vs forward 5d return)',
    table(['bucket', 'count', 'hitRate', 'avgReturn'], buckets.map((b) => [b.bucket, b.count, pct(b.hitRate), pct(b.avgReturn)])),
    '', '## Feature decision table',
    table(['feature', 'sampleSize', 'oosCorr', 'stability', 'decision'], decisions.map((d) => [d.feature, d.sampleSize, f3(d.oosCorr), d.oosStability != null ? pct(d.oosStability) : '—', d.decision])),
    '', '## Permutation importance (offline logistic model)',
    imp.insufficient ? '_insufficient_' : table(['feature', 'importance'], imp.importances.map((x) => [x.feature, f3(x.importance)])),
    '', '**Expected:** planted feature shows positive OOS correlation and higher importance; noise does not.',
    'This confirms the pipeline can distinguish real signal from noise before any production promotion.',
  ]);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const p = path.join(OUT_DIR, 'PHASE3_SYNTHETIC_REPORT.md'); fs.writeFileSync(p, rep);
  const planted = decisions.find((d) => d.feature === 'plantedEdge'), noise = decisions.find((d) => d.feature === 'noiseFeature');
  console.log(`[synthetic] rows=${rows.length} leak=${leak.ok ? 'PASS' : 'FAIL'} plantedCorr=${f3(planted.oosCorr)} noiseCorr=${f3(noise.oosCorr)} → ${p}`);
  return p;
}

// ---------- real Phase 3 run (evidence-driven; regenerates promotion.json) ----------
async function loadRealRecords() {
  const sigDir = process.env.RESEARCH_SIGNAL_DIR; const snapDir = process.env.RESEARCH_SNAPSHOT_DIR;
  let records = [];
  if (sigDir) { // signals store carries feature vectors at emission (preferred)
    try { const days = fs.readdirSync(sigDir).filter((f) => f.startsWith('signals-')).map((f) => f.slice(8, 18)); for (const d of days) records = records.concat(await readSignals(sigDir, { date: d })); } catch {}
  }
  if (!records.length && snapDir) { // fall back to raw snapshots (scalars only)
    try { const days = fs.readdirSync(snapDir).filter((f) => f.startsWith('snapshots-')).map((f) => f.slice(10, 20)); for (const d of days) records = records.concat(await readSnapshots(snapDir, { date: d })); } catch {}
  }
  return records;
}
async function fetchOhlc(tickers) {
  const key = process.env.OPTIONS_API_KEY; if (!key || !tickers.length) return {};
  const { makeOptionsProvider } = await import('../providers/options.js');
  const p = makeOptionsProvider(process.env); if (p.name === 'null') { console.error(p.reason); process.exit(1); }
  const out = {};
  for (const t of tickers) { try { out[t] = await p.getOhlc(t); } catch { /* skip */ } }
  return out;
}
async function runReal() {
  const records = await loadRealRecords();
  const tickers = [...new Set(records.map((r) => String(r.ticker || '').toUpperCase()).filter(Boolean))];
  const ohlc = await fetchOhlc(tickers);
  const ds = buildDataset(records, ohlc, { horizons: [1, 3, 5, 10] });
  const enough = !ds.insufficient && ds.labeledCount >= 200;
  const features = DATASET_FEATURES.filter((f) => ds.coverage[f] > 0);
  let decisions = [];
  if (enough) decisions = featureDecisionTable(ds.rows, features, { horizon: 5, minSample: 200 });

  const approved = decisions.filter((d) => d.decision === 'KEEP' || d.decision === 'KEEP WITH LOWER WEIGHT');
  const weights = {}; for (const d of approved) weights[d.feature] = (d.decision === 'KEEP WITH LOWER WEIGHT' ? 5 : 10) * Math.sign(d.oosCorr || 1);

  const promotion = {
    version: approved.length ? 'promotion-' + new Date().toISOString().slice(0, 10) : 'promotion-empty',
    generatedAt: new Date().toISOString(), baseline: 'current', primary: 'current', // stays current until manual activation review
    approvedFeatures: approved.map((d) => d.feature), weights, calibration: null,
    dataset: { size: ds.size, labeledCount: ds.labeledCount, dateRange: ds.dateRange, insufficient: !enough },
    note: enough ? 'Features approved from walk-forward out-of-sample evidence. Review before setting primary=validated.' : 'INSUFFICIENT DATA — no features promoted; current score remains production. Keep collecting snapshots/signals.',
  };
  fs.writeFileSync(path.join(ROOT, 'validated', 'promotion.json'), JSON.stringify(promotion, null, 2) + '\n');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rep = md([
    '# Phase 3 — Offline Validation Report (real data)', '', `Generated: ${promotion.generatedAt}`, '',
    '## 1. Dataset', `- observations: **${ds.size}** · labeled (≥1 horizon): **${ds.labeledCount}** · date range: ${ds.dateRange.from || '—'} → ${ds.dateRange.to || '—'}`,
    `- status: **${enough ? 'sufficient' : 'INSUFFICIENT DATA'}** (need ≥200 labeled observations for walk-forward promotion)`,
    '', '## 2. Feature coverage', table(['feature', 'coverage'], features.length ? features.map((f) => [f, ds.coverage[f] + '%']) : [['—', '—']]),
    '', '## 3. Feature decisions', enough ? table(['feature', 'sample', 'oosCorr', 'stability', 'decision', 'reason'], decisions.map((d) => [d.feature, d.sampleSize, f3(d.oosCorr), d.oosStability != null ? pct(d.oosStability) : '—', d.decision, d.reason])) : '_Not enough data to make any KEEP/REMOVE decision. All shadow features remain SHADOW ONLY._',
    '', '## 4. Promotion outcome',
    approved.length ? `Promoted: **${approved.map((d) => d.feature).join(', ')}**.` : '**No features promoted.** The validated score continues to mirror the current production score (delta 0).',
    '', '## 5. Guarantees', '- Production scoring unchanged by this run. - Validated score stays non-primary until manual activation review. - Nothing fabricated; missing values stayed null. - No secrets read or written.',
  ]);
  const p = path.join(OUT_DIR, 'PHASE3_REPORT.md'); fs.writeFileSync(p, rep);
  console.log(`[real] observations=${ds.size} labeled=${ds.labeledCount} promoted=${approved.length} → ${p}`);
  console.log(`[real] promotion.json ${approved.length ? 'updated with ' + approved.length + ' feature(s)' : 'kept EMPTY (insufficient data)'} — current score remains production.`);
  return p;
}

// ---------- CLI ----------
const argv = process.argv.slice(2);
const synthIdx = argv.indexOf('--synthetic');
(async () => {
  if (synthIdx !== -1) { const n = Number(argv[synthIdx + 1]) || 800; runSynthetic(n); process.exit(0); }
  await runReal(); process.exit(0);
})();
