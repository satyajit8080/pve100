// Phase 5 (spec §18, §19) — anti-flicker state machine.
// A ticker moves through confirmation STATES; it never flips bull<->bear on one noisy poll.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export const STATES = ['STRONG_BEAR', 'BEAR', 'WATCH_BEAR', 'NEUTRAL', 'WATCH_BULL', 'BULL', 'STRONG_BULL'];

export const DEFAULT_CONFIG = {
  confirmPolls: 3,        // consecutive polls required before a state change
  flipMargin: 10,         // score must beat the opposing threshold by this margin to flip side
  cooldownPolls: 3,       // polls to wait after a side flip before flipping again
  deadband: 5,            // score wiggle that does not count as a change
  ewmaAlpha: 0.3,
  watchThreshold: 55,
  signalThreshold: 65,
  strongThreshold: 80,
};

// Map a smoothed score+direction to its target state.
export function targetState(score, dir, cfg = DEFAULT_CONFIG) {
  if (!isNum(score) || dir == null || dir === 'neutral') return 'NEUTRAL';
  const side = dir === 'bull' ? 'BULL' : 'BEAR';
  if (score >= cfg.strongThreshold) return `STRONG_${side}`;
  if (score >= cfg.signalThreshold) return side;
  if (score >= cfg.watchThreshold) return `WATCH_${side}`;
  return 'NEUTRAL';
}

const sideOf = (state) => (state.includes('BULL') ? 'bull' : state.includes('BEAR') ? 'bear' : 'neutral');

// Advance the state machine by one poll. `prev` is the stored state (or null on first sight).
export function step(prev, { score, dir, at = new Date().toISOString(), cfg = DEFAULT_CONFIG } = {}) {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  const p = prev || { state: 'NEUTRAL', smoothedScore: null, pendingState: null, pendingCount: 0, cooldown: 0, polls: 0, lastFlipAt: null, history: [] };

  // EWMA smoothing of the raw score (spec §18d)
  const smoothed = isNum(score) ? (isNum(p.smoothedScore) ? c.ewmaAlpha * score + (1 - c.ewmaAlpha) * p.smoothedScore : score) : p.smoothedScore;
  const smoothedScore = isNum(smoothed) ? Math.round(smoothed * 100) / 100 : null;

  const want = targetState(smoothedScore, dir, c);
  const curSide = sideOf(p.state), wantSide = sideOf(want);
  const cooldown = Math.max(0, (p.cooldown || 0) - 1);
  const out = { ...p, polls: (p.polls || 0) + 1, smoothedScore, rawScore: isNum(score) ? score : null, cooldown, changed: false, reason: null, at };

  if (want === p.state) { out.pendingState = null; out.pendingCount = 0; out.reason = 'stable'; return out; }

  // dead-band: ignore trivial score wiggle that would only shuffle within the same side
  if (wantSide === curSide && isNum(smoothedScore) && isNum(p.smoothedScore) && Math.abs(smoothedScore - p.smoothedScore) < c.deadband && p.state !== 'NEUTRAL') {
    out.pendingState = null; out.pendingCount = 0; out.reason = 'deadband'; return out;
  }

  // a side FLIP needs the flip margin cleared and no active cooldown
  const isFlip = wantSide !== 'neutral' && curSide !== 'neutral' && wantSide !== curSide;
  if (isFlip) {
    if (cooldown > 0) { out.pendingState = null; out.pendingCount = 0; out.reason = 'cooldown'; return out; }
    if (!isNum(smoothedScore) || smoothedScore < c.signalThreshold + c.flipMargin) {
      out.pendingState = null; out.pendingCount = 0; out.reason = 'flip_margin_not_met'; return out;
    }
  }

  // require N consecutive polls agreeing on the same target before committing
  const pendingCount = p.pendingState === want ? (p.pendingCount || 0) + 1 : 1;
  out.pendingState = want; out.pendingCount = pendingCount;
  if (pendingCount < c.confirmPolls) { out.reason = `confirming ${pendingCount}/${c.confirmPolls}`; return out; }

  out.state = want; out.pendingState = null; out.pendingCount = 0; out.changed = true; out.reason = 'confirmed';
  out.persistencePolls = c.confirmPolls;
  if (isFlip) { out.cooldown = c.cooldownPolls; out.lastFlipAt = at; }
  out.history = [...(p.history || []).slice(-19), { state: want, at, score: smoothedScore }];
  return out;
}

// Is this state actionable (i.e. a real call, not a watch)?
export const isActionable = (state) => ['BULL', 'STRONG_BULL', 'BEAR', 'STRONG_BEAR'].includes(state);
export { sideOf };
