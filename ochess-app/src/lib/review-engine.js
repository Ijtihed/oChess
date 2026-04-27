/**
 * Review engine — full Anki-style spaced repetition for oChess.
 *
 * The previous version was a pared-down SM-2 that jumped straight
 * from "new" to graduated review intervals. Real Anki has a richer
 * lifecycle that this rewrite tracks faithfully:
 *
 *     NEW  ─Good→  LEARNING (step 0 → step 1 → graduate)
 *           │
 *           └─Easy→ REVIEW (4-day interval)
 *
 *     REVIEW
 *           Again→ RELEARNING  (then back to REVIEW with reduced interval)
 *           Hard / Good / Easy → REVIEW (interval grows by ease and
 *                                 per-rating modifiers)
 *
 *     RELEARNING
 *           Again→ restart relearning step 0
 *           Hard → repeat current step a bit longer
 *           Good→ next step or graduate back to REVIEW
 *           Easy→ graduate immediately
 *
 * Defaults follow Anki's stock card type:
 *   Learning steps:   1m, 10m
 *   Relearning steps: 10m
 *   Graduating interval (Good): 1 day
 *   Easy graduating interval:   4 days
 *   Easy bonus:                 1.3
 *   Hard interval factor:       1.2
 *   Per-rating ease deltas:     Again -0.20, Hard -0.15, Good 0, Easy +0.15
 *   Min ease:                   1.3
 *   Max interval:               5 years (operational sanity cap)
 *
 * Schedules persisted by an older oChess client (which only had
 * `dueAt / easeFactor / intervalDays / repetitions / lapseCount /
 * lastReviewedAt`) are migrated transparently: if `state` is
 * missing, we infer "review" when there's a non-zero interval and
 * "new" otherwise. Existing user progress is preserved.
 */

const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;
const MAX_INTERVAL_DAYS = 365 * 5;

const LEARNING_STEPS_MIN = [1, 10];
const RELEARNING_STEPS_MIN = [10];
const GRADUATING_INTERVAL_DAYS = 1;
const EASY_GRADUATING_INTERVAL_DAYS = 4;
const HARD_INTERVAL_FACTOR = 1.2;
const EASY_BONUS = 1.3;

const EASE_DELTA_AGAIN = -0.20;
const EASE_DELTA_HARD = -0.15;
const EASE_DELTA_GOOD = 0;
const EASE_DELTA_EASY = +0.15;

const RATING = Object.freeze({
  AGAIN: 1,
  HARD: 2,
  GOOD: 3,
  EASY: 4,
});

const STATE = Object.freeze({
  NEW: "new",
  LEARNING: "learning",
  REVIEW: "review",
  RELEARNING: "relearning",
});

function clampEase(e) {
  return Math.max(MIN_EASE, Number.isFinite(e) ? e : DEFAULT_EASE);
}

function clampInterval(d) {
  if (!Number.isFinite(d)) return 1;
  return Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(d)));
}

function clampRating(r) {
  return r === RATING.AGAIN || r === RATING.HARD || r === RATING.GOOD || r === RATING.EASY
    ? r
    : RATING.GOOD;
}

/** Convert a sub-day step (in minutes) to a future Date. */
function dateInMinutes(min) {
  return new Date(Date.now() + Math.max(1, Math.round(min)) * 60_000);
}

/** Convert N whole days to a future Date. */
function dateInDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + Math.max(1, Math.round(days)));
  return d;
}

function createScheduleState() {
  return {
    state: STATE.NEW,
    step: 0,
    easeFactor: DEFAULT_EASE,
    intervalDays: 0,
    intervalMs: 0,
    repetitions: 0,
    lapseCount: 0,
    dueAt: new Date(),
    lastReviewedAt: null,
  };
}

/**
 * Take whatever shape the schedule arrived in (current full
 * Anki shape, pre-Anki simple shape, or partial corruption) and
 * return a sanitized object with every field set to a sensible
 * default. This is the migration boundary - downstream code can
 * trust the shape after this.
 */
function sanitize(schedule) {
  const s = schedule && typeof schedule === "object" ? schedule : {};
  const intervalDays = Number.isFinite(s.intervalDays) ? s.intervalDays : 0;
  const repetitions = Number.isFinite(s.repetitions) ? s.repetitions : 0;
  const inferredState = intervalDays > 0 || repetitions > 0 ? STATE.REVIEW : STATE.NEW;
  // Validate the persisted state against the known set; anything
  // unrecognized falls back to the inferred state.
  const validState = [STATE.NEW, STATE.LEARNING, STATE.REVIEW, STATE.RELEARNING].includes(s.state)
    ? s.state
    : inferredState;
  return {
    state: validState,
    step: Number.isFinite(s.step) ? Math.max(0, s.step) : 0,
    easeFactor: clampEase(s.easeFactor),
    intervalDays,
    intervalMs: Number.isFinite(s.intervalMs) ? s.intervalMs : 0,
    repetitions,
    lapseCount: Number.isFinite(s.lapseCount) ? s.lapseCount : 0,
    dueAt: s.dueAt || new Date(),
    lastReviewedAt: s.lastReviewedAt || null,
  };
}

// ─── Per-state transitions ────────────────────────────────────────

function transitionLearning(s, r) {
  if (r === RATING.AGAIN) {
    s.step = 0;
    s.intervalMs = LEARNING_STEPS_MIN[0] * 60_000;
    s.dueAt = dateInMinutes(LEARNING_STEPS_MIN[0]);
    return;
  }
  if (r === RATING.HARD) {
    // Stay on the current step but a bit longer than the step
    // would normally last.
    const cur = LEARNING_STEPS_MIN[s.step] ?? LEARNING_STEPS_MIN[0];
    const nudged = Math.max(1, Math.round(cur * 1.5));
    s.intervalMs = nudged * 60_000;
    s.dueAt = dateInMinutes(nudged);
    return;
  }
  if (r === RATING.GOOD) {
    const next = s.step + 1;
    if (next >= LEARNING_STEPS_MIN.length) {
      s.state = STATE.REVIEW;
      s.step = 0;
      s.intervalDays = clampInterval(GRADUATING_INTERVAL_DAYS);
      s.intervalMs = 0;
      s.repetitions += 1;
      s.dueAt = dateInDays(s.intervalDays);
    } else {
      s.step = next;
      s.intervalMs = LEARNING_STEPS_MIN[next] * 60_000;
      s.dueAt = dateInMinutes(LEARNING_STEPS_MIN[next]);
    }
    return;
  }
  if (r === RATING.EASY) {
    s.state = STATE.REVIEW;
    s.step = 0;
    s.intervalDays = clampInterval(EASY_GRADUATING_INTERVAL_DAYS);
    s.intervalMs = 0;
    s.repetitions += 1;
    s.dueAt = dateInDays(s.intervalDays);
  }
}

function transitionReview(s, r) {
  if (r === RATING.AGAIN) {
    s.lapseCount += 1;
    s.easeFactor = clampEase(s.easeFactor + EASE_DELTA_AGAIN);
    s.state = STATE.RELEARNING;
    s.step = 0;
    s.intervalMs = RELEARNING_STEPS_MIN[0] * 60_000;
    // Keep `intervalDays` recorded - we shrink the post-relearn
    // interval, but losing it entirely would force the user back
    // through the full learning curve after every lapse.
    s.dueAt = dateInMinutes(RELEARNING_STEPS_MIN[0]);
    return;
  }
  if (r === RATING.HARD) {
    s.easeFactor = clampEase(s.easeFactor + EASE_DELTA_HARD);
    s.intervalDays = clampInterval(s.intervalDays * HARD_INTERVAL_FACTOR);
    s.repetitions += 1;
    s.dueAt = dateInDays(s.intervalDays);
    return;
  }
  if (r === RATING.GOOD) {
    s.easeFactor = clampEase(s.easeFactor + EASE_DELTA_GOOD);
    s.intervalDays = clampInterval(s.intervalDays * s.easeFactor);
    s.repetitions += 1;
    s.dueAt = dateInDays(s.intervalDays);
    return;
  }
  if (r === RATING.EASY) {
    s.easeFactor = clampEase(s.easeFactor + EASE_DELTA_EASY);
    s.intervalDays = clampInterval(s.intervalDays * s.easeFactor * EASY_BONUS);
    s.repetitions += 1;
    s.dueAt = dateInDays(s.intervalDays);
  }
}

function transitionRelearning(s, r) {
  if (r === RATING.AGAIN) {
    s.step = 0;
    s.intervalMs = RELEARNING_STEPS_MIN[0] * 60_000;
    s.dueAt = dateInMinutes(RELEARNING_STEPS_MIN[0]);
    return;
  }
  if (r === RATING.HARD) {
    const cur = RELEARNING_STEPS_MIN[s.step] ?? RELEARNING_STEPS_MIN[0];
    const nudged = Math.max(1, Math.round(cur * 1.5));
    s.intervalMs = nudged * 60_000;
    s.dueAt = dateInMinutes(nudged);
    return;
  }
  if (r === RATING.GOOD) {
    const next = s.step + 1;
    if (next >= RELEARNING_STEPS_MIN.length) {
      // Graduate back to review. Use a short interval (1d) to
      // re-bridge the user toward their previous schedule.
      s.state = STATE.REVIEW;
      s.step = 0;
      // Take the smaller of the previous interval (lightly punished)
      // and the standard graduating interval, so a card that was
      // previously at 30d doesn't snap straight back to 30d.
      const punished = Math.max(1, Math.round((s.intervalDays || 1) * 0.5));
      s.intervalDays = clampInterval(Math.min(punished, GRADUATING_INTERVAL_DAYS));
      s.intervalMs = 0;
      s.repetitions += 1;
      s.dueAt = dateInDays(s.intervalDays);
    } else {
      s.step = next;
      s.intervalMs = RELEARNING_STEPS_MIN[next] * 60_000;
      s.dueAt = dateInMinutes(RELEARNING_STEPS_MIN[next]);
    }
    return;
  }
  if (r === RATING.EASY) {
    // Easy on a relearning card → graduate immediately, with a
    // mid-sized interval (don't fully restore to pre-lapse).
    s.state = STATE.REVIEW;
    s.step = 0;
    const restore = Math.max(1, Math.round((s.intervalDays || 1) * 1.0));
    s.intervalDays = clampInterval(Math.max(GRADUATING_INTERVAL_DAYS, restore));
    s.intervalMs = 0;
    s.repetitions += 1;
    s.dueAt = dateInDays(s.intervalDays);
  }
}

function computeNextReview(schedule, rating) {
  const s = sanitize(schedule);
  s.lastReviewedAt = new Date();
  const r = clampRating(rating);
  // NEW collapses to LEARNING for the actual transition - the
  // distinction only matters for the predicted-interval UI hints,
  // which can read STATE.NEW separately if it wants to.
  if (s.state === STATE.NEW || s.state === STATE.LEARNING) {
    s.state = STATE.LEARNING;
    transitionLearning(s, r);
  } else if (s.state === STATE.REVIEW) {
    transitionReview(s, r);
  } else {
    transitionRelearning(s, r);
  }
  return s;
}

function isDue(schedule) {
  if (!schedule || !schedule.dueAt) return true;
  const t = new Date(schedule.dueAt).getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() >= t;
}

/**
 * Predict the next interval for each rating without mutating the
 * card's actual schedule. Used by the rating-button UI to show
 * "Again 1m / Hard 10m / Good 1d / Easy 4d" - real Anki UX.
 *
 * @returns {{ AGAIN: string, HARD: string, GOOD: string, EASY: string }}
 *          Human-readable interval per rating ("1m", "10m", "3d",
 *          "1.5mo"). Strings, not numbers, so the UI can render
 *          them without a formatter.
 */
function predictNextIntervals(schedule) {
  const result = {};
  for (const [label, rating] of [
    ["AGAIN", RATING.AGAIN],
    ["HARD", RATING.HARD],
    ["GOOD", RATING.GOOD],
    ["EASY", RATING.EASY],
  ]) {
    const next = computeNextReview(schedule, rating);
    result[label] = formatInterval(next);
  }
  return result;
}

function formatInterval(schedule) {
  const due = new Date(schedule.dueAt).getTime();
  const ms = Math.max(0, due - Date.now());
  const minutes = ms / 60_000;
  if (minutes < 60) {
    const m = Math.max(1, Math.round(minutes));
    return `${m}m`;
  }
  const hours = minutes / 60;
  if (hours < 24) {
    const h = Math.max(1, Math.round(hours));
    return `${h}h`;
  }
  const days = hours / 24;
  if (days < 30) {
    return `${Math.max(1, Math.round(days))}d`;
  }
  const months = days / 30;
  if (months < 12) {
    return `${months.toFixed(months < 3 ? 1 : 0)}mo`;
  }
  const years = days / 365;
  return `${years.toFixed(1)}y`;
}

export {
  RATING,
  STATE,
  createScheduleState,
  computeNextReview,
  isDue,
  predictNextIntervals,
  formatInterval,
  sanitize,
};
