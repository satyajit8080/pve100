/* PVE Signal Engine — client (thin shell).
   All scoring/labels/research math now lives in engine.js (the single source of truth, also
   covered by `node --test`). This file only does I/O, state, polling and rendering. */

import {
  DEFAULT_CONFIG, COMPONENTS, FEATURE_DEFS, buildSignal, emitDecision, evaluateOutcome, updateExcursion,
  bucketPerformance, featurePerformance, combinationPerformance, groupPerformance, splitByTime, walkForward,
  captureSnapshot, replaySignal, scoreTier, median, ENGINE_VERSION,
} from './engine.js';
import { combineScores as optCombine, scoreTier as optTier } from './options-engine.js';
import { createOverviewSim } from './overview-sim.js';

const HORIZONS = [5, 15, 30, 60];
const APP_DEFAULTS = { minScore: 70, pollSec: 20, topK: 8, staleMin: 3 };

// ---------- config (engine defaults + app loop settings) ----------
const cfg = loadCfg();
function loadCfg() {
  let s = {}; try { s = JSON.parse(localStorage.getItem('pve_cfg') || '{}'); } catch {}
  return { ...DEFAULT_CONFIG, ...APP_DEFAULTS, ...s, weights: { ...DEFAULT_CONFIG.weights, ...(s.weights || {}) } };
}
function saveCfg() { localStorage.setItem('pve_cfg', JSON.stringify(cfg)); }

// ---------- state ----------
const state = {
  mode: 'live', liveAvailable: false, baseUrl: '',
  signals: new Map(), history: loadHistory(), lastPrice: {}, hist: {}, classify: null, snapshots: loadSnaps(),
  ctx: { flow: null, spikes: [], traders: [], markets: [], volMed: 1, liqMed: 1, snapshotTs: 0, marketHist: {} },
  ui: { tab: 'signals', thr: 0, sides: new Set(), filter: '', minVol: 0, monView: 'raw', monEndpoint: '', btSplit: 'all' },
  scanning: false, lastScan: 0, connErr: '', suppressed: 0, lowQ: 0,
};
function loadHistory() { try { return JSON.parse(localStorage.getItem('pve_history') || '[]'); } catch { return []; } }
function saveHistory() { try { localStorage.setItem('pve_history', JSON.stringify(state.history.slice(-800))); } catch {} }
function loadSnaps() { try { return JSON.parse(localStorage.getItem('pve_snaps') || '[]'); } catch { return []; } }
function saveSnaps() { try { localStorage.setItem('pve_snaps', JSON.stringify(state.snapshots.slice(-60))); } catch {} }

// ---------- dom + fmt helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
function fmt(n) { if (!isNum(n)) return '—'; const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k'; if (a < 1 && a > 0) return n.toFixed(3); return String(Math.round(n)); }
function pct(n, d = 0) { return isNum(n) ? (n * 100).toFixed(d) + '%' : '—'; }
function hhmmss(ts) { return new Date(ts).toTimeString().slice(0, 8); }
function ago(ts) { const s = Math.round((Date.now() - ts) / 1000); if (s < 60) return s + 's'; if (s < 3600) return Math.round(s / 60) + 'm'; return Math.round(s / 3600) + 'h'; }
const num = (s) => `<span class="num">${s}</span>`;
function tableHTML(cols, rows, empty) {
  if (!rows || !rows.length) return `<div class="empty">${empty || 'No data.'}</div>`;
  return `<table><thead><tr>${cols.map((c, i) => `<th${i ? ' style="text-align:right"' : ''}>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' style="text-align:right"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// ---------- api / auth ----------
async function api(path, params) {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  const r = await fetch('/api' + path + q, { credentials: 'include' });
  if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
  return r.json();
}
async function checkStatus() { const s = await (await fetch('/auth/status', { credentials: 'include' })).json(); state.liveAvailable = s.live; state.baseUrl = s.baseUrl || ''; state.optProvider = s.options || null; return s; }
function showLogin() { $('#login').style.display = 'flex'; $('#app').style.display = 'none'; }
async function doLogin() {
  $('#lerr').textContent = '';
  const r = await fetch('/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) });
  if (!r.ok) { $('#lerr').textContent = r.status === 403 ? 'Wrong password.' : 'Login failed.'; return; }
  const j = await r.json(); state.liveAvailable = j.live; start();
}
async function doLogout() { await fetch('/auth/logout', { method: 'POST', credentials: 'include' }); location.reload(); }

// =====================================================================
//  SCAN LOOP  (I/O + orchestration only; math is in engine.js)
// =====================================================================
let scanTimer = null;
// The legacy prediction-market poll loop was removed with the PVE Trade API (§18).
// Options data now arrives only via Run Scan (server-side) and the per-ticker endpoint.
async function scan() { state.lastScan = state.lastScan || Date.now(); renderPills(); }
function reconcile(markets, deepMap) {
  const now = Date.now(); const seen = new Set(); let suppressed = 0, lowQ = 0;
  for (const m of markets) {
    if (!m.slug) continue;
    const { signal, quality } = buildSignal(m, deepMap[m.slug], state.ctx, now, cfg);
    if (quality.level === 'reject' || !signal) continue;
    if (quality.level === 'low') lowQ++;
    if (signal.dir === 'neutral') continue;
    const existing = [...state.signals.values()].find((s) => s.slug === m.slug);
    const dec = emitDecision(existing, signal, cfg, now);
    if (dec.action === 'suppress') { if (existing) seen.add(existing.id); suppressed++; continue; }
    if (dec.action === 'update' && existing) {
      Object.assign(existing, { score: signal.score, tier: signal.tier, net: signal.net, coverage: signal.coverage, confidence: signal.confidence, comps: signal.comps, proxies: signal.proxies, diagnostics: signal.diagnostics, assetType: signal.assetType, ticker: signal.ticker, market: signal.market, quality: signal.quality, qualityScore: signal.qualityScore, qualityReasons: signal.qualityReasons, tags: signal.tags, title: signal.title, ts_updated: now });
      seen.add(existing.id);
    } else {
      if (dec.action === 'flip' && existing) state.signals.delete(existing.id);
      signal.ts_created = now; signal.ts_updated = now;
      const snap = captureSnapshot(m, deepMap[m.slug], state.ctx, now, cfg, signal.classification);
      state.snapshots.push({ hid: signal.slug + ':' + signal.dir + ':' + now, ts: now, slug: signal.slug, ticker: signal.ticker, dir: signal.dir, score: signal.score, tier: signal.tier, snapshot: snap });
      if (state.snapshots.length > 60) state.snapshots.shift();
      saveSnaps();
      state.signals.set(signal.id, signal); addHistory(signal); seen.add(signal.id);
    }
  }
  state.suppressed = suppressed; state.lowQ = lowQ;
  const staleMs = cfg.staleMin * 60000;
  for (const [id, s] of state.signals) if (!seen.has(id) && now - s.ts_updated > staleMs) state.signals.delete(id);
}

// ---------- history + forward-outcome evaluation (labels via engine) ----------
function addHistory(sig) {
  state.history.push({
    hid: sig.slug + ':' + sig.dir + ':' + sig.ts_created, ts: sig.ts_created, slug: sig.slug, title: sig.title,
    ticker: sig.ticker || null, assetType: sig.assetType || null, tier: sig.tier,
    dir: sig.dir, score: sig.score, coverage: sig.coverage, confidence: sig.confidence, quality: sig.quality, mode: 'live',
    regime: sig.diagnostics ? sig.diagnostics.regime : null, diagnostics: sig.diagnostics || null,
    comps: sig.comps.map((c) => ({ key: c.key, avail: c.avail, dir: c.dir, strength: c.strength, note: c.note })),
    leadTokenId: sig.leadTokenId, entryPrice: sig.entryPrice, mfe: 0, mae: 0,
    evals: Object.fromEntries(HORIZONS.map((h) => [h, { done: false }])),
  });
  saveHistory();
}
function updateEvals() {
  const now = Date.now(); let changed = false;
  for (const row of state.history) {
    const cur = state.lastPrice[row.slug];
    if (!isNum(cur) || !isNum(row.entryPrice)) continue;
    if (now - row.ts < 65 * 60000) { const e = updateExcursion(row.mfe, row.mae, row.entryPrice, cur, row.dir); if (e.mfe !== row.mfe || e.mae !== row.mae) { row.mfe = e.mfe; row.mae = e.mae; changed = true; } }
    for (const h of HORIZONS) if (!row.evals[h].done && now >= row.ts + h * 60000) { row.evals[h] = evaluateOutcome(row.entryPrice, cur, row.dir); changed = true; }
  }
  if (changed) saveHistory();
}

// =====================================================================
//  RENDER
// =====================================================================
function renderAll() {
  renderPills();
  renderDashboard();
  if ($('#histTable')) renderHistory();
  if ($('#btTable')) renderBacktest();
  if ($('#rpTable')) renderReplay();
  if (state.ui.tab === 'research') renderResearch();
  if (state.ui.tab === 'health') renderHealth();
}
const dirClass = (d) => d === 'bull' ? 'b' : d === 'bear' ? 's' : 'n';
const dirWord = (d) => d === 'bull' ? 'BULLISH · CALL' : d === 'bear' ? 'BEARISH · PUT' : 'NEUTRAL';

function renderPills() {
  const conn = $('#pillConn'), s = $('#connTxt');
  const _op = state.optProvider;
  if (_op && _op.configured) { conn.className = 'pill ok'; s.textContent = _op.provider.toUpperCase() + ' · connected'; conn.title = ''; }
  else if (_op && _op.reason) { conn.className = 'pill bad'; s.textContent = _op.reason.slice(0, 46); conn.title = _op.reason; }
  else if (state.connErr) { conn.className = 'pill bad'; s.textContent = state.connErr.slice(0, 40); }
  else if (state.scanning) { conn.className = 'pill warnp'; s.textContent = 'scanning…'; }
  else { conn.className = 'pill ok'; s.textContent = 'connected'; }
  const op = state.optProvider; const opLive = !!(op && op.configured);
  $('#srcTxt').textContent = opLive ? (op.provider.toUpperCase() + ' LIVE') : 'NO PROVIDER';
  const pd = $('#pillData'); if (pd) pd.title = opLive ? `${op.provider.toUpperCase()} ${op.keyMasked || ''}` : ((op && op.reason) || 'options provider not configured');
  $('#pillData').className = 'pill ' + (opLive ? 'ok' : 'warnp');
  $('#scanTxt').textContent = state.lastScan ? hhmmss(state.lastScan) : '—';
}

function convBar(net) { const w = clamp(Math.abs(net) * 50, 0, 50); return `<div class="conv"><div class="mid"></div><div class="fill ${net >= 0 ? 'b' : 's'}" style="width:${w}%"></div></div>`; }
function compChips(comps, dir) {
  const sgn = dir === 'bull' ? 1 : dir === 'bear' ? -1 : 0;
  return comps.map((c) => {
    if (!c.avail) return `<span class="comp na">${c.label} ·</span>`;
    const cls = c.dir === 0 ? '' : Math.sign(c.dir) === sgn ? 'up' : 'dn';
    return `<span class="comp ok ${cls}"><span class="m"></span>${c.label}</span>`;
  }).join('');
}
function qBadge(q) { const c = q === 'ok' ? 'bull' : q === 'low' ? 'warn' : 'bear'; return `<span class="${c}" title="data quality">${q === 'ok' ? '● data ok' : q === 'low' ? '◐ data low' : '○ data'}</span>`; }
const tickerOf = (sig) => sig.ticker || (sig.tags || [])[0] || sig.slug;
function pmMetrics(sig) {
  const d = sig.diagnostics || {}; const price = (sig.comps || []).find((c) => c.key === 'price'); const ob = (sig.comps || []).find((c) => c.key === 'liquidity');
  const pm = price && price.avail && isNum(price.value) ? (price.value >= 0 ? '+' : '') + (price.value * 100).toFixed(1) : '—';
  const obv = ob && ob.avail && isNum(ob.value) ? (ob.value * 100).toFixed(0) + '%' : '—';
  return { pm, flowA: isNum(d.flowAnomaly) ? (d.flowAnomaly * 100).toFixed(0) + '%' : '—', volA: isNum(d.volAnomaly) ? (d.volAnomaly * 100).toFixed(0) + '%' : '—', obv, accel: isNum(d.flowAccel) ? (d.flowAccel >= 0 ? '+' : '') + (d.flowAccel * 100).toFixed(0) + '%' : '—', regime: d.regime || '—' };
}
function sigRow(sig, rank) {
  const dc = dirClass(sig.dir); const m = pmMetrics(sig);
  const proxy = (sig.proxies && sig.proxies.length) ? `<span class="dim" title="proxy metrics (not real options data)">proxy: ${sig.proxies.join(', ')}</span>` : '';
  return `<div class="sig ${dc}" data-id="${esc(sig.id)}">
    <div class="rank">${rank || ''}</div>
    <div>
      <div class="tkr">${esc(tickerOf(sig).toUpperCase())} <span class="dirbadge ${dc}">${dirWord(sig.dir)}</span> <span class="dim">${esc(sig.tier || '')}</span></div>
      <div class="ttl">${esc(sig.title)}</div>
      <div class="comps">${compChips(sig.comps, sig.dir)}</div>
      <div class="cov" style="margin-top:4px"><span class="dim">prob-mom ${m.pm} · flowΔ ${m.flowA} · volΔ ${m.volA} · book ${m.obv} · accel ${m.accel} · ${m.regime}</span> ${proxy}</div>
    </div>
    <div>
      ${convBar(sig.net)}
      <div class="cov"><span>conf ${sig.confidence}% · ${qBadge(sig.quality)}</span><span>upd ${ago(sig.ts_updated)}</span></div>
    </div>
    <div class="score"><div class="n ${dc === 'b' ? 'bull' : dc === 's' ? 'bear' : ''}">${sig.score}</div><div class="l">${esc(sig.tier || 'Signal')}</div></div>
  </div>`;
}
const sortedSignals = () => [...state.signals.values()].sort((a, b) => b.score - a.score);
function filteredSignals() {
  let list = sortedSignals();
  if (state.ui.thr) list = list.filter((s) => s.score >= state.ui.thr);
  if (state.ui.sides.size) list = list.filter((s) => state.ui.sides.has(s.dir));
  if (state.ui.filter) { const f = state.ui.filter.toLowerCase(); list = list.filter((s) => (s.slug + ' ' + s.title + ' ' + (s.tags || []).join(' ')).toLowerCase().includes(f)); }
  if (state.ui.minVol) list = list.filter((s) => (s.market.volume || 0) >= state.ui.minVol);
  return list;
}
function bindSigClicks() { $$('.sig').forEach((e) => e.onclick = () => openDetail(e.dataset.id)); }

function kpi(lab, val, sub) { return `<div class="card kpi"><div class="lab">${lab}</div><div class="val">${val}</div><div class="sub">${sub || ''}</div></div>`; }
// The Overview page is now the animated engine explainer (public/overview-sim.js).
// It renders itself; there are no live DOM targets left here.
function renderDashboard() { if (state.ui.tab === 'dashboard') startOverviewSim(); }
function renderHistory() {
  const h = state.history.slice().reverse();
  $('#histMeta').textContent = `${state.history.length} recorded · ${state.history.filter((r) => r.evals[60] && r.evals[60].done).length} fully evaluated`;
  $('#histTable').innerHTML = tableHTML(['Time', 'Market', 'Dir', 'Score', 'Conf', 'Entry', '5m', '15m', '30m', '1h', 'Src'],
    h.slice(0, 200).map((r) => {
      const ev = (k) => { const e = r.evals[k]; return e && e.done ? `<span class="${e.win ? 'bull' : 'bear'}">${e.favPts >= 0 ? '+' : ''}${(e.favPts * 100).toFixed(1)}</span>` : (Date.now() >= r.ts + k * 60000 ? '<span class="dim">·</span>' : '<span class="dim">…</span>'); };
      return [num(hhmmss(r.ts)), esc(r.title || r.slug), `<span class="${dirClass(r.dir) === 'b' ? 'bull' : 'bear'}">${r.dir}</span>`, num(r.score), num((r.confidence ?? '—') + '%'), num(pct(r.entryPrice, 0)), num(ev(5)), num(ev(15)), num(ev(30)), num(ev(60)), `<span class="dim">${r.mode}</span>`];
    }), 'No signals recorded yet. They log automatically as the scanner fires.');
}

function selectedHistory() {
  const rows = state.history.filter((r) => isNum(r.entryPrice));
  if (state.ui.btSplit === 'all') return rows;
  const { train, test } = splitByTime(rows, 0.7);
  return state.ui.btSplit === 'train' ? train : test;
}
function renderBacktest() {
  const rows = selectedHistory();
  $('#btSplitMeta').textContent = `${rows.length} signals in view (of ${state.history.length} total)`;
  const buckets = bucketPerformance(rows, { horizons: HORIZONS });
  $('#btBuckets').innerHTML = tableHTML(['Score bucket', 'N', '5m win', '15m win', '30m win', '1h win', 'avg MFE', 'avg MAE'],
    buckets.map((b) => {
      const cell = (h) => { const s = b.byHorizon[h]; return num(s.n ? `<span class="${s.winRate >= 0.5 ? 'bull' : 'bear'}">${(s.winRate * 100).toFixed(0)}%</span> <span class="dim">${s.n}·${s.avgFav >= 0 ? '+' : ''}${(s.avgFav * 100).toFixed(1)}</span>` : '<span class="dim">—</span>'); };
      return [b.bucket + '%', num(b.n), cell(5), cell(15), cell(30), cell(60), num(`<span class="bull">+${(b.avgMfe * 100).toFixed(1)}</span>`), num(`<span class="bear">${(b.avgMae * 100).toFixed(1)}</span>`)];
    }), 'No data in this split.') + `<div class="dim" style="padding:8px 12px;font-size:11px">win% · sample size · avg favorable pts. Score is a ranking, not a probability — these buckets are the only evidence of what a score has meant historically.</div>`;
  const wf = walkForward(state.history.filter((r) => isNum(r.entryPrice)), 4, 60);
  $('#btWalk').innerHTML = tableHTML(['Fold', 'Train N', 'Test N', '1h win', '1h avg'],
    wf.map((w) => [num('#' + w.fold), num(w.trainN), num(w.test.n), num(w.test.n ? (w.test.winRate * 100).toFixed(0) + '%' : '—'), num(w.test.n ? (w.test.avgFav >= 0 ? '+' : '') + (w.test.avgFav * 100).toFixed(1) : '—')]),
    'Not enough evaluated history for walk-forward folds yet.');
  const ev = state.history.filter((r) => HORIZONS.some((k) => r.evals[k] && r.evals[k].done)).slice().reverse().slice(0, 120);
  $('#btTable').innerHTML = tableHTML(['Time', 'Market', 'Dir', 'Score', 'MFE', 'MAE', '30m', '1h'],
    ev.map((r) => [num(hhmmss(r.ts)), esc(r.title || r.slug), `<span class="${dirClass(r.dir) === 'b' ? 'bull' : 'bear'}">${r.dir}</span>`, num(r.score), num(`<span class="bull">+${((r.mfe || 0) * 100).toFixed(1)}</span>`), num(`<span class="bear">${((r.mae || 0) * 100).toFixed(1)}</span>`),
      num(r.evals[30] && r.evals[30].done ? `${r.evals[30].favPts >= 0 ? '+' : ''}${(r.evals[30].favPts * 100).toFixed(1)}` : '…'), num(r.evals[60] && r.evals[60].done ? `${r.evals[60].favPts >= 0 ? '+' : ''}${(r.evals[60].favPts * 100).toFixed(1)}` : '…')]),
    'No evaluated signals yet.');
}

function renderResearch() {
  const rows = state.history.filter((r) => isNum(r.entryPrice));
  const fp = featurePerformance(rows, { horizons: HORIZONS });
  const cell = (s) => num(s.n ? `<span class="${s.winRate >= 0.5 ? 'bull' : 'bear'}">${(s.winRate * 100).toFixed(0)}%</span> <span class="dim">${s.n}</span>` : '<span class="dim">—</span>');
  $('#fpMeta').textContent = `${rows.length} signals · baseline 1h ${fp.baseline[60].n ? (fp.baseline[60].winRate * 100).toFixed(0) + '% (' + fp.baseline[60].n + ')' : 'n/a'}`;
  const baseRow = ['<b>baseline (all)</b>', num('—'), cell(fp.baseline[5]), cell(fp.baseline[15]), cell(fp.baseline[30]), cell(fp.baseline[60])];
  $('#fpTable').innerHTML = tableHTML(['Feature', 'Fired', '5m', '15m', '30m', '1h'],
    [baseRow, ...fp.perFeature.map((f) => [esc(f.label), num(f.fired), cell(f.byHorizon[5]), cell(f.byHorizon[15]), cell(f.byHorizon[30]), cell(f.byHorizon[60])])], 'No history yet.');
  const combos = [['flow'], ['flow', 'outcome'], ['flow', 'outcome', 'liquidity'], ['flow', 'outcome', 'liquidity', 'volume'], ['flow', 'outcome', 'liquidity', 'volume', 'price']];
  const cp = combinationPerformance(rows, combos, { horizons: HORIZONS });
  $('#fpCombos').innerHTML = tableHTML(['Combination', 'N', '30m win', '1h win', '1h avg'],
    cp.map((c) => { const a = c.byHorizon[30], b = c.byHorizon[60]; return [esc(c.label), num(c.n), cell(a), cell(b), num(b.n ? (b.avgFav >= 0 ? '+' : '') + (b.avgFav * 100).toFixed(1) : '—')]; }), 'No history yet.') +
    `<div class="dim" style="padding:8px 12px;font-size:11px">If stacking features doesn't lift win% above the single-feature and baseline rows, the extra confirmations aren't adding predictive value on your data.</div>`;
}


// ---- On-demand scan (the only bulk API spend; user-triggered, no timer) ----
let SCAN_POLL = null;
function scanStatusTxt(t) { const el = $('#scanStatus'); if (el) el.textContent = t || ''; }
function scanBtnBusy(busy) { const b = $('#sigRunScan'); if (!b) return; b.disabled = !!busy; b.textContent = busy ? 'Scanning…' : 'Run Scan'; }
async function runScan() {
  if (SCAN_POLL) return;
  scanBtnBusy(true); scanStatusTxt('starting…');
  try {
    const r = await fetch('/api/scan/run', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 500 }) });
    const j = await r.json();
    if (!r.ok || !j.ok) { scanBtnBusy(false); scanStatusTxt((j.error || 'could not start') + (j.reason ? ` — ${j.reason}` : '')); return; }
    scanStatusTxt('scanning ' + (j.limit || '') + ' tickers — this uses API quota…');
    SCAN_POLL = setInterval(pollScan, 3000);
  } catch (e) { scanBtnBusy(false); scanStatusTxt('error: ' + e.message); }
}
async function pollScan() {
  try {
    const s = await (await fetch('/api/scan/status', { credentials: 'include' })).json();
    if (s.running) { scanStatusTxt('scanning…'); return; }
    clearInterval(SCAN_POLL); SCAN_POLL = null; scanBtnBusy(false);
    scanStatusTxt(s.lastOk ? 'done · ' + (s.message || '') : 'failed · ' + (s.message || ''));
    if (s.lastOk) renderSignals();
  } catch (e) { clearInterval(SCAN_POLL); SCAN_POLL = null; scanBtnBusy(false); scanStatusTxt('status error'); }
}

// ---- US Stock Signals / Options / Replay / Health ----
function connMsg(empty) {
  if (state.connErr) return `Data unavailable — ${state.connErr}`;
  if (!state.liveAvailable) return 'No PVE_AGENT_KEY set on server — LIVE only, no demo data. Add the key to .env.';
  return empty;
}
const stockList = () => [...state.signals.values()].filter((s) => s.assetType === 'US_EQUITY' || s.assetType === 'US_ETF' || !s.assetType);
function stockRank(a, b) {
  return (b.score - a.score) || (b.coverage - a.coverage)
    || ((b.diagnostics ? b.diagnostics.flowAnomaly || 0 : 0) - (a.diagnostics ? a.diagnostics.flowAnomaly || 0 : 0))
    || ((b.market.liquidity || 0) - (a.market.liquidity || 0))
    || ((b.diagnostics ? b.diagnostics.persistence || 0 : 0) - (a.diagnostics ? a.diagnostics.persistence || 0 : 0));
}
async function renderOptions() {
  const ticker = (($('#optTicker') && $('#optTicker').value) || 'AAPL').toUpperCase().trim();
  $('#optMeta').textContent = ticker;
  $('#optStatus').textContent = 'loading ' + ticker + '…';
  if ($('#shadowOut')) { $('#shadowOut').innerHTML = ''; if ($('#shadowStatus')) $('#shadowStatus').textContent = ''; }
  let r; try { r = await api('/options/' + encodeURIComponent(ticker)); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) {
    $('#optStatus').innerHTML = `<span class="bear">${esc((r && r.provider) || 'no provider')}</span>`;
    $('#optSummary').innerHTML = `<div class="card"><div class="bd" style="padding:16px"><b class="bear">Insufficient options data.</b> <span class="dim">${esc((r && r.error) || 'unavailable')}</span><div class="dim" style="margin-top:8px;font-size:12px">Set <span class="mono">OPTIONS_PROVIDER=uw</span> and <span class="mono">UNUSUAL_WHALES_API_TOKEN=</span>your UW token in <span class="mono">.env</span> on the server, then restart.</div></div></div>`;
    $('#optFeatures').innerHTML = ''; $('#optChain').innerHTML = '';
    return;
  }
  const sig = r.signal; const ch = r.chain; const fa = (ch && ch.fieldsAvailable) || {};
  $('#optStatus').innerHTML = `source <span class="mono">${esc(r.provider)}</span> · ${esc(r.ts ? hhmmss(new Date(r.ts).getTime()) : '')}`;

  // SECONDARY: PVE confirmation from the client's prediction-market signals (matched by ticker)
  const pve = [...state.signals.values()].find((s) => (s.ticker || '').toUpperCase() === ticker);
  let finalScore = sig.finalScore, tier = sig.tier, pveState = 'unavailable', pveScore = null;
  if (pve) {
    pveScore = pve.score;
    const c = optCombine({ optionsScore: sig.optionsScore, optionsDir: sig.dir, stockScore: sig.stockScore, stockDir: (sig.stock && sig.stock.dir) || 'neutral', predictionMarketScore: pve.score, predictionMarketDir: pve.dir, dataQuality: sig.dataQuality });
    finalScore = c.finalScore; tier = c.tier; pveState = c.pveState;
  }
  const availPill = (k, label) => `<span class="dim" title="${label}">${label}: <b class="${fa[k] ? 'bull' : 'bear'}">${fa[k] ? 'AVAILABLE' : 'UNAVAILABLE'}</b></span>`;
  const dcl = sig.dir === 'bull' ? 'bull' : sig.dir === 'bear' ? 'bear' : '';
  const a = sig.agg || {};
  const kv = (k, v) => `<div class="f"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const gexTxt = isNum(a.gex) ? `<span class="${a.gex >= 0 ? 'bull' : 'bear'}">${a.gex >= 0 ? '+' : ''}${(a.gex / 1e6).toFixed(1)}M</span>` : '<span class="dim">unavailable (needs greeks+OI)</span>';
  $('#optSummary').innerHTML = `<div class="card"><div class="body" style="padding:16px">
    <div class="top" style="display:flex;align-items:center;gap:12px">
      <div><div class="tkr" style="font-size:20px">${esc(ticker)} <span class="dirbadge ${dcl === 'bull' ? 'b' : dcl === 'bear' ? 's' : 'n'}">${esc((sig.dir || 'neutral').toUpperCase())}</span></div>
      <div class="muted" style="font-size:12px">underlying ${isNum(ch.underlying && ch.underlying.price) ? '$' + ch.underlying.price.toFixed(2) : '—'} · data ${esc(sig.dataQualityStatus)} (${sig.dataQuality}%)</div></div>
      <div class="score" style="margin-left:auto;text-align:right"><div class="n ${dcl}" style="font-size:30px">${finalScore}</div><div class="l">${esc(tier)} · FINAL</div><div class="l dim" style="font-size:9px;letter-spacing:.06em">LIVE · RECOMPUTED NOW</div></div>
    </div>
    <div class="dl" style="margin-top:14px">
      ${kv('Options score', `<b>${sig.optionsScore}</b>`)} ${kv('Stock score', `<b>${sig.stockScore}</b>`)}
      ${kv('PVE confirmation', pveScore === null ? '<span class="dim">none</span>' : `${pveScore} <span class="dim">(${esc(pveState)})</span>`)} ${kv('Data quality', pct(sig.dataQuality / 100, 0))}
      ${kv('Call/Put vol', isNum(a.cpVolRatio) ? a.cpVolRatio.toFixed(2) : (a.cpVolRatio === Infinity ? '∞' : '—'))} ${kv('Vol/OI', isNum(a.volOIRatio) ? a.volOIRatio.toFixed(2) : '—')}
      ${kv('ATM IV', isNum(a.atmIV) ? (a.atmIV * 100).toFixed(0) + '%' : '—')} ${kv('GEX', gexTxt)}
      ${kv('Gamma flip', isNum(a.gammaFlip) ? '$' + a.gammaFlip : '—')} ${kv('Max pain', isNum(a.maxPain) ? '$' + a.maxPain : '—')}
      ${(sig.walls && (isNum(sig.walls.call) || isNum(sig.walls.put))) ? kv('Call/Put wall', `${isNum(sig.walls.call) ? '$' + sig.walls.call : '—'} / ${isNum(sig.walls.put) ? '$' + sig.walls.put : '—'}`) : ''}
      ${isNum(sig.ivRank) ? kv('IV rank', sig.ivRank.toFixed(0) + (isNum(sig.ivPercentile) ? ` <span class="dim">(pctl ${sig.ivPercentile.toFixed(0)})</span>` : '')) : ''}
    </div>
    <div class="cov" style="margin-top:12px;flex-wrap:wrap;gap:10px">${availPill('greeks', 'Greeks')} ${availPill('iv', 'IV')} ${availPill('oi', 'OI')} ${availPill('quotes', 'Quotes')} ${availPill('underlying', 'Underlying')} ${availPill('sweeps', 'Sweeps')}</div>
    ${sigV2Html(sig)}
    <div class="disc" style="margin-top:12px">FINAL = options-weighted primary × data-quality × PVE-confirmation factor. Options/stock dominate; PVE only adjusts confidence and never reverses direction. Not a probability of profit. Not financial advice.</div>
  </div></div>`;

  // features table
  $('#optFeatures').innerHTML = tableHTML(['Feature', 'Avail', 'Dir', 'Strength', 'Weight', 'Value', 'Note'],
    (sig.features || []).map((f) => [esc(f.label), f.avail ? '<span class="bull">✓</span>' : '<span class="dim">—</span>', f.dir > 0 ? '<span class="bull">bull</span>' : f.dir < 0 ? '<span class="bear">bear</span>' : '<span class="dim">·</span>', num((f.strength * 100).toFixed(0) + '%'), num((f.weight * 100).toFixed(0) + '%'), num(isNum(f.value) ? (+f.value).toFixed(3) : '—'), `<span class="dim">${esc(f.note || '')}</span>`]),
    'No option features.');

  // chain table (top by volume)
  $('#optChain').innerHTML = tableHTML(['Type', 'Strike', 'Exp', 'Vol', 'OI', 'IV', 'Δ', 'Γ', 'Bid', 'Ask'],
    (ch.contracts || []).map((c) => [`<span class="${c.type === 'call' ? 'bull' : 'bear'}">${esc(c.type)}</span>`, num(c.strike), `<span class="dim">${esc(c.expiration || '')}</span>`, num(c.volume ?? '—'), num(c.openInterest ?? '—'), num(isNum(c.iv) ? (c.iv * 100).toFixed(0) + '%' : '—'), num(isNum(c.delta) ? c.delta.toFixed(2) : '—'), num(isNum(c.gamma) ? c.gamma.toFixed(3) : '—'), num(isNum(c.bid) ? c.bid.toFixed(2) : '—'), num(isNum(c.ask) ? c.ask.toFixed(2) : '—')]),
    'No contracts returned.');
}
function renderReplay() {
  const snaps = state.snapshots.slice().reverse();
  $('#rpMeta').textContent = `${snaps.length} captured snapshots · deterministic replay (no PVE call)`;
  const rows = snaps.map((s) => {
    let r = null; try { r = replaySignal(s.snapshot); } catch (e) { r = null; }
    const rep = r ? `${r.dir} · ${r.score} · ${r.tier}` : 'error';
    const match = r ? ((r.score === s.score && r.dir === s.dir) ? '<span class="bull">✓ identical</span>' : '<span class="bear">✗ differs</span>') : '<span class="bear">error</span>';
    return [num(hhmmss(s.ts)), `<b>${esc((s.ticker || s.slug || '').toUpperCase())}</b>`, `<span class="${s.dir === 'bull' ? 'bull' : 'bear'}">${s.dir}</span>`, num(s.score + ' · ' + (s.tier || '')), num(rep), match, `<span class="dim mono">${esc((s.snapshot && s.snapshot.engineVersion) || '')}</span>`];
  });
  $('#rpTable').innerHTML = tableHTML(['Time', 'Ticker', 'Dir', 'Stored', 'Replayed', 'Match', 'Engine'], rows, 'No snapshots captured yet — they record automatically as signals fire.');
}
async function renderHealth() {
  let mon = {}; try { mon = await api('/_monitor'); } catch (e) {}
  const c = state.classify || (mon && mon.classify) || {};
  const lastOk = (mon.logs || []).find((l) => !l.error && l.status === 200);
  const rows = [
    ['UW connection', state.connErr ? `<span class="bear">${esc(state.connErr)}</span>` : (state.liveAvailable ? '<span class="bull">reachable</span>' : '<span class="warn">no key</span>')],
    ['Live key configured', state.liveAvailable ? '<span class="bull">yes</span>' : '<span class="bear">no — LIVE only, no demo</span>'],
    ['Engine version', `<span class="mono">${esc((mon && mon.engineVersion) || ENGINE_VERSION)}</span>`],
    ['Classifier version', `<span class="mono">${esc((mon && mon.classifierVersion) || '')}</span>`],
    ['Markets received', c && isNum(c.received) ? num(c.received) : '—'],
    ['US-equity accepted', c && isNum(c.accepted) ? `<span class="bull">${c.accepted}</span>` : '—'],
    ['Rejected (non-equity)', c && isNum(c.rejected) ? num(c.rejected) : '—'],
    ['Last successful request', lastOk ? `${hhmmss(new Date(lastOk.ts).getTime())} <span class="dim">(${esc(lastOk.endpoint)}, ${lastOk.latencyMs}ms)</span>` : '—'],
    ['Last scan', state.lastScan ? hhmmss(state.lastScan) : '—'],
    ['Live signals', num(state.signals.size)],
  ];
  $('#healthTable').innerHTML = tableHTML(['Metric', 'Value'], rows, 'No data.');
  const br = (c && c.byReason) ? Object.entries(c.byReason) : [];
  $('#healthReasons').innerHTML = tableHTML(['Rejection reason', 'Count'], br.map(([k, v]) => [esc(k), num(v)]), 'No rejections recorded (or no markets received yet).');
}

// ---- PVE Smart Data (Explorer) — display-only; never feeds the signal engine ----
async function renderMonitor() {
  const m = await api('/_monitor');
  const c = m.classify || {};
  const mm = $('#monMeta');
  if (mm) mm.innerHTML = `<span class="mono">engine ${esc(m.engineVersion || '')}</span> · <span class="mono">classifier ${esc(m.classifierVersion || '')}</span> · markets received ${isNum(c.received) ? c.received : '—'} · <span class="bull">accepted ${isNum(c.accepted) ? c.accepted : '—'}</span> · rejected ${isNum(c.rejected) ? c.rejected : '—'} · source ${m.live ? '<span class="bull">LIVE</span>' : '<span class="warn">NO KEY</span>'} ${state.connErr ? '· <span class="bear">' + esc(state.connErr) + '</span>' : ''}`;
  $('#monTable').innerHTML = tableHTML(['Endpoint', 'Status', 'Latency', 'Recs', 'Mode', 'Time'],
    (m.logs || []).map((l) => [`<span class="mono">${esc(l.endpoint)}</span>`, `<span class="st ${l.error ? 'err' : l.status === 200 ? 'ok' : 'warn'}">${l.error ? 'ERR' : l.status}</span>`, num(l.latencyMs + 'ms'), num(l.records), `<span class="dim">${l.mode}</span>`, num(hhmmss(new Date(l.ts).getTime()))]), 'No calls yet.');
  const sel = $('#monEndpoint'); const prev = sel.value;
  sel.innerHTML = (m.endpoints || []).map((e) => `<option>${esc(e)}</option>`).join('');
  if (prev && m.endpoints.includes(prev)) sel.value = prev; else if (m.endpoints[0]) state.ui.monEndpoint = m.endpoints[0];
  await renderInspect();
}
async function renderInspect() {
  const ep = $('#monEndpoint').value || state.ui.monEndpoint; if (!ep) { $('#monJson').textContent = 'no endpoint'; return; }
  const d = await api('/_inspect', { endpoint: ep });
  $('#monJson').textContent = JSON.stringify(state.ui.monView === 'normalized' ? (d.normalized ?? d) : (d.raw ?? d), null, 2);
}

// ---- API Configuration panel (status only — never displays/accepts secret values) ----
async function renderApiConfig() {
  let mon = {}, auth = {};
  try { mon = await api('/_monitor'); } catch (e) {}
  try { auth = await (await fetch('/auth/status')).json(); } catch (e) {}
  const op = mon.optionsProvider || {};
  const yn = (b) => b ? '<span class="bull">yes</span>' : '<span class="bear">no</span>';
  if ($('#apiMeta')) $('#apiMeta').textContent = `engine ${mon.engineVersion || ''} · classifier ${mon.classifierVersion || ''} · options ${mon.optionsEngineVersion || ''}`;
  $('#apiStatus').innerHTML = tableHTML(['Setting', 'Value'], [
    ['PVE base URL', `<span class="mono">${esc(mon.baseUrl || auth.baseUrl || '—')}</span>`],
    ['PVE_AGENT_KEY', mon.live ? '<span class="bull">SET (live)</span>' : '<span class="bear">NOT SET</span>'],
    ['PVE authenticated (this session)', yn(!!auth.authed)],
    ['Options provider', `<span class="mono">${esc(op.provider || 'null')}</span>`],
    ['OPTIONS_API_KEY', op.configured ? '<span class="bull">SET</span>' : '<span class="bear">NOT SET</span>'],
    ['Options base URL', `<span class="mono">${esc(op.baseUrl || '—')}</span>`],
    ['AI layer (OpenRouter)', (mon.ai && mon.ai.configured) ? `<span class="bull">configured</span> · <span class="mono">${esc(mon.ai.model || '')}</span>` : '<span class="bear">not configured</span>'],
  ], '—');
  const envRow = (k, desc, set) => [`<span class="mono">${k}</span>`, esc(desc), set === null ? '<span class="dim">—</span>' : (set ? '<span class="bull">set</span>' : '<span class="bear">not set</span>')];
  $('#apiEnv').innerHTML = tableHTML(['Variable', 'Purpose', 'Status'], [
    envRow('PVE_AGENT_KEY', 'PVE agent API key — prediction-market data & confirmation', !!mon.live),
    envRow('DASHBOARD_PASSWORD', 'Login password for this dashboard', null),
    envRow('OPTIONS_PROVIDER', 'Real options vendor: pve | null', !!(op.provider && op.provider !== 'null')),
    envRow('UNUSUAL_WHALES_API_TOKEN', 'Unusual Whales API token (server-side; never sent to the browser)', !!op.configured),
    envRow('OPENROUTER_API_KEY', 'Advisory AI layer (OpenRouter) — optional, server-side', !!(mon.ai && mon.ai.configured)),
    envRow('OPENROUTER_MODEL', 'AI model slug (e.g. openai/gpt-4o-mini)', !!(mon.ai && mon.ai.model)),
    envRow('OPTIONS_BASE_URL', 'Override vendor base URL (optional)', null),
    envRow('US_EQUITY_TICKERS', 'Extend allowed tickers (optional, comma-separated)', null),
  ], '—') + '<div class="dim" style="padding:8px 12px;font-size:11px">Add / remove on the server: <span class="mono">nano /opt/pve-signal-engine/.env</span> then <span class="mono">sudo systemctl restart pve</span>. Secret values are never shown here or sent to the browser.</div>';
  const eps = [
    ['GET', '/auth/status', null], ['GET', '/api/_monitor', null],
    ['GET', '/api/options/AAPL', null], ['GET', '/api/signals/us?limit=5', null],
    ['GET', '/api/journal/list?limit=5', null], ['GET', '/api/journal/stats', null],
    ['GET', '/api/journal/evaluation', null], ['GET', '/api/research/readiness', null],
    ['GET', '/api/scan/status', null], ['GET', '/api/journal/resolve/status', null],
  ];
  $('#apiEndpoints').innerHTML = tableHTML(['Method', 'Endpoint', 'Test', 'Result'],
    eps.map(([m, p, note], i) => [
      `<span class="mono">${m}</span>`, `<span class="mono">${esc(p)}</span>`,
      note ? `<span class="dim">${esc(note)}</span>` : `<button class="btn ghost" data-ep="${esc(p)}" data-i="${i}" style="padding:2px 8px">Test</button>`,
      `<span class="dim" id="epr_${i}">—</span>`,
    ]), '—');
  $$('[data-ep]').forEach((b) => b.onclick = async () => {
    const p = b.dataset.ep, i = b.dataset.i; const cell = $('#epr_' + i); cell.textContent = '…';
    const t = performance.now();
    try {
      const r = await fetch(p); const ms = Math.round(performance.now() - t);
      let ok; try { const j = await r.clone().json(); ok = (j.ok !== false); } catch { ok = r.ok; }
      cell.innerHTML = `<span class="${r.ok ? (ok ? 'bull' : 'warn') : 'bear'}">${r.status}</span> <span class="dim">${ms}ms</span>`;
    } catch (e) { cell.innerHTML = `<span class="bear">ERR</span> <span class="dim">${esc(e.message)}</span>`; }
  });
}

// ---- AI Analysis (advisory) — clearly separated from the deterministic Signal Score ----
// ---- Phase 1 shadow features (research; never affects the live score) ----
function shadowClass(label) { return label === 'bullish' || label === 'bull' ? 'bull' : (label === 'bearish' || label === 'bear' ? 'bear' : 'dim'); }
function shadowPct(x) { return typeof x === 'number' && isFinite(x) ? (x * 100).toFixed(1) + '%' : '—'; }
function shadowNum(x, d = 0) { return typeof x === 'number' && isFinite(x) ? x.toFixed(d) : '—'; }
// =====================================================================
//  US OPTIONS SIGNALS (ranked scan table: production + shadow)
// =====================================================================
const SIG = { rows: [], meta: null, thr: 0, side: null, q: '', sortKey: 'productionScore', sortDir: -1 };
const sigNum = (x) => (isNum(x) ? x : null);
const sigCell = (x, d = '—') => (x == null || x === '' ? d : esc(x));
function sigScoreClass(s) { return !isNum(s) ? 'dim' : s >= 80 ? 'bull' : s >= 65 ? 'bull' : s >= 50 ? '' : s >= 35 ? 'dim' : 'bear'; }
function sigSignalHtml(sig) { if (sig === 'CALL') return '<b class="bull">CALL</b>'; if (sig === 'PUT') return '<b class="bear">PUT</b>'; if (sig === 'WATCH') return '<span class="dim">WATCH</span>'; return '<span class="dim">—</span>'; }
function openTickerOptions(t) { if ($('#optTicker')) $('#optTicker').value = t; setTab('options'); }

function sigFiltered() {
  let rows = SIG.rows.filter((r) => isNum(r.productionScore));
  if (SIG.thr > 0) rows = rows.filter((r) => r.productionScore >= SIG.thr);
  if (SIG.side === 'bull') rows = rows.filter((r) => r.dir === 'bull');
  if (SIG.side === 'bear') rows = rows.filter((r) => r.dir === 'bear');
  if (SIG.q) rows = rows.filter((r) => String(r.ticker).includes(SIG.q));
  const k = SIG.sortKey, dir = SIG.sortDir;
  rows.sort((a, b) => { const x = a[k], y = b[k]; if (!isNum(x) && !isNum(y)) return 0; if (!isNum(x)) return 1; if (!isNum(y)) return -1; return (x - y) * dir; });
  return rows;
}
function renderSigTable() {
  const rows = sigFiltered();
  const cols = [
    ['ticker', 'Ticker', 'left'], ['productionScore', 'Prod', 'r'], ['shadowScore', 'Shadow', 'r'], ['scoreDelta', 'Δ', 'r'],
    ['engineAgreement', 'Agree', 'left'], ['signal', 'Signal', 'left'], ['marketBias', 'Bias', 'left'], ['confidence', 'Conf', 'r'],
    ['price', 'Price', 'r'], ['changePct', 'Chg%', 'r'], ['vsVwapPct', 'vs VWAP', 'r'], ['ivRank', 'IVR', 'r'], ['optionsLiquidity', 'Liq', 'left'], ['sector', 'Sector', 'left'],
  ];
  const arrow = (k) => (SIG.sortKey === k ? (SIG.sortDir === -1 ? ' ▾' : ' ▴') : '');
  const th = cols.map(([k, label, a]) => `<th data-sortk="${k}" style="text-align:${a === 'r' ? 'right' : 'left'};cursor:pointer;padding:6px 10px;white-space:nowrap;border-bottom:1px solid rgba(255,255,255,.12);font-size:11px;color:#9aa" >${esc(label)}${arrow(k)}</th>`).join('');
  const agreeCls = (a) => (a === 'HIGH' ? 'bull' : a === 'DIVERGENCE' ? 'bear' : a === 'INSUFFICIENT' ? 'dim' : '');
  const biasCls = (b) => (b === 'STRONG' || b === 'BULLISH' ? 'bull' : b === 'BEARISH' ? 'bear' : b === 'AVOID' ? 'bear' : 'dim');
  const body = rows.map((r, i) => {
    const chg = isNum(r.changePct) ? `<span class="${r.changePct >= 0 ? 'bull' : 'bear'}">${r.changePct >= 0 ? '+' : ''}${r.changePct}%</span>` : '—';
    const delta = isNum(r.scoreDelta) ? `<span class="${r.scoreDelta > 0 ? 'bull' : r.scoreDelta < 0 ? 'bear' : 'dim'}">${r.scoreDelta > 0 ? '+' : ''}${r.scoreDelta}</span>` : '—';
    return `<tr data-tkr="${esc(r.ticker)}" style="--i:${i};cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05)">
      <td style="padding:6px 10px;font-weight:600">${esc(r.ticker)}</td>
      <td style="padding:6px 10px;text-align:right"><b class="${sigScoreClass(r.productionScore)}${r.productionScore >= 80 ? ' score-hi' : ''}" data-count="${r.productionScore}">${sigCell(r.productionScore)}</b></td>
      <td style="padding:6px 10px;text-align:right" class="dim">${sigCell(r.shadowScore)}</td>
      <td style="padding:6px 10px;text-align:right">${delta}</td>
      <td style="padding:6px 10px" class="${agreeCls(r.engineAgreement)}" >${sigCell(r.engineAgreement)}</td>
      <td style="padding:6px 10px">${sigSignalHtml(r.signal)}</td>
      <td style="padding:6px 10px"><span class="${biasCls(r.marketBias)}">${sigCell(r.marketBias)}</span></td>
      <td style="padding:6px 10px;text-align:right" class="dim">${sigCell(r.confidence)}</td>
      <td style="padding:6px 10px;text-align:right">${isNum(r.price) ? '$' + r.price.toFixed(2) : '—'}</td>
      <td style="padding:6px 10px;text-align:right">${chg}</td>
      <td style="padding:6px 10px;text-align:right">${isNum(r.vsVwapPct) ? `<span class="${r.vsVwapPct >= 0 ? 'bull' : 'bear'}">${r.vsVwapPct >= 0 ? '+' : ''}${r.vsVwapPct}%</span>` : '<span class="dim">—</span>'}</td>
      <td style="padding:6px 10px;text-align:right" class="dim">${sigCell(r.ivRank)}</td>
      <td style="padding:6px 10px" class="dim">${sigCell(r.optionsLiquidity)}</td>
      <td style="padding:6px 10px" class="dim">${sigCell(r.sector)}</td>
    </tr>`;
  }).join('');
  $('#sigTable').innerHTML = rows.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:12.5px"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`
    : '<div class="dim" style="padding:24px;text-align:center">No signals match the current filters.</div>';
  animateCounts($('#sigTable'));
  $$('#sigTable th[data-sortk]').forEach((h) => h.onclick = () => { const k = h.dataset.sortk; if (SIG.sortKey === k) SIG.sortDir *= -1; else { SIG.sortKey = k; SIG.sortDir = (k === 'ticker' ? 1 : -1); } renderSigTable(); });
  $$('#sigTable tr[data-tkr]').forEach((tr) => tr.onclick = () => openTickerOptions(tr.dataset.tkr));
}
// ===== Claude Review (research archive UI — read-only) =====
const JR = { view: 'dash', offset: 0, limit: 50, total: 0 };
let JR_POLL = null;
function jrSet(v) { JR.view = v; $$('[data-jr]').forEach((c) => c.classList.toggle('on', c.dataset.jr === v)); if (v === 'dash') renderJrDash(); else if (v === 'signals') renderJrSignals(); else if (v === 'eval') renderJrEval(); else if (v === 'ready') renderJrReady(); else renderJrLearning(); }
async function renderJournal() { jrSet(JR.view); }
const jrPct = (v) => (isNum(v) ? `<span class="${v >= 0 ? 'bull' : 'bear'}">${v >= 0 ? '+' : ''}${v}%</span>` : '<span class="dim">—</span>');

async function renderJrDash() {
  const b = $('#jrBody'); b.innerHTML = '<div class="dim mono">loading…</div>';
  const r = await (await fetch('/api/journal/stats', { credentials: 'include' })).json();
  if (!r.ok) { b.innerHTML = `<div class="dim">${esc(r.error || 'unavailable')}</div>`; return; }
  const L = r.learning, T = L.totals;
  $('#jrMeta').textContent = `${T.signals} signals · ${T.resolved} resolved · ${r.pending} pending`;
  const card = (l, v, cl) => `<div class="kpi"><div class="l">${l}</div><div class="n ${cl || ''}">${v}</div></div>`;
  b.innerHTML = `<div class="kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:14px">
      ${card('TOTAL SIGNALS', T.signals)}${card('WINNERS', T.winners, 'bull')}${card('LOSERS', T.losers, 'bear')}
      ${card('WIN RATE', isNum(L.winRate) ? L.winRate + '%' : '—')}
      ${card('AVG 30M', isNum(L.avg30mReturn) ? L.avg30mReturn + '%' : '—', L.avg30mReturn >= 0 ? 'bull' : 'bear')}
      ${card('AVG 1H', isNum(L.avg1hReturn) ? L.avg1hReturn + '%' : '—', L.avg1hReturn >= 0 ? 'bull' : 'bear')}
      ${card('BEST FACTOR', L.bestFactor ? esc(L.bestFactor.label) : '—')}${card('WORST FACTOR', L.worstFactor ? esc(L.worstFactor.label) : '—')}</div>
    ${T.resolved === 0 ? '<div class="dim" style="padding:10px;border:1px solid var(--line);border-radius:8px">No resolved outcomes yet. Signals resolve 30 minutes after they fire — press <b>Resolve Outcomes</b> once some have aged.</div>' : ''}
    <div class="dim mono" style="font-size:11px;margin-top:8px">${esc(L.note)}</div>`;
}

async function renderJrSignals() {
  const b = $('#jrBody'); b.innerHTML = '<div class="dim mono">loading…</div>';
  const q = new URLSearchParams({ offset: JR.offset, limit: JR.limit, sort: 'newest' });
  const r = await (await fetch('/api/journal/list?' + q, { credentials: 'include' })).json();
  if (!r.ok) { b.innerHTML = `<div class="dim">${esc(r.error || 'unavailable')}</div>`; return; }
  JR.total = r.total;
  if (!r.rows.length) { b.innerHTML = '<div class="dim" style="padding:10px">No journaled signals yet. Any signal scoring 70+ is recorded automatically.</div>'; return; }
  const st = (s) => s === 'WIN' ? '<span class="bull">WIN</span>' : s === 'LOSS' ? '<span class="bear">LOSS</span>' : `<span class="dim">${s}</span>`;
  b.innerHTML = `<div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px" id="jrTable">
    <thead><tr class="dim" style="text-align:left">
      <th style="padding:6px 10px">TICKER</th><th style="padding:6px 10px">TIME</th><th style="padding:6px 10px">DIR</th>
      <th style="padding:6px 10px;text-align:right">SCORE</th><th style="padding:6px 10px;text-align:right">SHADOW</th>
      <th style="padding:6px 10px;text-align:right">30M</th><th style="padding:6px 10px;text-align:right">60M</th><th style="padding:6px 10px">STATUS</th></tr></thead>
    <tbody>${r.rows.map((x) => `<tr data-id="${esc(x.id)}" style="border-top:1px solid var(--line);cursor:pointer">
      <td style="padding:6px 10px"><b>${esc(x.ticker)}</b></td>
      <td style="padding:6px 10px" class="dim mono">${esc(new Date(x.firedAt).toLocaleString())}</td>
      <td style="padding:6px 10px"><span class="${x.dir === 'bull' ? 'bull' : 'bear'}">${esc(x.signal)}</span></td>
      <td style="padding:6px 10px;text-align:right"><b>${x.score}</b></td>
      <td style="padding:6px 10px;text-align:right" class="dim">${isNum(x.shadowScore) ? x.shadowScore : '—'}</td>
      <td style="padding:6px 10px;text-align:right">${jrPct(x.r30m)}</td>
      <td style="padding:6px 10px;text-align:right">${jrPct(x.r1h)}</td>
      <td style="padding:6px 10px">${st(x.status)}</td></tr>`).join('')}</tbody></table></div>
    <div class="row" style="gap:10px;align-items:center;margin-top:10px" id="jrPager"></div>`;
  $$('#jrTable tr[data-id]').forEach((tr) => tr.onclick = () => openJrDetail(tr.dataset.id));
  const from = r.total ? JR.offset + 1 : 0, to = JR.offset + r.rows.length;
  $('#jrPager').innerHTML = `<button class="btn ghost" id="jrPrev" ${JR.offset <= 0 ? 'disabled' : ''}>‹ Prev</button><span class="dim mono">${from}–${to} of ${r.total}</span><button class="btn ghost" id="jrNext" ${to >= r.total ? 'disabled' : ''}>Next ›</button>`;
  if ($('#jrPrev')) $('#jrPrev').onclick = () => { JR.offset = Math.max(0, JR.offset - JR.limit); renderJrSignals(); };
  if ($('#jrNext')) $('#jrNext').onclick = () => { JR.offset += JR.limit; renderJrSignals(); };
}

async function openJrDetail(id) {
  const r = await (await fetch('/api/journal/signal/' + encodeURIComponent(id), { credentials: 'include' })).json();
  if (!r.ok) return;
  const s = r.signal, ex = s.explain || {}, pa = s.postAnalysis, en = s.entry || {}, oc = s.outcomes || {};
  const li = (xs) => (xs && xs.length ? '<ul style="margin:4px 0 0 16px;padding:0">' + xs.map((x) => `<li>${esc(typeof x === 'string' ? x : (x.label || x.note || JSON.stringify(x)))}</li>`).join('') + '</ul>' : '<div class="dim">none</div>');
  const fRow = (f) => `<tr style="border-top:1px solid var(--line)"><td style="padding:4px 8px">${esc(f.label)}</td><td style="padding:4px 8px;text-align:right">${f.strength}</td><td style="padding:4px 8px;text-align:right">${f.contribution ?? '—'}</td><td style="padding:4px 8px">${f.directional ? (f.agrees ? '<span class="bull">agrees</span>' : '<span class="bear">conflicts</span>') : '<span class="dim">confirming</span>'}</td></tr>`;
  const ocBlock = (h) => { const o = oc[h]; if (!o || o.status !== 'resolved') return `<div class="dim">${h}: ${o ? esc(o.status) : 'pending'}</div>`;
    return `<div><b>${h}</b> · stock ${o.stockPrice} (${jrPct(o.stockChangePct)}) · option ${o.optionPrice ?? '—'} (${jrPct(o.optionChangePct)}) · max favorable ${jrPct(o.maxFavorablePct)} · max adverse ${jrPct(o.maxAdversePct)}</div>`; };
  $('#sheet').innerHTML = `<button class="x" id="closeModal">✕</button>
    <h3 style="margin:0 0 2px">${esc(s.ticker)} <span class="${s.composite.dir === 'bull' ? 'bull' : 'bear'}">${s.composite.dir === 'bull' ? 'CALL' : 'PUT'}</span> · ${s.composite.finalScore}</h3>
    <div class="dim mono" style="font-size:11px;margin-bottom:10px">${esc(new Date(s.firedAt).toLocaleString())} · ${esc(s.id)}</div>
    <h4 style="margin:10px 0 4px">Why this call was generated</h4>
    <div style="font-size:12.5px">${esc(ex.summary || '—')}</div>
    <div class="dim" style="font-size:12px;margin-top:6px">${esc(ex.whyScoreReached || '')}</div>
    <h4 style="margin:12px 0 4px">Factors</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr class="dim" style="text-align:left"><th style="padding:4px 8px">FACTOR</th><th style="padding:4px 8px;text-align:right">STRENGTH</th><th style="padding:4px 8px;text-align:right">CONTRIB</th><th style="padding:4px 8px">ROLE</th></tr></thead>
    <tbody>${[...(ex.strongestFactors || []), ...(ex.conflictingFactors || [])].filter((v, i, a) => a.findIndex((z) => z.key === v.key) === i).map(fRow).join('')}</tbody></table>
    <div style="font-size:12px;margin-top:8px"><b>Options flow:</b> ${esc(ex.optionsFlowReasoning || '—')}</div>
    <div style="font-size:12px"><b>Stock confirmation:</b> ${esc(ex.stockConfirmation || '—')}</div>
    <div style="font-size:12px"><b>Momentum:</b> ${esc(ex.momentumConfirmation || '—')}</div>
    <h4 style="margin:12px 0 4px">Reason codes</h4>
    ${(s.reasons && s.reasons.length) ? s.reasons.map((rc) => `<div style="font-size:12px"><span class="mono ${/CONFLICT|RISK|LOW_|NOT_CONFIRMED/.test(rc.code) ? 'bear' : 'bull'}">${esc(rc.code)}</span> <span class="dim">${esc(rc.explanation)}</span></div>`).join('') : '<div class="dim">none</div>'}
    <h4 style="margin:12px 0 4px">Risks / warnings at signal time</h4>${li(ex.risks)}
    <h4 style="margin:12px 0 4px">Entry (captured at signal time)</h4>
    <div style="font-size:12.5px">stock ${en.stockPrice ?? '—'} · option ${en.optionPrice ?? '—'} · vs VWAP ${isNum(en.vsVwapPct) ? en.vsVwapPct + '%' : '—'} · day ${isNum(en.changePct) ? en.changePct + '%' : '—'}</div>
    <h4 style="margin:12px 0 4px">Outcomes</h4>${ocBlock('15m')}${ocBlock('30m')}${ocBlock('60m')}${ocBlock('close')}
    <h4 style="margin:12px 0 4px">${pa ? (pa.verdict === 'WIN' ? 'Why it won' : 'Why it lost') : 'Post-trade analysis'}</h4>
    ${!pa ? '<div class="dim">Not yet resolved.</div>' : (pa.verdict === 'WIN'
      ? `<div style="font-size:12.5px">Return ${jrPct(pa.directionalReturnPct)} · top contributor: <b>${esc(pa.topContributor ? pa.topContributor.label : '—')}</b></div>${li(pa.whatConfirmed)}${pa.notes ? `<div class="dim" style="font-size:12px;margin-top:4px">${esc(pa.notes)}</div>` : ''}`
      : `<div style="font-size:12.5px">Return ${jrPct(pa.directionalReturnPct)}</div>
         <div style="font-size:12px;margin-top:6px"><b>Likely reason:</b> ${esc(pa.likelyReason)}</div>
         <div style="font-size:12px;margin-top:6px"><b>Factors that failed:</b></div>${li(pa.wrongAssumptions)}
         <div style="font-size:12px;margin-top:6px"><b>Warnings that were present:</b></div>${li(pa.missedWarnings)}
         ${pa.stockOptionsDisagreed ? '<div class="bear" style="font-size:12px;margin-top:6px">Stock and options data disagreed at entry.</div>' : ''}`)}
    <div class="dim mono" style="font-size:10px;margin-top:12px">Original signal data is immutable; outcomes are stored as separate append-only patches.</div>`;
  $('#modal').classList.add('on');
  $('#closeModal').onclick = () => $('#modal').classList.remove('on');
}

async function renderJrLearning() {
  const b = $('#jrBody'); b.innerHTML = '<div class="dim mono">loading…</div>';
  const r = await (await fetch('/api/journal/stats', { credentials: 'include' })).json();
  if (!r.ok) { b.innerHTML = `<div class="dim">${esc(r.error || 'unavailable')}</div>`; return; }
  const L = r.learning;
  const bucket = (x) => `<tr style="border-top:1px solid var(--line)"><td style="padding:4px 8px">${esc(x.range)}</td><td style="padding:4px 8px;text-align:right">${x.n}</td><td style="padding:4px 8px;text-align:right">${isNum(x.winRate) ? x.winRate + '%' : '—'}</td><td style="padding:4px 8px;text-align:right">${jrPct(x.avgReturn)}</td><td style="padding:4px 8px">${x.gated ? '<span class="dim">low sample</span>' : ''}</td></tr>`;
  const fac = (x) => `<tr style="border-top:1px solid var(--line)"><td style="padding:4px 8px">${esc(x.label)}</td><td style="padding:4px 8px;text-align:right">${x.n}</td><td style="padding:4px 8px;text-align:right">${isNum(x.winRate) ? x.winRate + '%' : '—'}</td><td style="padding:4px 8px;text-align:right">${jrPct(x.avgReturn)}</td><td style="padding:4px 8px">${x.gated ? '<span class="dim">low sample</span>' : ''}</td></tr>`;
  b.innerHTML = `<h4 style="margin:4px 0">Win rate by score range</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr class="dim" style="text-align:left"><th style="padding:4px 8px">RANGE</th><th style="padding:4px 8px;text-align:right">N</th><th style="padding:4px 8px;text-align:right">WIN%</th><th style="padding:4px 8px;text-align:right">AVG RET</th><th></th></tr></thead><tbody>${L.scoreBuckets.map(bucket).join('')}</tbody></table>
    <h4 style="margin:14px 0 4px">Factor performance</h4>
    ${L.factorPerformance.length ? `<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr class="dim" style="text-align:left"><th style="padding:4px 8px">FACTOR</th><th style="padding:4px 8px;text-align:right">N</th><th style="padding:4px 8px;text-align:right">WIN%</th><th style="padding:4px 8px;text-align:right">AVG RET</th><th></th></tr></thead><tbody>${L.factorPerformance.map(fac).join('')}</tbody></table>` : '<div class="dim">No resolved outcomes yet.</div>'}
    <h4 style="margin:14px 0 4px">Winning vs losing characteristics</h4>
    <div style="font-size:12.5px">${L.bestCharacteristics ? `<div><b>Winners:</b> avg score ${L.bestCharacteristics.avgScore}, avg options ${L.bestCharacteristics.avgOptionsScore}, stock-confirmed ${L.bestCharacteristics.stockConfirmRate}%</div>` : '<div class="dim">no winners yet</div>'}
    ${L.worstCharacteristics ? `<div><b>Losers:</b> avg score ${L.worstCharacteristics.avgScore}, avg options ${L.worstCharacteristics.avgOptionsScore}, stock-confirmed ${L.worstCharacteristics.stockConfirmRate}%</div>` : '<div class="dim">no losers yet</div>'}</div>
    <div class="dim mono" style="font-size:11px;margin-top:12px">${esc(L.note)}</div>`;
}


// v2 shadow scorer panel (spec phases 2-5). Advisory only — production score is unchanged.
function sigV2Html(sig) {
  const v = sig && sig.v2;
  if (!v || v.error || !isNum(v.score)) return '';
  const st = esc(v.state || '—');
  const cls = /STRONG_BULL|^BULL/.test(v.state) ? 'bull' : /BEAR/.test(v.state) ? 'bear' : 'dim';
  const comp = v.components || {};
  const bar = (k, val) => `<div style="display:flex;align-items:center;gap:6px;font-size:11.5px"><span class="dim" style="width:56px">${k}</span><span style="flex:1;height:5px;background:var(--line);border-radius:3px;overflow:hidden"><span style="display:block;height:100%;width:${isNum(val) ? Math.max(0, Math.min(100, val)) : 0}%;background:${isNum(val) ? 'var(--acc)' : 'transparent'}"></span></span><span class="mono" style="width:34px;text-align:right">${isNum(val) ? Math.round(val) : '—'}</span></div>`;
  return `<div style="margin-top:14px;border:1px solid var(--line);border-radius:8px;padding:10px">
    <div class="row" style="align-items:center;gap:8px"><b style="font-size:12.5px">v2 SHADOW SCORER</b>
      <span class="k">research</span><span class="dim mono" style="font-size:10px">${esc(v.version || '')}</span>
      <span style="margin-left:auto"><span class="${cls}"><b>${st}</b></span> <b>${v.score}</b>${v.gated ? ' <span class="bear">GATED</span>' : ''}</span></div>
    <div style="margin-top:8px;display:grid;gap:3px">${['flow','price','gamma','market','context'].map((k) => bar(k, comp[k])).join('')}</div>
    <div class="dim mono" style="font-size:10.5px;margin-top:6px">coverage ${v.coverage ?? '—'}% · combined multiplier ${v.multipliers ? v.multipliers.combined : '—'}${v.multipliers && v.multipliers.capped ? ' (capped)' : ''}${v.actionable ? ' · actionable' : ' · not actionable'}</div>
    ${(v.reasons && v.reasons.length) ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">${v.reasons.map((r) => `<span class="mono ${/CONFLICT|RISK|LOW_|GATED|NOT_CONFIRMED/.test(r.code) ? 'bear' : 'bull'}" style="font-size:10px;border:1px solid var(--line);border-radius:4px;padding:1px 5px" title="${esc(r.explanation || '')}">${esc(r.code)}</span>`).join('')}</div>` : ''}
    ${(v.quality && v.quality.flags && v.quality.flags.length) ? `<div class="dim mono" style="font-size:10px;margin-top:5px">data gaps: ${v.quality.flags.map(esc).join(', ')}</div>` : ''}
    <div class="dim" style="font-size:10.5px;margin-top:6px">${esc(v.note || '')}</div></div>`;
}

async function renderJrEval() {
  const b = $('#jrBody'); b.innerHTML = '<div class="dim mono">computing…</div>';
  const r = await (await fetch('/api/journal/evaluation', { credentials: 'include' })).json();
  if (!r.ok) { b.innerHTML = `<div class="dim">${esc(r.error || 'unavailable')}</div>`; return; }
  const R = r.report, H = R.byHorizon;
  const g = (x) => (x && x.gated ? ' <span class="dim">(low sample)</span>' : '');
  const hRow = (k) => { const h = H[k]; if (!h) return ''; return `<tr style="border-top:1px solid var(--line)">
    <td style="padding:4px 8px"><b>${k}</b></td><td style="padding:4px 8px;text-align:right">${h.n}</td>
    <td style="padding:4px 8px;text-align:right">${isNum(h.hitRate) ? h.hitRate + '%' : '—'}</td>
    <td style="padding:4px 8px;text-align:right">${jrPct(h.avgReturn)}</td>
    <td style="padding:4px 8px;text-align:right">${h.rankIC.ic ?? '—'}${g(h.rankIC)}</td>
    <td style="padding:4px 8px;text-align:right">${h.v2RankIC ? (h.v2RankIC.ic ?? '—') : '—'}</td>
    <td style="padding:4px 8px;text-align:right">${isNum(h.topDecile.precision) ? h.topDecile.precision + '%' : '—'}</td>
    <td style="padding:4px 8px;text-align:right">${jrPct(h.avgMFE)}</td><td style="padding:4px 8px;text-align:right">${jrPct(h.avgMAE)}</td></tr>`; };
  const grp = (rows) => rows.length ? `<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr class="dim" style="text-align:left"><th style="padding:4px 8px">GROUP</th><th style="padding:4px 8px;text-align:right">N</th><th style="padding:4px 8px;text-align:right">HIT%</th><th style="padding:4px 8px;text-align:right">AVG RET</th><th style="padding:4px 8px;text-align:right">MFE</th><th style="padding:4px 8px;text-align:right">MAE</th></tr></thead><tbody>${rows.map((x) => `<tr style="border-top:1px solid var(--line)"><td style="padding:4px 8px">${esc(String(x.key))}${g(x)}</td><td style="padding:4px 8px;text-align:right">${x.n}</td><td style="padding:4px 8px;text-align:right">${isNum(x.hitRate) ? x.hitRate + '%' : '—'}</td><td style="padding:4px 8px;text-align:right">${jrPct(x.avgReturn)}</td><td style="padding:4px 8px;text-align:right">${jrPct(x.avgMFE)}</td><td style="padding:4px 8px;text-align:right">${jrPct(x.avgMAE)}</td></tr>`).join('')}</tbody></table>` : '<div class="dim">no data yet</div>';
  const cal = (H['30m'] ? H['30m'].calibration : []).map((c) => `<tr style="border-top:1px solid var(--line)"><td style="padding:4px 8px">${esc(c.range)}${g(c)}</td><td style="padding:4px 8px;text-align:right">${c.n}</td><td style="padding:4px 8px;text-align:right">${isNum(c.hitRate) ? c.hitRate + '%' : '—'}</td><td style="padding:4px 8px;text-align:right">${jrPct(c.avgReturn)}</td></tr>`).join('');
  b.innerHTML = `<div class="dim mono" style="font-size:11px;margin-bottom:8px">${R.totals.evaluated} evaluated of ${R.totals.signals} signals · ${R.totals.bullish} bull / ${R.totals.bearish} bear</div>
    <h4 style="margin:4px 0">By horizon</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr class="dim" style="text-align:left"><th style="padding:4px 8px">HORIZON</th><th style="padding:4px 8px;text-align:right">N</th><th style="padding:4px 8px;text-align:right">HIT%</th><th style="padding:4px 8px;text-align:right">AVG RET</th><th style="padding:4px 8px;text-align:right">RANK IC</th><th style="padding:4px 8px;text-align:right">v2 IC</th><th style="padding:4px 8px;text-align:right">TOP DEC</th><th style="padding:4px 8px;text-align:right">MFE</th><th style="padding:4px 8px;text-align:right">MAE</th></tr></thead><tbody>${['15m','30m','60m','close'].map(hRow).join('')}</tbody></table>
    <h4 style="margin:14px 0 4px">Score calibration (30m)</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr class="dim" style="text-align:left"><th style="padding:4px 8px">SCORE</th><th style="padding:4px 8px;text-align:right">N</th><th style="padding:4px 8px;text-align:right">HIT%</th><th style="padding:4px 8px;text-align:right">AVG RET</th></tr></thead><tbody>${cal}</tbody></table>
    <h4 style="margin:14px 0 4px">By v2 state</h4>${grp(R.byV2State || [])}
    <h4 style="margin:14px 0 4px">By gamma regime</h4>${grp(R.byGammaRegime)}
    <h4 style="margin:14px 0 4px">By time of day</h4>${grp(R.byTimeOfDay)}
    <h4 style="margin:14px 0 4px">By ticker</h4>${grp(R.byTicker)}
    <div class="dim mono" style="font-size:11px;margin-top:12px">${esc(R.note)}</div>`;
}

async function renderJrReady() {
  const b = $('#jrBody'); b.innerHTML = '<div class="dim mono">loading…</div>';
  const r = await (await fetch('/api/research/readiness', { credentials: 'include' })).json();
  if (!r.ok) { b.innerHTML = `<div class="dim">${esc(r.error || 'unavailable')}</div>`; return; }
  const R = r.readiness, uw = r.uw || {};
  const stateCls = (s) => s === 'READY' ? 'bull' : s === 'WARMING_UP' ? '' : 'bear';
  const row = (l, v) => `<tr style="border-top:1px solid var(--line)"><td style="padding:4px 8px" class="dim">${l}</td><td style="padding:4px 8px;text-align:right">${v}</td></tr>`;
  const num = (v, suf = '') => (isNum(v) ? v + suf : '<span class="dim">—</span>');
  const gate = R.gate || { checks: [] };
  b.innerHTML = `<h4 style="margin:4px 0">V2 RESEARCH STATUS</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px"><tbody>
      ${row('Signals journaled', R.signals)}
      ${row('Resolved 15m', R.resolved['15m'])}${row('Resolved 30m', R.resolved['30m'])}${row('Resolved 60m', R.resolved['60m'])}${row('Resolved close', R.resolved.close)}
      ${row('RVOL', `<span class="${stateCls(R.features.rvol)}">${esc(R.features.rvol)}</span>`)}
      ${row('IV SKEW', `<span class="${stateCls(R.features.ivSkew)}">${esc(R.features.ivSkew)}</span>`)}
      ${row('SECTOR', `<span class="${stateCls(R.features.sector)}">${esc(R.features.sector)}</span>`)}
      ${row('MACRO', `<span class="${stateCls(R.features.macro)}">${esc(R.features.macro)}</span>`)}
      ${row('V1 Rank IC', num(R.metrics.v1RankIC))}${row('V2 Rank IC', num(R.metrics.v2RankIC))}
      ${row('V1 Top Decile', num(R.metrics.v1TopDecile, '%'))}${row('V2 Top Decile', num(R.metrics.v2TopDecile, '%'))}
      ${row('V2 STATUS', `<b>${esc(R.v2Status)}</b>`)}
      ${row('PROMOTION', `<b class="${R.promotion === 'NOT_READY' ? 'bear' : 'bull'}">${esc(R.promotion)}</b>`)}
    </tbody></table>
    <h4 style="margin:14px 0 4px">Promotion gate (${gate.passedCount}/${gate.totalChecks})</h4>
    ${gate.checks.map((c) => `<div style="font-size:12px"><span class="${c.passed ? 'bull' : 'bear'}">${c.passed ? '✓' : '✗'}</span> <span class="mono">${esc(c.name)}</span> <span class="dim">${esc(c.detail)}</span></div>`).join('')}
    <h4 style="margin:14px 0 4px">UW API</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px"><tbody>
      ${row('Provider', esc(uw.provider || '—') + (uw.keyMasked ? ` <span class="mono dim">${esc(uw.keyMasked)}</span>` : ''))}
      ${row('Requests this scan', num(uw.requestsThisScan))}${row('Requests total', num(uw.requestsTotal))}
      ${row('Per-minute used', `${num(uw.perMinuteUsed)} / ${num(uw.perMinuteLimit)}`)}
      ${row('UW quota remaining', uw.uwRemaining == null ? '<span class="dim">not exposed by UW</span>' : uw.uwRemaining)}
      ${row('Failed requests', num(uw.failures))}
    </tbody></table>
    <div class="dim mono" style="font-size:11px;margin-top:10px">data source: ${esc(R.dataSource)} · ${esc(R.note)}</div>
    <div class="dim mono" style="font-size:11px;margin-top:4px">${esc(gate.note || '')}</div>`;
}

async function jrResolve() {
  if (JR_POLL) return;
  const btn = $('#jrResolve'); btn.disabled = true; btn.textContent = 'Resolving…';
  $('#jrResolveStatus').textContent = 'fetching outcome data…';
  try {
    const r = await fetch('/api/journal/resolve', { method: 'POST', credentials: 'include' });
    const j = await r.json();
    if (!r.ok || !j.ok) { btn.disabled = false; btn.textContent = 'Resolve Outcomes'; $('#jrResolveStatus').textContent = j.error || 'could not start'; return; }
    JR_POLL = setInterval(async () => {
      const s = await (await fetch('/api/journal/resolve/status', { credentials: 'include' })).json();
      if (s.running) return;
      clearInterval(JR_POLL); JR_POLL = null; btn.disabled = false; btn.textContent = 'Resolve Outcomes';
      $('#jrResolveStatus').textContent = (s.lastOk ? 'done · ' : 'failed · ') + (s.message || '');
      jrSet(JR.view);
    }, 3000);
  } catch (e) { btn.disabled = false; btn.textContent = 'Resolve Outcomes'; $('#jrResolveStatus').textContent = 'error'; }
}

function renderSigTop() {
  const top = SIG.rows.filter((r) => isNum(r.productionScore)).sort((a, b) => b.productionScore - a.productionScore).slice(0, 5);
  if (!top.length) { $('#sigTop').innerHTML = ''; return; }
  $('#sigTop').innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap">' + top.map((r) => `<span class="chip" data-tkr="${esc(r.ticker)}" style="cursor:pointer">${esc(r.ticker)} <b class="${sigScoreClass(r.productionScore)}">${r.productionScore}</b> ${sigSignalHtml(r.signal)}</span>`).join('') + '</div>';
  $$('#sigTop [data-tkr]').forEach((c) => c.onclick = () => openTickerOptions(c.dataset.tkr));
}
async function renderSignals() {
  $('#sigStatus').textContent = 'loading signals…';
  if (!$('#sigTable').innerHTML) $('#sigTable').innerHTML = '<div class="loading" style="height:220px"></div>';
  let r; try { r = await api('/signals/us', { limit: 500 }); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) { $('#sigStatus').innerHTML = `<span class="bear">${esc((r && r.error) || 'unavailable')}</span>`; $('#sigTable').innerHTML = ''; $('#sigTop').innerHTML = ''; return; }
  if (!r.available) {
    $('#sigMeta').textContent = '';
    $('#sigStatus').innerHTML = `<span class="bear">${esc(r.dataStatus || 'DATA UNAVAILABLE')}</span> — ${esc(r.reason || 'no scan yet')}`;
    $('#sigTable').innerHTML = ''; $('#sigTop').innerHTML = ''; return;
  }
  SIG.rows = r.rows || []; SIG.meta = r;
  const age = isNum(r.ageSeconds) ? (r.ageSeconds < 90 ? r.ageSeconds + 's ago' : Math.round(r.ageSeconds / 60) + 'm ago') : '';
  $('#sigMeta').textContent = `${r.scored}/${r.count} scored · ${age}`;
  const statusCls = r.dataStatus === 'MARKET DATA LIVE' ? 'bull' : 'dim';
  $('#sigStatus').innerHTML = `<span class="${statusCls}">${esc(r.dataStatus)}</span> · updated ${esc(age)} · primary <b>${esc(r.primary)}</b> · ${r.promotedFeatures} promoted features · <span class="dim">${esc(r.note || '')}</span>`;
  renderSigTop(); renderSigTable();
}
async function renderValidated() {
  const ticker = (($('#optTicker') && $('#optTicker').value) || '').trim().toUpperCase();
  if (!ticker) return;
  $('#validatedStatus').textContent = 'computing validated score for ' + ticker + '…'; $('#validatedOut').innerHTML = '';
  let r; try { r = await api('/validated/' + encodeURIComponent(ticker)); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) { $('#validatedStatus').innerHTML = `<span class="bear">${esc((r && r.error) || 'unavailable')}</span>`; return; }
  const v = r.validated; const cur = r.current || {};
  const dcls = v.delta > 0 ? 'bull' : v.delta < 0 ? 'bear' : 'dim';
  const dsign = v.delta > 0 ? '+' : '';
  const prob = v.probabilityShown && typeof v.calibratedProbability === 'number' ? `${Math.round(v.calibratedProbability * 100)}%` : '<span class="dim">hidden (calibration not validated)</span>';
  $('#validatedStatus').innerHTML =
    `<span style="display:inline-flex;gap:16px;flex-wrap:wrap;align-items:baseline">` +
    `<span>current <b>${cur.score}</b>/100</span>` +
    `<span>validated <b>${v.validatedScore}</b>/100</span>` +
    `<span>delta <b class="${dcls}">${dsign}${v.delta}</b></span>` +
    `<span>dir <b class="${shadowClass(v.direction)}">${esc(v.direction || '—')}</b></span>` +
    `<span>tier <b>${esc(v.tier || '—')}</b></span>` +
    `<span class="mono" style="font-size:10px">${esc(v.version)}</span></span>`;
  const kvp = (k, val, cls) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)"><span class="dim">${esc(k)}</span><span class="${cls || ''}">${val}</span></div>`;
  let html = '<div style="font-size:12.5px">';
  html += kvp('Primary (production)', esc(r.promotion.primary), 'mono');
  html += kvp('Promoted features', (r.promotion.approvedFeatures && r.promotion.approvedFeatures.length) ? esc(r.promotion.approvedFeatures.join(', ')) : '<span class="dim">none yet (validated mirrors current)</span>');
  html += kvp('Calibrated probability', prob);
  html += '</div>';
  html += '<div style="margin-top:10px" class="dim" style="font-size:11px">Score components</div><div style="font-size:12.5px">';
  for (const c of (v.components || [])) { const cc = typeof c.contribution === 'number' ? (c.contribution > 0 ? 'bull' : c.contribution < 0 ? 'bear' : '') : ''; const cv = typeof c.contribution === 'number' ? ((c.contribution > 0 ? '+' : '') + c.contribution) : '—'; html += kvp(c.name + (c.note ? ` · ${c.note}` : ''), cv, cc); }
  html += '</div>';
  html += `<div class="dim" style="font-size:11px;margin-top:10px">${esc(r.note || '')}</div>`;
  $('#validatedOut').innerHTML = html;
}
async function renderShadow() {
  const ticker = (($('#optTicker') && $('#optTicker').value) || '').trim().toUpperCase();
  if (!ticker) return;
  $('#shadowStatus').textContent = 'computing shadow for ' + ticker + '…'; $('#shadowOut').innerHTML = '';
  let r; try { r = await api('/shadow/' + encodeURIComponent(ticker)); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) { $('#shadowStatus').innerHTML = `<span class="bear">${esc((r && r.error) || 'unavailable')}</span>`; return; }
  const s = r.shadow;
  $('#shadowStatus').innerHTML = `shadow score <b>${s.shadowScore}</b>/100 · <b class="${shadowClass(s.shadowDirection)}">${esc(s.shadowDirection)}</b> · data quality ${Math.round(s.dataQuality * 100)}% · <span class="mono" style="font-size:10px">${esc(s.version)}</span>`;
  const kvp = (k, v, cls) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)"><span class="dim">${esc(k)}</span><span class="${cls || ''}">${v}</span></div>`;
  const reg = s.regime, iv = s.iv, fl = s.flow, mk = s.market;
  $('#shadowOut').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div>
        <div class="dim mono" style="font-size:11px;margin-bottom:4px">GEX / REGIME</div>
        ${kvp('GEX regime', esc(reg.gex), shadowClass(reg.gex === 'positive' ? '' : ''))}
        ${kvp('Gamma-flip dist', shadowPct(reg.flipDistancePct))}
        ${kvp('Call-wall dist', shadowPct(reg.callWallDistancePct))}
        ${kvp('Put-wall dist', shadowPct(reg.putWallDistancePct))}
        ${kvp('ΔGEX', reg.deltaGex && reg.deltaGex.available ? esc(reg.deltaGex.label) + ' (' + shadowPct(reg.deltaGex.pct) + ')' : '<span class="dim">needs snapshots</span>')}
        ${kvp('Vanna / Charm', (s.greeks.vanna != null ? 'v✓' : 'v—') + ' / ' + (s.greeks.charm != null ? 'c✓' : 'c—'))}
      </div>
      <div>
        <div class="dim mono" style="font-size:11px;margin-bottom:4px">FLOW / IV / PRICE</div>
        ${kvp('Flow direction', `<b class="${shadowClass(fl.direction)}">${esc(fl.direction)}</b>`)}
        ${kvp('Flow quality', shadowNum(fl.quality) + (fl.sampleSize ? ` <span class="dim">(${fl.sampleSize})</span>` : ''))}
        ${kvp('25Δ skew', `<span class="${shadowClass(iv.skewLabel)}">${esc(iv.skewLabel)}</span>` + (iv.skew25 != null ? ` <span class="dim">${iv.skew25.toFixed(3)}</span>` : ''))}
        ${kvp('IV spread (C−P)', `<span class="${shadowClass(iv.ivSpreadLabel)}">${esc(iv.ivSpreadLabel)}</span>`)}
        ${kvp('VRP', esc(s.vrp.label) + (s.vrp.value != null ? ` <span class="dim">${(s.vrp.value * 100).toFixed(1)}pp</span>` : ''))}
        ${kvp('Momentum', `<span class="${shadowClass(s.momentum.label)}">${esc(s.momentum.label)}</span>`)}
        ${kvp('Flow vs price', `<b>${esc(s.flowPrice.relation)}</b>`)}
      </div>
    </div>
    <div class="dim" style="margin-top:10px;font-size:11px">Market context: GEX <b>${esc(mk.gexRegime || '—')}</b> · tide <b>${esc(mk.tideDirection || '—')}</b> · DIX ${shadowNum(mk.dix, 1)} &nbsp;·&nbsp; <span style="color:#7dd6a8">Shadow only — the live Signal Score above is computed independently and is not affected by any of this.</span></div>
    ${s.marketRegime || s.crossSectional || s.earnings ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)"><div class="dim mono" style="font-size:11px;margin-bottom:4px">S&amp;P 500 CROSS-SECTIONAL (shadow)</div>
      ${s.marketRegime ? kvp('Market regime', `<b>${esc(s.marketRegime.state)}</b>`) : ''}
      ${s.crossSectional ? (s.crossSectional.inUniverse ? kvp('Cross-sectional rank', `composite <b>${s.crossSectional.composite}</b>/100 · net-prem ${s.crossSectional.ranks && s.crossSectional.ranks.netPremium != null ? s.crossSectional.ranks.netPremium : '—'} · IV ${s.crossSectional.ranks && s.crossSectional.ranks.ivRank != null ? s.crossSectional.ranks.ivRank : '—'} <span class="dim">(vs ${s.crossSectional.populationSize} names)</span>`) : kvp('Cross-sectional rank', '<span class="dim">not in current /screener universe</span>')) : ''}
      ${s.sectorBreadth ? kvp('Sector breadth', `${esc(s.sectorBreadth.sector)} · <b class="${shadowClass(s.sectorBreadth.dominant)}">${esc(s.sectorBreadth.dominant)}</b> ${s.sectorBreadth.breadthPct}% ${s.sectorBreadth.aligned ? '<span class="bull">✓ aligned</span>' : '<span class="dim">✗ not aligned</span>'} <span class="dim">(${s.sectorBreadth.sectorCount})</span>`) : ''}
      ${s.earnings && s.earnings.available ? kvp('Earnings', `<b>${esc(s.earnings.proximity)}</b> <span class="dim">(${esc(s.earnings.nextDate)} · ${s.earnings.daysToEarnings}d)</span>`, (s.earnings.proximity === 'imminent' || s.earnings.proximity === 'approaching') ? 'bear' : '') : ''}
    </div>` : ''}`;
}

async function runAiAnalysis() {
  const ticker = (($('#optTicker') && $('#optTicker').value) || '').trim().toUpperCase();
  if (!ticker) { $('#aiStatus').innerHTML = '<span class="warn">Enter a ticker in the box above first.</span>'; return; }
  $('#aiStatus').textContent = 'running multi-agent analysis…'; $('#aiOut').innerHTML = '';
  let r; try { r = await (await fetch('/api/ai/analyze/' + encodeURIComponent(ticker), { method: 'POST' })).json(); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) { $('#aiStatus').innerHTML = `<span class="bear">${esc((r && r.error) || 'AI unavailable')}</span>`; return; }
  const ai = r.ai || {}; const det = { score: ai.deterministicScore, dir: ai.deterministicDirection, tier: ai.deterministicTier };
  $('#aiStatus').innerHTML = `model <span class="mono">${esc(r.model || '—')}</span>${r.cached ? ' · cached' : ''}`;
  const chip = (v) => `<span class="${v === 'bullish' ? 'bull' : v === 'bearish' ? 'bear' : 'dim'}">${esc(v)}</span>`;
  const analyst = (name, a) => `<div class="card" style="margin:0"><div class="hd" style="padding:8px 12px"><h3 style="font-size:12px">${esc(name)}</h3><span style="margin-left:auto">${chip(a.view)} <span class="dim">${a.confidence != null ? a.confidence : '—'}</span></span></div><div class="bd" style="padding:8px 12px;font-size:12px">${(a.points || []).map((p) => '• ' + esc(p)).join('<br>') || '<span class="dim">—</span>'}</div></div>`;
  $('#aiOut').innerHTML = `
    <div class="card" style="margin:0 0 10px;border-color:#2a3550"><div class="bd" style="display:flex;gap:20px;flex-wrap:wrap;font-size:12.5px;padding:10px 14px">
      <div><div class="dim" style="font-size:10px;text-transform:uppercase">Deterministic signal (authority)</div><b>${det.score != null ? det.score : '—'}</b> · ${chip(det.dir === 'bull' ? 'bullish' : det.dir === 'bear' ? 'bearish' : 'neutral')} · ${esc(det.tier || '—')}</div>
      <div style="border-left:1px solid #2a3550;padding-left:20px"><div class="dim" style="font-size:10px;text-transform:uppercase">AI view (advisory)</div>${chip(ai.aiView)} · conf <b>${ai.aiConfidence != null ? ai.aiConfidence : '—'}</b></div>
    </div></div>
    <div class="row" style="gap:10px">${analyst('Flow', ai.analysts.flow)}${analyst('Positioning / GEX', ai.analysts.positioning)}${analyst('Technical', ai.analysts.technical)}${analyst('News', ai.analysts.news)}</div>
    <div class="row" style="gap:10px;margin-top:10px">
      <div class="card" style="flex:1;margin:0;border-color:#1f4a2f"><div class="hd" style="padding:8px 12px"><h3 style="font-size:12px;color:#3fb950">Bull case</h3></div><div class="bd" style="padding:8px 12px;font-size:12px">${esc(ai.bullCase.thesis)}<br>${(ai.bullCase.points || []).map((p) => '• ' + esc(p)).join('<br>')}</div></div>
      <div class="card" style="flex:1;margin:0;border-color:#5a1f1f"><div class="hd" style="padding:8px 12px"><h3 style="font-size:12px;color:#f85149">Bear case</h3></div><div class="bd" style="padding:8px 12px;font-size:12px">${esc(ai.bearCase.thesis)}<br>${(ai.bearCase.points || []).map((p) => '• ' + esc(p)).join('<br>')}</div></div>
    </div>
    <div class="card" style="margin-top:10px"><div class="hd" style="padding:8px 12px"><h3 style="font-size:12px">Risk review · <span class="${ai.riskReview.level === 'high' ? 'bear' : ai.riskReview.level === 'low' ? 'bull' : 'warn'}">${esc(ai.riskReview.level)}</span></h3></div><div class="bd" style="padding:8px 12px;font-size:12px">${(ai.riskReview.risks || []).map((p) => '• ' + esc(p)).join('<br>') || '<span class="dim">—</span>'}</div></div>
    <div class="card" style="margin-top:10px;border-color:#3a3a5a"><div class="hd" style="padding:8px 12px"><h3 style="font-size:12px">AI summary</h3></div><div class="bd" style="padding:8px 12px;font-size:12.5px">${esc(ai.summary.text)}</div></div>
    <div class="dim" style="font-size:11px;margin-top:8px">${esc(ai.disclaimer || 'AI analysis is advisory and does not affect the Signal Score.')}</div>`;
}

function renderSettings() {
  const w = cfg.weights;
  $('#weights').innerHTML = COMPONENTS.map((c) => `<div class="setrow"><div><label>${c.label}</label><div class="hint">${c.note}</div></div><input type="range" min="0" max="0.5" step="0.01" data-w="${c.key}" value="${w[c.key]}"><div class="num mono" id="wv_${c.key}">${(w[c.key] ?? 0).toFixed(2)}</div></div>`).join('');
  const eng = [
    ['minScore', 'Minimum Signal Score', 0, 100, 1, '%'],
    ['pollSec', 'Scan interval', 5, 120, 1, 's'],
    ['topK', 'Deep-scan top-K markets', 1, 20, 1, ''],
    ['epsilon', 'Neutral band (net tilt)', 0, 0.3, 0.01, ''],
    ['staleMin', 'Signal stale timeout', 1, 30, 1, 'min'],
    ['priceWindow', 'Price window (points)', 2, 24, 1, ''],
    ['cooldownMs', 'Flip cooldown', 0, 300000, 5000, 'ms'],
    ['flipMargin', 'Flip score margin', 0, 30, 1, ''],
    ['staleSnapshotMs', 'Stale-snapshot cutoff', 10000, 300000, 5000, 'ms'],
    ['featureStrengthThreshold', 'Research fire threshold', 0, 1, 0.01, ''],
  ];
  $('#engineSettings').innerHTML = eng.map(([k, lab, mn, mx, st, u]) => `<div class="setrow"><div><label>${lab}</label></div><input type="range" min="${mn}" max="${mx}" step="${st}" data-e="${k}" value="${cfg[k]}"><div class="num mono" id="ev_${k}">${cfg[k]}${u}</div></div>`).join('');
  updateWsum();
  $$('#weights input').forEach((i) => i.oninput = () => { cfg.weights[i.dataset.w] = Number(i.value); $('#wv_' + i.dataset.w).textContent = Number(i.value).toFixed(2); updateWsum(); });
  $$('#engineSettings input').forEach((i) => i.oninput = () => { const u = eng.find((e) => e[0] === i.dataset.e)[5]; cfg[i.dataset.e] = Number(i.value); $('#ev_' + i.dataset.e).textContent = i.value + u; });
}
function updateWsum() { const s = Object.values(cfg.weights).reduce((a, b) => a + b, 0); $('#wsum').textContent = `Σ ${s.toFixed(2)} → normalized to 1.00`; }

// ---------- detail modal ----------
function openDetail(id) {
  const sig = state.signals.get(id); if (!sig) return;
  const dc = dirClass(sig.dir); const sgn = sig.dir === 'bull' ? 1 : -1;
  const expl = sig.comps.map((c) => {
    if (!c.avail) return `<div style="color:var(--dim);margin:3px 0">‹no data› ${c.label}</div>`;
    if (c.dir === 0) return `<div class="muted" style="margin:3px 0">• ${c.label}: ${esc(c.note)} <span class="dim">(confirmation, no direction)</span></div>`;
    const agree = Math.sign(c.dir) === sgn;
    return `<div style="margin:3px 0;color:${agree ? 'var(--bull)' : 'var(--bear)'}">${agree ? '✓' : '✗'} ${c.label}: ${esc(c.note)}</div>`;
  }).join('');
  const bars = sig.comps.map((c) => {
    const val = c.avail ? c.dir * c.strength : 0; const w = clamp(Math.abs(val) * 50, 0, 50); const side = val >= 0 ? 'b' : 's';
    const col = side === 'b' ? 'linear-gradient(90deg,#1c8f78,var(--bull))' : 'linear-gradient(270deg,#a83b3b,var(--bear))';
    return `<div class="compbar"><div class="muted" style="font-size:12px">${c.label} <span class="dim">${(c.weight * 100).toFixed(0)}%${isNum(c.value) ? ' · v=' + (+c.value).toFixed(2) : ''}</span></div>
      <div class="track"><div class="mid"></div><div class="f" style="${side === 'b' ? 'left:50%' : 'right:50%'};width:${c.avail ? w : 0}%;background:${col}"></div></div>
      <div class="num mono">${c.avail ? (c.contribution >= 0 ? '+' : '') + (c.contribution * 100).toFixed(0) : '—'}</div></div>`;
  }).join('');
  const m = sig.market; const field = (k, v) => `<div class="f"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  $('#sheet').innerHTML = `
    <div class="top">
      <div><div class="tkr" style="font-size:18px">${esc(tickerOf(sig).toUpperCase())} <span class="dirbadge ${dc}">${dirWord(sig.dir)}</span> <span class="dim">${esc(sig.assetType || '')}</span></div>
      <div class="muted" style="font-size:12px">${esc(sig.title)}</div></div>
      <div class="score" style="margin-left:auto;text-align:right"><div class="n ${dc === 'b' ? 'bull' : 'bear'}" style="font-size:30px">${sig.score}</div><div class="l">${esc(sig.tier || 'Signal')} · conf ${sig.confidence}%</div></div>
      <button class="x" id="closeModal">×</button>
    </div>
    <div class="body">
      <div class="dl" style="margin-bottom:16px">
        ${field('YES implied prob', pct(m.bullPrice, 1))} ${field('NO implied prob', pct(m.bearPrice, 1))}
        ${field('Net tilt', (sig.net * 100).toFixed(0) + '%')} ${field('Coverage', pct(sig.coverage, 0))}
        ${field('Data quality', esc(sig.quality) + (sig.qualityReasons && sig.qualityReasons.length ? ` <span class="dim">(${esc(sig.qualityReasons.join(', '))})</span>` : ''))}
        ${field('Contract volume', fmt(m.volume))} ${field('Token liquidity', fmt(m.liquidity))}
        ${field('Ends', m.endDate ? new Date(m.endDate).toISOString().slice(0, 10) : '—')}
        ${field('Generated', hhmmss(sig.ts_created))} ${field('Snapshot age', sig.asOf ? ago(sig.asOf) : '—')}
      </div>
      ${sig.diagnostics ? `<div class="eyebrow" style="margin-bottom:8px">Prediction-market flow anomaly</div>
      <div class="dl" style="margin-bottom:16px">
        ${field('Flow anomaly', pct(sig.diagnostics.flowAnomaly, 0))} ${field('Volume anomaly', pct(sig.diagnostics.volAnomaly, 0))}
        ${field('Flow acceleration', isNum(sig.diagnostics.flowAccel) ? (sig.diagnostics.flowAccel >= 0 ? '+' : '') + (sig.diagnostics.flowAccel * 100).toFixed(0) + '%' : '—')} ${field('Persistence', pct(sig.diagnostics.persistence, 0))}
        ${field('Regime', esc(sig.diagnostics.regime || '—'))} ${field('History samples', num(sig.diagnostics.samples || 0))}
      </div>` : ''}
      <div class="eyebrow" style="margin-bottom:8px">Component contributions ${(sig.proxies && sig.proxies.length) ? `<span class="dim" style="font-weight:400">· proxy metrics: ${esc(sig.proxies.join(', '))} (not real options data)</span>` : ''}</div>${bars}
      <div class="eyebrow" style="margin:16px 0 8px">Why this score</div>${expl}
      <div class="disc" style="margin-top:16px">Signal Score = |net tilt| × coverage, mapped to tier (${esc(sig.tier || '')}). It is a ranking/confidence score from <b>Unusual Whales</b> options data — <b>not</b> a probability of profit. Not financial advice.</div>
    </div>`;
  $('#modal').classList.add('show');
  $('#closeModal').onclick = () => $('#modal').classList.remove('show');
}

// =====================================================================
//  WIRING
// =====================================================================
let OV_SIM = null;
function startOverviewSim() {
  const root = $('#overviewSim');
  if (!root) return;
  if (OV_SIM) return;                       // already running
  OV_SIM = createOverviewSim(root);
}
function stopOverviewSim() { if (OV_SIM) { OV_SIM.destroy(); OV_SIM = null; const r = $('#overviewSim'); if (r) r.innerHTML = ''; } }

// Sliding indicator under the active item of the single top menu.
function moveSegInd() {
  const ind = $('#segInd'), on = $('#menu .navbtn.active');
  if (!ind) return;
  if (!on) { ind.style.width = '0px'; return; }
  ind.style.width = on.offsetWidth + 'px';
  ind.style.transform = `translateX(${on.offsetLeft - 3}px)`;
}
window.addEventListener('resize', () => moveSegInd());
// Count numbers up from 0 for elements marked [data-count] (skipped when reduced motion is preferred).
function animateCounts(root) {
  if (!root || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  root.querySelectorAll('[data-count]').forEach((el) => {
    const end = Number(el.dataset.count); if (!Number.isFinite(end)) return;
    const t0 = performance.now(), dur = 700;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur); el.textContent = Math.round(end * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}
function setTab(t) {
  state.ui.tab = t;
  $$('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  moveSegInd();
  $$('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === t));
  if (t === 'monitor') renderMonitor();
  if (t === 'settings') { renderSettings(); renderApiConfig(); }
  if (t === 'research') renderResearch();
  if (t === 'backtest') renderBacktest();
  if (t === 'options') renderOptions();
  if (t === 'signals') renderSignals();
  if (t === 'dashboard') startOverviewSim(); else stopOverviewSim();
  if (t === 'journal') renderJournal();
  if (t === 'replay') renderReplay();
  if (t === 'health') renderHealth();
}
function wire() {
  $('#loginBtn').onclick = doLogin;
  $('#pw').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
  $('#logoutBtn').onclick = doLogout;
  $('#maphX').onclick = () => { $('#maph').classList.remove('show'); localStorage.setItem('pve_maph', '1'); };
  if (!localStorage.getItem('pve_maph')) $('#maph').classList.add('show');
  $$('[data-tab]').forEach((b) => b.onclick = () => setTab(b.dataset.tab));
  $$('[data-bt]').forEach((c) => c.onclick = () => { $$('[data-bt]').forEach((x) => x.classList.remove('on')); c.classList.add('on'); state.ui.btSplit = c.dataset.bt; renderBacktest(); });
  if ($('#optGo')) $('#optGo').onclick = () => renderOptions();
  $$('[data-sigthr]').forEach((c) => c.onclick = () => { $$('[data-sigthr]').forEach((x) => x.classList.remove('on')); c.classList.add('on'); SIG.thr = Number(c.dataset.sigthr); renderSigTop(); renderSigTable(); });
  $$('[data-sigside]').forEach((c) => c.onclick = () => { const s = c.dataset.sigside; if (SIG.side === s) { SIG.side = null; c.classList.remove('on'); } else { SIG.side = s; $$('[data-sigside]').forEach((x) => x.classList.remove('on')); c.classList.add('on'); } renderSigTable(); });
  if ($('#sigSearch')) $('#sigSearch').oninput = (e) => { SIG.q = e.target.value.toUpperCase().trim(); renderSigTable(); };
  if ($('#sigRefresh')) $('#sigRefresh').onclick = () => renderSignals();
  if ($('#sigRunScan')) $('#sigRunScan').onclick = () => runScan();
  // Claude Review wiring
  $$('[data-jr]').forEach((c) => c.onclick = () => jrSet(c.dataset.jr));
  if ($('#jrResolve')) $('#jrResolve').onclick = () => jrResolve();
  if ($('#optTicker')) $('#optTicker').onkeydown = (e) => { if (e.key === 'Enter') renderOptions(); };
  if ($('#aiRun')) $('#aiRun').onclick = () => runAiAnalysis();
  if ($('#shadowRun')) $('#shadowRun').onclick = () => renderShadow();
  if ($('#validatedRun')) $('#validatedRun').onclick = () => renderValidated();
  $('#histClear').onclick = () => { if (confirm('Clear all recorded signal history?')) { state.history = []; saveHistory(); renderHistory(); renderBacktest(); renderResearch(); } };
  $('#histExport').onclick = exportCsv;
  $('#monRefresh').onclick = renderMonitor;
  $('#monEndpoint').onchange = () => { state.ui.monEndpoint = $('#monEndpoint').value; renderInspect(); };
  $$('[data-view]').forEach((c) => c.onclick = () => { $$('[data-view]').forEach((x) => x.classList.remove('on')); c.classList.add('on'); state.ui.monView = c.dataset.view; renderInspect(); });
  $('#setSave').onclick = () => { saveCfg(); $('#setMsg').textContent = 'saved ✓'; setTimeout(() => $('#setMsg').textContent = '', 1500); restartLoop(); renderAll(); };
  if ($('#apiRefresh')) $('#apiRefresh').onclick = () => renderApiConfig();
  $('#setReset').onclick = () => { for (const k of Object.keys(cfg)) delete cfg[k]; Object.assign(cfg, { ...DEFAULT_CONFIG, ...APP_DEFAULTS, weights: { ...DEFAULT_CONFIG.weights } }); saveCfg(); renderSettings(); restartLoop(); renderAll(); };
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').classList.remove('show'); };
  document.onkeydown = (e) => { if (e.key === 'Escape') $('#modal').classList.remove('show'); };
}
function exportCsv() {
  const cols = ['time', 'slug', 'title', 'dir', 'score', 'confidence', 'coverage', 'quality', 'entryPrice', 'mfe', 'mae', ...HORIZONS.map((h) => h + 'm_favPts'), ...HORIZONS.map((h) => h + 'm_win')];
  const lines = [cols.join(',')];
  for (const r of state.history) lines.push([new Date(r.ts).toISOString(), r.slug, '"' + String(r.title || '').replace(/"/g, '""') + '"', r.dir, r.score, r.confidence ?? '', (r.coverage || 0).toFixed(3), r.quality ?? '', r.entryPrice ?? '', (r.mfe || 0).toFixed(4), (r.mae || 0).toFixed(4), ...HORIZONS.map((h) => r.evals[h] && r.evals[h].done ? r.evals[h].favPts.toFixed(4) : ''), ...HORIZONS.map((h) => r.evals[h] && r.evals[h].done ? (r.evals[h].win ? 1 : 0) : '')].join(','));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = 'pve_signal_history.csv'; a.click();
}
function restartLoop() { if (scanTimer) clearInterval(scanTimer); scanTimer = null; }   // §1: no automatic polling — Run Scan is the only trigger
let tick = null;
function start() {
  $('#login').style.display = 'none'; $('#app').style.display = 'grid';
  renderPills(); renderSettings(); scan(); restartLoop();
  setTab(state.ui.tab || 'signals');   // single menu: Live Signals is the default view
  if (tick) clearInterval(tick); tick = setInterval(() => { $('#scanTxt').textContent = state.lastScan ? hhmmss(state.lastScan) : '—'; }, 1000);
}
async function boot() { wire(); const s = await checkStatus(); if (s.authed) start(); else showLogin(); }
boot();
