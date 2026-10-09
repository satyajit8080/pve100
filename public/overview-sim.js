// public/overview-sim.js — "How PVE Signal Engine Works"
//
// PURE FRONTEND DEMONSTRATION. This module makes NO network requests of any kind: no UW,
// no backend, no websocket. Every number is generated locally by a seeded RNG and is
// explicitly labelled as simulated. It exists to explain the pipeline visually.

const TICKERS = ['NVDA', 'AAPL', 'TSLA', 'AMD', 'META', 'AMZN', 'MSFT'];

const SOURCES = [
  { id: 'flow', label: 'Options Flow', kind: 'options', lines: () => [
    pick(['CALL SWEEP', 'PUT SWEEP', 'GOLDEN SWEEP', 'BLOCK TRADE']),
    `$${(rnd(40, 950)).toFixed(0)}K PREMIUM`, pick(['BUY', 'SELL', 'ASK-SIDE', 'BID-SIDE']), `${rnd(1.2, 24).toFixed(1)}K VOL`] },
  { id: 'chain', label: 'Options Chain', kind: 'options', lines: () => [
    `OI ${sign()}${rnd(2, 24).toFixed(1)}%`, `IV ${rnd(18, 78).toFixed(1)}%`, `GEX ${sign()}$${rnd(0.4, 6).toFixed(1)}M`] },
  { id: 'market', label: 'Market Data', kind: 'market', lines: () => [
    `PRICE $${rnd(90, 480).toFixed(2)}`, `VWAP $${rnd(90, 480).toFixed(2)}`, `ATR ${rnd(1.1, 6.4).toFixed(2)}`] },
  { id: 'news', label: 'News & Events', kind: 'market', lines: () => [
    pick(['CATALYST DETECTED', 'EARNINGS T-2', 'UPGRADE', 'GUIDANCE RAISED']), `SENTIMENT ${sign()}${rnd(0.1, 0.95).toFixed(2)}`] },
  { id: 'tech', label: 'Technical Data', kind: 'market', lines: () => [
    `MOMENTUM ${sign()}${rnd(20, 96).toFixed(0)}`, `TREND ${pick(['BULLISH', 'BEARISH', 'NEUTRAL'])}`] },
];

const FEATURES = [
  ['Flow Direction', 'options'], ['Premium Strength', 'options'], ['Volume / OI', 'options'], ['IV Rank', 'options'],
  ['Put/Call Bias', 'options'], ['Time Decay', 'options'], ['Strike Positioning', 'options'], ['Momentum', 'market'],
  ['Trend Alignment', 'market'], ['Support / Resistance', 'market'], ['ATR Strength', 'market'], ['Market Context', 'market'],
];

const OPT_COMPONENTS = ['Flow Direction', 'Premium Strength', 'Volume & OI', 'Unusual Activity', 'IV Rank & Skew', 'Call/Put Bias', 'Time Decay', 'Strike Positioning'];
const STK_COMPONENTS = ['Trend Alignment', 'Price Momentum', 'Volume Confirmation', 'Support/Resistance', 'ATR Strength', 'Market Context'];
const LEARN_ROWS = ['Feature Effectiveness', 'Weight Optimization', 'Model Calibration', 'Signal Quality', 'Historical Performance'];

const STAGES = [
  ['sources', 'Data Sources'], ['features', 'Feature Engineering'], ['engine', 'PVE Scoring Engine'],
  ['signal', 'Signal Generation'], ['journal', 'Signal Journal'], ['perf', 'Performance Tracking'], ['learn', 'Learning & Improvement'],
];

// ---- tiny local RNG helpers (no crypto, no network) ----
let seed = 1337;
function rand() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
function rnd(a, b) { return a + rand() * (b - a); }
function pick(a) { return a[Math.floor(rand() * a.length)]; }
function sign() { return rand() > 0.45 ? '+' : '-'; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const COLORS = { options: '#a78bfa', market: '#38bdf8', signal: '#34d399', learn: '#fbbf24' };

export function createOverviewSim(root) {
  if (!root) return null;
  root.innerHTML = template();

  const $ = (s) => root.querySelector(s);
  const canvas = $('#simCanvas');
  const ctx = canvas.getContext('2d');

  const state = {
    running: true, showFlow: true, showLearn: true, raf: null, t: 0,
    particles: [], packets: [],
    features: FEATURES.map(([name, kind]) => ({ name, kind, v: rnd(30, 80), target: rnd(30, 90) })),
    score: 71, scoreTarget: 78, optScore: 52, stkScore: 33,
    stats: { evaluated: 1284, generated: 47, high: 12, journal: 1284 },
    journal: [], perf: null, active: null, highlight: null,
    signal: null, learn: LEARN_ROWS.map((r) => ({ r, v: rnd(40, 95) })),
    impacts: [['Flow Direction', 'HIGH'], ['Momentum', 'HIGH'], ['IV Rank', 'MEDIUM'], ['Time Decay', 'LOW']],
    lastEmit: 0, lastFeature: 0, lastScore: 0, lastSignal: 0, phase: 'idle',
  };

  // ---------- layout: anchor points read from the DOM so it stays responsive ----------
  function anchors() {
    const box = root.getBoundingClientRect();
    const a = {};
    for (const [id] of STAGES) {
      const el = root.querySelector(`[data-stage="${id}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      a[id] = { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2, w: r.width, h: r.height, top: r.top - box.top, bottom: r.bottom - box.top, left: r.left - box.left, right: r.right - box.left };
    }
    return a;
  }

  function resize() {
    const box = root.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(box.width * dpr));
    canvas.height = Math.max(1, Math.floor(box.height * dpr));
    canvas.style.width = box.width + 'px';
    canvas.style.height = box.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------- particles ----------
  function emit(fromId, toId, kind, big = false) {
    const a = anchors();
    const f = a[fromId], t = a[toId];
    if (!f || !t) return;
    const vertical = t.y - f.y > 40;
    state.particles.push({
      x: f.x, y: f.y, fx: f.x, fy: f.y, tx: t.x, ty: t.y,
      p: 0, speed: big ? 0.0045 : rnd(0.006, 0.013), kind, big,
      curve: vertical ? rnd(-40, 40) : rnd(-18, 18),
    });
    if (state.particles.length > 320) state.particles.splice(0, 60);
  }

  function stepParticles(dt) {
    for (const p of state.particles) {
      p.p += p.speed * dt;
      const e = p.p < 0.5 ? 2 * p.p * p.p : 1 - ((-2 * p.p + 2) ** 2) / 2;   // easeInOutQuad
      const mx = (p.fx + p.tx) / 2 + p.curve;
      const my = (p.fy + p.ty) / 2;
      const u = 1 - e;
      p.x = u * u * p.fx + 2 * u * e * mx + e * e * p.tx;
      p.y = u * u * p.fy + 2 * u * e * my + e * e * p.ty;
    }
    state.particles = state.particles.filter((p) => p.p < 1);
  }

  function drawLinks(a) {
    const order = STAGES.map(([id]) => id);
    ctx.lineWidth = 1;
    for (let i = 0; i < order.length - 1; i++) {
      const f = a[order[i]], t = a[order[i + 1]];
      if (!f || !t) continue;
      const on = state.highlight === order[i] || state.highlight === order[i + 1];
      ctx.strokeStyle = on ? 'rgba(167,139,250,.55)' : 'rgba(120,140,190,.16)';
      ctx.beginPath();
      ctx.moveTo(f.x, f.y);
      ctx.bezierCurveTo((f.x + t.x) / 2, f.y, (f.x + t.x) / 2, t.y, t.x, t.y);
      ctx.stroke();
    }
    // feedback loop: learning -> engine
    if (state.showLearn && a.learn && a.engine) {
      const f = a.learn, t = a.engine;
      ctx.strokeStyle = 'rgba(251,191,36,.30)';
      ctx.setLineDash([4, 6]);
      ctx.lineLimit = 1;
      ctx.beginPath();
      ctx.moveTo(f.x, f.bottom);
      ctx.bezierCurveTo(f.x, f.bottom + 70, t.x, t.bottom + 70, t.x, t.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function draw() {
    const box = root.getBoundingClientRect();
    ctx.clearRect(0, 0, box.width, box.height);
    const a = anchors();
    if (state.showFlow) drawLinks(a);
    for (const p of state.particles) {
      const c = COLORS[p.kind] || '#94a3b8';
      const r = p.big ? 4.2 : 2.1;
      const alpha = p.p < 0.1 ? p.p * 10 : p.p > 0.9 ? (1 - p.p) * 10 : 1;
      ctx.globalAlpha = clamp(alpha, 0, 1) * (p.big ? 0.95 : 0.8);
      ctx.fillStyle = c;
      ctx.shadowBlur = p.big ? 14 : 7;
      ctx.shadowColor = c;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
  }

  // ---------- simulation logic ----------
  function tickSources(now) {
    if (now - state.lastEmit < 260) return;
    state.lastEmit = now;
    const s = SOURCES[Math.floor(rand() * SOURCES.length)];
    const el = root.querySelector(`[data-src="${s.id}"] .simFeedLines`);
    if (el) {
      const line = pick(s.lines());
      const div = document.createElement('div');
      div.className = 'simPacket';
      div.style.color = COLORS[s.kind];
      div.textContent = line;
      el.prepend(div);
      while (el.children.length > 3) el.lastChild.remove();
    }
    for (let i = 0; i < 2; i++) emit('sources', 'features', s.kind);
    state.stats.evaluated += 1;
    if (rand() > 0.93) emit('sources', 'features', s.kind, true);
  }

  function tickFeatures(now) {
    if (now - state.lastFeature < 700) return;
    state.lastFeature = now;
    for (const f of state.features) {
      if (rand() > 0.72) f.target = clamp(f.target + rnd(-22, 22), 12, 98);
      f.v += (f.target - f.v) * 0.18;
    }
    renderFeatures();
    emit('features', 'engine', 'options');
    emit('features', 'engine', 'market');
  }

  function tickScore(now) {
    if (now - state.lastScore < 900) return;
    state.lastScore = now;
    const optAvg = avg(state.features.filter((f) => f.kind === 'options').map((f) => f.v));
    const stkAvg = avg(state.features.filter((f) => f.kind === 'market').map((f) => f.v));
    state.optScore = optAvg * 0.6;
    state.stkScore = stkAvg * 0.4;
    state.scoreTarget = clamp(Math.round(state.optScore + state.stkScore + rnd(-6, 8)), 38, 96);
    renderScoreBits();
  }

  function maybeSignal(now) {
    if (state.score < 80 || now - state.lastSignal < 7000) return;
    state.lastSignal = now;
    const t = pick(TICKERS);
    const price = rnd(80, 460);
    const bullish = rand() > 0.22;
    const sig = {
      ticker: t, price: price.toFixed(2), strike: Math.round(price / 5) * 5,
      dir: bullish ? 'BULLISH CALL' : 'BEARISH PUT', bullish,
      score: Math.round(state.score), conf: state.score >= 88 ? 'HIGH' : 'MEDIUM',
      target: '+3.0%', stop: '-3.0%', rr: '1 : 1', time: clockNow(),
      why: bullish
        ? ['Strong call flow', 'Premium acceleration', 'Bullish stock momentum', 'Volume confirmation', 'Trend alignment']
        : ['Heavy put flow', 'Ask-side premium', 'Price below VWAP', 'Volume confirmation', 'Downtrend alignment'],
    };
    state.signal = sig;
    state.stats.generated += 1;
    if (sig.conf === 'HIGH') state.stats.high += 1;
    renderSignal(true);
    for (let i = 0; i < 10; i++) setTimeout(() => emit('engine', 'signal', 'signal'), i * 55);

    // journal it
    setTimeout(() => {
      state.journal.unshift({ time: sig.time, ticker: sig.ticker, score: sig.score, dir: sig.bullish ? 'BULLISH' : 'BEARISH', sig });
      if (state.journal.length > 7) state.journal.pop();
      state.stats.journal += 1;
      renderJournal();
      for (let i = 0; i < 6; i++) setTimeout(() => emit('signal', 'journal', 'signal'), i * 60);
    }, 700);

    // simulate the outcome — deliberately not always a win
    setTimeout(() => {
      const win = rand() > 0.38;
      const mag = rnd(0.4, 3.6) * (win ? 1 : -1);
      const path = [0.35, 0.6, 0.85, 1].map((k, i) => +(mag * k + rnd(-0.25, 0.25)).toFixed(1));
      state.perf = {
        ticker: sig.ticker, win,
        marks: [['ENTRY', '0.0%'], ['15 MIN', fmtPct(path[0])], ['30 MIN', fmtPct(path[1])], ['60 MIN', fmtPct(path[2])], ['CLOSE', fmtPct(path[3])]],
        mfe: fmtPct(Math.max(...path, 0.2) + rnd(0.2, 0.9)), mae: fmtPct(Math.min(...path, -0.1) - rnd(0.05, 0.6)),
      };
      renderPerf();
      for (let i = 0; i < 6; i++) setTimeout(() => emit('journal', 'perf', win ? 'signal' : 'learn'), i * 60);
      setTimeout(() => {
        for (const l of state.learn) l.v = clamp(l.v + rnd(-6, 7), 35, 98);
        state.impacts = shuffleImpacts();
        renderLearn();
        for (let i = 0; i < 8; i++) setTimeout(() => emit('perf', 'learn', 'learn'), i * 55);
        if (state.showLearn) setTimeout(() => { for (let i = 0; i < 8; i++) setTimeout(() => emit('learn', 'engine', 'learn'), i * 70); }, 700);
      }, 900);
    }, 2000);
  }

  function shuffleImpacts() {
    const names = ['Flow Direction', 'Momentum', 'IV Rank', 'Time Decay', 'Premium Strength', 'Volume / OI', 'Trend Alignment'];
    const out = [];
    const used = new Set();
    for (let i = 0; i < 4; i++) {
      let n = pick(names); let guard = 0;
      while (used.has(n) && guard++ < 20) n = pick(names);
      used.add(n);
      out.push([n, i < 2 ? 'HIGH' : i === 2 ? 'MEDIUM' : 'LOW']);
    }
    return out;
  }

  // ---------- rendering ----------
  function renderFeatures() {
    const el = $('#simFeatures');
    if (!el) return;
    el.innerHTML = state.features.map((f) => {
      const v = Math.round(f.v);
      const bars = '█'.repeat(Math.max(1, Math.round(v / 12)));
      return `<div class="simFeat"><span class="simFeatName">${esc(f.name)}</span>
        <span class="simFeatBar" style="color:${COLORS[f.kind]}">${bars}</span>
        <span class="simFeatVal">${v}</span></div>`;
    }).join('');
  }

  function renderScoreBits() {
    const o = $('#simOptVal'), s = $('#simStkVal'), sum = $('#simSumVal');
    if (o) o.textContent = state.optScore.toFixed(1);
    if (s) s.textContent = state.stkScore.toFixed(1);
    if (sum) sum.textContent = Math.round(state.score);
    const oc = $('#simOptComp'), sc = $('#simStkComp');
    if (oc && !oc.dataset.built) {
      oc.innerHTML = OPT_COMPONENTS.map((c) => `<div class="simComp"><span>${esc(c)}</span><i data-c="${esc(c)}">0</i></div>`).join('');
      oc.dataset.built = '1';
    }
    if (sc && !sc.dataset.built) {
      sc.innerHTML = STK_COMPONENTS.map((c) => `<div class="simComp"><span>${esc(c)}</span><i data-c="${esc(c)}">0</i></div>`).join('');
      sc.dataset.built = '1';
    }
    root.querySelectorAll('.simComp i').forEach((i) => {
      if (rand() > 0.6) i.textContent = Math.round(rnd(28, 97));
    });
  }

  function renderScoreRing() {
    const v = state.score;
    const ring = $('#simRingFg');
    const num = $('#simScoreNum');
    const tier = $('#simScoreTier');
    if (num) num.textContent = Math.round(v);
    if (ring) {
      const C = 2 * Math.PI * 78;
      ring.style.strokeDasharray = `${(v / 100) * C} ${C}`;
      ring.style.stroke = v >= 80 ? '#34d399' : v >= 65 ? '#a78bfa' : '#38bdf8';
    }
    if (tier) {
      tier.textContent = v >= 88 ? 'VERY STRONG' : v >= 80 ? 'STRONG' : v >= 65 ? 'MODERATE' : 'BUILDING';
      tier.style.color = v >= 80 ? '#34d399' : 'var(--dim)';
    }
  }

  function renderSignal(flash) {
    const el = $('#simSignal');
    if (!el) return;
    const s = state.signal;
    if (!s) { el.innerHTML = '<div class="simIdle">Waiting for a setup to cross <b>80</b>…</div>'; return; }
    el.innerHTML = `<div class="simSigCard ${flash ? 'simFlash' : ''} ${s.bullish ? 'bullish' : 'bearish'}">
      <div class="simSigTop"><span class="simSigBadge">SIGNAL DETECTED</span><span class="simSigTime">${esc(s.time)}</span></div>
      <div class="simSigTicker">${esc(s.ticker)}</div>
      <div class="simSigContract">$${s.strike} ${s.bullish ? 'CALL' : 'PUT'} · entry $${esc(s.price)}</div>
      <div class="simSigScore">PVE SCORE <b>${s.score}</b></div>
      <div class="simSigDir ${s.bullish ? 'bull' : 'bear'}">${esc(s.dir)}</div>
      <div class="simSigGrid">
        <div><span>Confidence</span><b>${esc(s.conf)}</b></div>
        <div><span>Target</span><b class="bull">${esc(s.target)}</b></div>
        <div><span>Stop</span><b class="bear">${esc(s.stop)}</b></div>
        <div><span>R : R</span><b>${esc(s.rr)}</b></div>
      </div>
      <details class="simWhy" open><summary>WHY THIS SIGNAL?</summary>
        <ul>${s.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>
    </div>`;
  }

  function renderJournal() {
    const el = $('#simJournal');
    if (!el) return;
    el.innerHTML = state.journal.length
      ? state.journal.map((j, i) => `<div class="simJrow" data-j="${i}"><span class="simJt">${esc(j.time)}</span><b>${esc(j.ticker)}</b><span class="simJs">${j.score}</span><span class="${j.dir === 'BULLISH' ? 'bull' : 'bear'}">${esc(j.dir)}</span></div>`).join('')
      : '<div class="simIdle">No records yet…</div>';
    el.querySelectorAll('[data-j]').forEach((r) => r.onclick = () => {
      const j = state.journal[+r.dataset.j];
      if (j) { state.signal = j.sig; renderSignal(false); highlight('signal'); }
    });
  }

  function renderPerf() {
    const el = $('#simPerf');
    if (!el) return;
    const p = state.perf;
    if (!p) { el.innerHTML = '<div class="simIdle">Outcomes appear after a signal fires…</div>'; return; }
    el.innerHTML = `<div class="simPerfHead"><b>${esc(p.ticker)}</b><span class="${p.win ? 'bull' : 'bear'}">${p.win ? 'WIN' : 'LOSS'}</span></div>
      <div class="simTimeline">${p.marks.map(([k, v], i) => `<div class="simMark" style="animation-delay:${i * 120}ms"><span>${esc(k)}</span><b class="${v.startsWith('-') ? 'bear' : 'bull'}">${esc(v)}</b></div>`).join('<div class="simTick"></div>')}</div>
      <div class="simMfe"><span>MFE <b class="bull">${esc(p.mfe)}</b></span><span>MAE <b class="bear">${esc(p.mae)}</b></span></div>`;
  }

  function renderLearn() {
    const el = $('#simLearn');
    if (!el) return;
    el.innerHTML = `${state.learn.map((l) => `<div class="simFeat"><span class="simFeatName">${esc(l.r)}</span><span class="simFeatBar" style="color:${COLORS.learn}">${'█'.repeat(Math.max(1, Math.round(l.v / 14)))}</span><span class="simFeatVal">${Math.round(l.v)}</span></div>`).join('')}
      <div class="simImpacts">${state.impacts.map(([n, i]) => `<div class="simImpact"><span>${esc(n)}</span><b class="${i === 'HIGH' ? 'bull' : i === 'LOW' ? 'dim' : ''}">${esc(i)} IMPACT</b></div>`).join('')}</div>`;
  }

  function renderStats() {
    const s = state.stats;
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v.toLocaleString(); };
    set('#simStatEval', s.evaluated); set('#simStatGen', s.generated);
    set('#simStatHigh', s.high); set('#simStatJournal', s.journal);
  }

  function highlight(id) {
    state.highlight = state.highlight === id ? null : id;
    root.querySelectorAll('[data-stage]').forEach((el) => el.classList.toggle('simOn', el.dataset.stage === state.highlight));
  }

  // ---------- main loop ----------
  let last = 0;
  function loop(ts) {
    state.raf = requestAnimationFrame(loop);
    if (!last) last = ts;
    const dt = Math.min(48, ts - last); last = ts;
    if (state.running) {
      const now = ts;
      tickSources(now); tickFeatures(now); tickScore(now);
      state.score += (state.scoreTarget - state.score) * 0.06;
      renderScoreRing();
      maybeSignal(now);
      stepParticles(dt);
      if (Math.floor(ts / 900) !== state.lastStatTick) { state.lastStatTick = Math.floor(ts / 900); renderStats(); }
    }
    draw();
  }

  // ---------- controls ----------
  $('#simPause').onclick = () => {
    state.running = !state.running;
    $('#simPause').textContent = state.running ? 'Pause' : 'Resume';
    $('#simDot').classList.toggle('paused', !state.running);
    $('#simRunTxt').textContent = state.running ? 'ENGINE SIMULATION RUNNING' : 'SIMULATION PAUSED';
  };
  $('#simReset').onclick = () => {
    state.particles = []; state.journal = []; state.perf = null; state.signal = null;
    state.stats = { evaluated: 1284, generated: 47, high: 12, journal: 1284 };
    state.score = 71; state.scoreTarget = 78;
    renderJournal(); renderPerf(); renderSignal(false); renderStats();
  };
  $('#simFlowT').onclick = () => { state.showFlow = !state.showFlow; $('#simFlowT').classList.toggle('on', state.showFlow); };
  $('#simLearnT').onclick = () => { state.showLearn = !state.showLearn; $('#simLearnT').classList.toggle('on', state.showLearn); };
  root.querySelectorAll('[data-stage]').forEach((el) => { el.onclick = () => highlight(el.dataset.stage); });

  const onResize = () => resize();
  window.addEventListener('resize', onResize);

  resize(); renderFeatures(); renderScoreBits(); renderScoreRing(); renderSignal(false);
  renderJournal(); renderPerf(); renderLearn(); renderStats();
  state.raf = requestAnimationFrame(loop);

  return {
    destroy() {
      if (state.raf) cancelAnimationFrame(state.raf);
      window.removeEventListener('resize', onResize);
      state.particles = [];
    },
  };
}

function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function fmtPct(v) { return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`; }
function clockNow() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

// ---------------------------------------------------------------------------
function template() {
  const srcPanels = SOURCES.map((s) => `
    <div class="simSrc" data-src="${s.id}">
      <div class="simSrcHead"><i style="background:${COLORS[s.kind]}"></i>${esc(s.label)}</div>
      <div class="simFeedLines"></div>
    </div>`).join('');

  return `
  <div class="simWrap">
    <canvas id="simCanvas"></canvas>

    <div class="simHead">
      <div>
        <h2 class="simTitle">How PVE Signal Engine Works</h2>
        <p class="simSub">From market data → intelligence → scoring → signals → learning</p>
      </div>
      <div class="simStatus">
        <div class="simRun"><span class="simDot" id="simDot"></span><span id="simRunTxt">ENGINE SIMULATION RUNNING</span></div>
        <div class="simStats">
          <div><span>Signals Evaluated</span><b id="simStatEval">0</b></div>
          <div><span>Signals Generated</span><b id="simStatGen">0</b></div>
          <div><span>High Confidence</span><b id="simStatHigh">0</b></div>
          <div><span>Journal Records</span><b id="simStatJournal">0</b></div>
        </div>
        <div class="simDemoTag">SIMULATED DEMO DATA — NOT LIVE MARKET DATA</div>
      </div>
    </div>

    <div class="simControls">
      <button class="btn ghost" id="simPause">Pause</button>
      <button class="btn ghost" id="simReset">Reset</button>
      <button class="simToggle on" id="simFlowT">Show Data Flow</button>
      <button class="simToggle on" id="simLearnT">Show Learning Loop</button>
      <span class="simHint">click any stage to highlight its connections</span>
    </div>

    <div class="simGrid">
      <section class="simStage" data-stage="sources">
        <h3>1 · Data Sources</h3>
        <div class="simSrcs">${srcPanels}</div>
      </section>

      <section class="simStage" data-stage="features">
        <h3>2 · Feature Engineering</h3>
        <div class="simFeatures" id="simFeatures"></div>
      </section>

      <section class="simStage simEngine" data-stage="engine">
        <h3>3 · PVE Scoring Engine</h3>
        <div class="simRingWrap">
          <svg viewBox="0 0 180 180" class="simRing">
            <circle cx="90" cy="90" r="78" class="simRingBg"></circle>
            <circle cx="90" cy="90" r="78" id="simRingFg" class="simRingFg" transform="rotate(-90 90 90)"></circle>
          </svg>
          <div class="simRingCenter">
            <div class="simRingLabel">PVE SCORE</div>
            <div class="simScoreNum" id="simScoreNum">0</div>
            <div class="simScoreTier" id="simScoreTier">BUILDING</div>
          </div>
        </div>
        <div class="simMath">
          <span>OPTIONS <b id="simOptVal">0</b></span><i>+</i>
          <span>STOCK <b id="simStkVal">0</b></span><i>=</i>
          <span class="simMathSum">PVE <b id="simSumVal">0</b></span>
        </div>
        <div class="simSplit">
          <div><h4>Options Intelligence · 60%</h4><div class="simComps" id="simOptComp"></div></div>
          <div><h4>Stock Confirmation · 40%</h4><div class="simComps" id="simStkComp"></div></div>
        </div>
      </section>

      <section class="simStage" data-stage="signal">
        <h3>4 · Signal Generation</h3>
        <div id="simSignal"></div>
      </section>

      <section class="simStage" data-stage="journal">
        <h3>5 · Signal Journal</h3>
        <div class="simJmeta">ticker · type · score · time · entry · target · stop · why · context · features</div>
        <div id="simJournal"></div>
      </section>

      <section class="simStage" data-stage="perf">
        <h3>6 · Performance Tracking</h3>
        <div id="simPerf"></div>
      </section>

      <section class="simStage" data-stage="learn">
        <h3>7 · Learning &amp; Improvement</h3>
        <div id="simLearn"></div>
        <div class="simLoopNote">↺ feeds back into the scoring engine</div>
      </section>
    </div>
  </div>`;
}
