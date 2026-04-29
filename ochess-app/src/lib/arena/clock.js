/**
 * Deadline-based clock for AI Arena round play.
 *
 * Survives reload + disconnect by storing only authoritative
 * facts in the room row (`round_state.clock`) and computing
 * the live remaining-time on each render. No setInterval
 * state-of-truth - if you reload the page mid-game your clock
 * picks up exactly where it should because it's derived from
 * fields that exist in the database.
 *
 * Stored shape (one entry per active round in `round_state`):
 *
 *   round_state.clock = {
 *     budgetMs: 600000,                  // total time per side
 *     creator: { spentMs, turnStartedAtMs?: number },
 *     joiner:  { spentMs, turnStartedAtMs?: number },
 *     // exactly one of {creator,joiner} has turnStartedAtMs
 *     // set whenever it's that side's turn AND the round is
 *     // active. The other side is "paused" with that side's
 *     // accumulated spentMs visible as-is.
 *   }
 *
 * The "running" side accumulates time as
 *
 *   liveSpent = spentMs + (now - turnStartedAtMs)
 *
 * When a move is played, the orchestrator commits that
 * accumulated value back into `spentMs` and starts the
 * opponent's clock by setting their turnStartedAtMs to now.
 *
 * No increment, matching the 10+0 / 1+0 specs. If we add
 * increment later, append a `delta` to the move-commit step.
 */

import { ROUND_CLOCK_MS, TIEBREAK_CLOCK_MS } from "./orchestrator";

// ── Initialization ───────────────────────────────────────

/**
 * Build a fresh clock state for a new round. The first mover
 * gets `turnStartedAtMs` set; the other side is paused.
 *
 * @param {("creator"|"joiner")} firstMover
 * @param {number} budgetMs                     Time per side.
 * @param {number} [now]                        Current epoch ms; defaults to Date.now().
 */
export function initClock(firstMover, budgetMs, now = Date.now()) {
  const other = firstMover === "creator" ? "joiner" : "creator";
  return {
    budgetMs,
    [firstMover]: { spentMs: 0, turnStartedAtMs: now },
    [other]:      { spentMs: 0 },
  };
}

/** Convenience: clock for the round play (10+0). */
export function initRoundClock(firstMover, now) {
  return initClock(firstMover, ROUND_CLOCK_MS, now);
}

/** Convenience: clock for the tie-break (1+0). */
export function initTiebreakClock(firstMover, now) {
  return initClock(firstMover, TIEBREAK_CLOCK_MS, now);
}

// ── Live snapshot ───────────────────────────────────────

/**
 * Compute the live remaining time for both sides given the
 * stored clock state and the current wall-clock time.
 *
 * @param {Object} clock                         The clock object stored in round_state.
 * @param {number} [now]                         Current epoch ms.
 * @returns {{
 *   running: ("creator"|"joiner"|null),
 *   creator: { spentMs, remainingMs, expired: boolean },
 *   joiner:  { spentMs, remainingMs, expired: boolean },
 * }}
 */
export function clockSnapshot(clock, now = Date.now()) {
  if (!clock || !Number.isFinite(clock.budgetMs)) {
    return {
      running: null,
      creator: { spentMs: 0, remainingMs: 0, expired: false },
      joiner:  { spentMs: 0, remainingMs: 0, expired: false },
    };
  }
  let running = null;
  // Use Number.isFinite explicitly because turnStartedAtMs === 0
  // is a legitimate value (e.g. tests that anchor "now" at the
  // epoch). The plain truthy check would treat 0 as "no turn"
  // and skip the running-side compute.
  if (Number.isFinite(clock.creator?.turnStartedAtMs)) running = "creator";
  else if (Number.isFinite(clock.joiner?.turnStartedAtMs)) running = "joiner";

  const compute = (side) => {
    const c = clock[side] || {};
    const baseSpent = Number.isFinite(c.spentMs) ? c.spentMs : 0;
    const liveSpent = Number.isFinite(c.turnStartedAtMs)
      ? baseSpent + Math.max(0, now - c.turnStartedAtMs)
      : baseSpent;
    const clamped = Math.min(clock.budgetMs, liveSpent);
    const remainingMs = Math.max(0, clock.budgetMs - clamped);
    return {
      spentMs: clamped,
      remainingMs,
      expired: remainingMs <= 0,
    };
  };

  return {
    running,
    creator: compute("creator"),
    joiner:  compute("joiner"),
  };
}

// ── Move commit ─────────────────────────────────────────

/**
 * Pure transformer: given the current clock + the role that
 * just moved, produce the next clock state. The mover's
 * accumulated time is committed to `spentMs`, their
 * turnStartedAtMs is cleared, and the opponent's clock starts
 * ticking.
 *
 * If the round is over (move ended the game) the caller can
 * pass `endTurn: false` to commit the mover's time without
 * starting the opponent's clock.
 *
 * @param {Object} clock
 * @param {("creator"|"joiner")} mover           The role that just moved.
 * @param {Object} [opts]
 * @param {boolean} [opts.endTurn=true]          If false, opponent's clock stays paused.
 * @param {number} [opts.now]                    Override "now" for tests.
 * @returns {Object} next clock state
 */
export function commitMove(clock, mover, opts = {}) {
  if (!clock) return clock;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const endTurn = opts.endTurn !== false;
  const opp = mover === "creator" ? "joiner" : "creator";
  const moverState = clock[mover] || { spentMs: 0 };
  const liveSpent = Number.isFinite(moverState.turnStartedAtMs)
    ? Math.min(clock.budgetMs, (moverState.spentMs || 0) + Math.max(0, now - moverState.turnStartedAtMs))
    : (moverState.spentMs || 0);
  const next = {
    ...clock,
    [mover]: { spentMs: liveSpent },
  };
  if (endTurn) {
    const oppState = clock[opp] || { spentMs: 0 };
    next[opp] = { spentMs: oppState.spentMs || 0, turnStartedAtMs: now };
  } else {
    next[opp] = { spentMs: clock[opp]?.spentMs || 0 };
  }
  return next;
}

/**
 * Pause the running side without committing extra time. Used
 * when the round ends abruptly (resign / clock expiry detected
 * by the OPPONENT).
 *
 * Returns the clock with the running side's accumulated time
 * baked into `spentMs` and turnStartedAtMs cleared. The
 * other side's `spentMs` is preserved.
 */
export function pauseClock(clock, now = Date.now()) {
  if (!clock) return clock;
  const snap = clockSnapshot(clock, now);
  const next = { ...clock };
  next.creator = { spentMs: snap.creator.spentMs };
  next.joiner = { spentMs: snap.joiner.spentMs };
  return next;
}

// ── Formatting ──────────────────────────────────────────

/**
 * Format a millisecond duration as "M:SS" (or "MM:SS" / "H:MM:SS"
 * for >= an hour). Used by the clock pill in the UI.
 */
export function formatClock(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}
