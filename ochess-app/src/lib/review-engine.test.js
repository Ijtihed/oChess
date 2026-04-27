import { describe, it, expect } from "vitest";
import {
  RATING,
  STATE,
  createScheduleState,
  computeNextReview,
  isDue,
  predictNextIntervals,
  formatInterval,
  sanitize,
} from "./review-engine";

describe("createScheduleState", () => {
  it("returns a fresh card in NEW state", () => {
    const s = createScheduleState();
    expect(s.state).toBe(STATE.NEW);
    expect(s.step).toBe(0);
    expect(s.easeFactor).toBe(2.5);
    expect(s.intervalDays).toBe(0);
    expect(s.repetitions).toBe(0);
    expect(s.lapseCount).toBe(0);
    expect(s.lastReviewedAt).toBeNull();
    expect(s.dueAt).toBeInstanceOf(Date);
  });

  it("is immediately due", () => {
    expect(isDue(createScheduleState())).toBe(true);
  });
});

describe("learning steps (NEW → LEARNING)", () => {
  it("GOOD on a NEW card moves through learning steps before graduating", () => {
    const s = createScheduleState();
    // Step 0 → step 1: 10 min interval (sub-day, intervalDays stays 0).
    const step1 = computeNextReview(s, RATING.GOOD);
    expect(step1.state).toBe(STATE.LEARNING);
    expect(step1.step).toBe(1);
    expect(step1.intervalDays).toBe(0);
    expect(step1.intervalMs).toBeGreaterThanOrEqual(60_000);
    // Step 1 → graduation: state flips to REVIEW with 1d interval.
    const graduated = computeNextReview(step1, RATING.GOOD);
    expect(graduated.state).toBe(STATE.REVIEW);
    expect(graduated.intervalDays).toBe(1);
    expect(graduated.repetitions).toBe(1);
  });

  it("EASY on a NEW card graduates immediately to a 4-day interval", () => {
    const s = createScheduleState();
    const next = computeNextReview(s, RATING.EASY);
    expect(next.state).toBe(STATE.REVIEW);
    expect(next.intervalDays).toBe(4);
  });

  it("AGAIN in learning resets the step to 0", () => {
    let s = createScheduleState();
    s = computeNextReview(s, RATING.GOOD); // step 1
    s = computeNextReview(s, RATING.AGAIN);
    expect(s.state).toBe(STATE.LEARNING);
    expect(s.step).toBe(0);
  });

  it("HARD in learning extends the current step but does not advance it", () => {
    let s = createScheduleState();
    s = computeNextReview(s, RATING.GOOD); // step 1
    const before = s.step;
    s = computeNextReview(s, RATING.HARD);
    expect(s.step).toBe(before);
    expect(s.state).toBe(STATE.LEARNING);
  });
});

describe("review-state intervals (REVIEW)", () => {
  function maturedCard() {
    let s = createScheduleState();
    s = computeNextReview(s, RATING.GOOD); // → step 1
    s = computeNextReview(s, RATING.GOOD); // → REVIEW, 1d
    return s;
  }

  it("GOOD multiplies the interval by ease (≈ 2.5x)", () => {
    let s = maturedCard(); // 1 day, ease 2.5
    s = computeNextReview(s, RATING.GOOD);
    expect(s.intervalDays).toBeGreaterThanOrEqual(2);
    expect(s.intervalDays).toBeLessThanOrEqual(4);
  });

  it("HARD shrinks the interval and lowers ease", () => {
    const baseline = maturedCard();
    const baselineGood = computeNextReview(baseline, RATING.GOOD);
    const hard = computeNextReview(baseline, RATING.HARD);
    expect(hard.intervalDays).toBeLessThan(baselineGood.intervalDays);
    expect(hard.easeFactor).toBeLessThan(baseline.easeFactor);
  });

  it("EASY grows the interval and raises ease", () => {
    // Need a card with a larger interval for the multiplier
    // difference (good = ease, easy = ease * 1.3 + ease delta) to
    // separate after rounding. At 1-day intervals both round to 3
    // days; at 10 days the gap is meaningful.
    let baseline = maturedCard();
    baseline = computeNextReview(baseline, RATING.GOOD); // ~3d
    baseline = computeNextReview(baseline, RATING.GOOD); // ~7d
    const baselineGood = computeNextReview(baseline, RATING.GOOD);
    const easy = computeNextReview(baseline, RATING.EASY);
    expect(easy.intervalDays).toBeGreaterThan(baselineGood.intervalDays);
    expect(easy.easeFactor).toBeGreaterThan(baseline.easeFactor);
  });

  it("AGAIN on a REVIEW card lapses into RELEARNING", () => {
    const baseline = maturedCard();
    const lapsed = computeNextReview(baseline, RATING.AGAIN);
    expect(lapsed.state).toBe(STATE.RELEARNING);
    expect(lapsed.lapseCount).toBe(baseline.lapseCount + 1);
    expect(lapsed.easeFactor).toBeLessThan(baseline.easeFactor);
  });

  it("ease never drops below 1.3 even after many AGAINs in REVIEW", () => {
    let s = createScheduleState();
    s = computeNextReview(s, RATING.GOOD);
    s = computeNextReview(s, RATING.GOOD); // get into REVIEW
    for (let i = 0; i < 20; i++) {
      s = computeNextReview(s, RATING.AGAIN); // lapse → relearning
      s = computeNextReview(s, RATING.GOOD);  // back to review
    }
    expect(s.easeFactor).toBe(1.3);
  });
});

describe("relearning (REVIEW → RELEARNING → REVIEW)", () => {
  function lapsedCard() {
    let s = createScheduleState();
    s = computeNextReview(s, RATING.GOOD);
    s = computeNextReview(s, RATING.GOOD); // REVIEW, 1d
    s = computeNextReview(s, RATING.AGAIN); // RELEARNING
    return s;
  }

  it("GOOD on a relearning card with one step graduates back to REVIEW", () => {
    const s = lapsedCard();
    const recovered = computeNextReview(s, RATING.GOOD);
    expect(recovered.state).toBe(STATE.REVIEW);
    expect(recovered.intervalDays).toBeGreaterThanOrEqual(1);
  });

  it("AGAIN on a relearning card resets the step", () => {
    const s = lapsedCard();
    const reset = computeNextReview(s, RATING.AGAIN);
    expect(reset.state).toBe(STATE.RELEARNING);
    expect(reset.step).toBe(0);
  });

  it("EASY on a relearning card graduates immediately", () => {
    const s = lapsedCard();
    const recovered = computeNextReview(s, RATING.EASY);
    expect(recovered.state).toBe(STATE.REVIEW);
  });
});

describe("predictNextIntervals", () => {
  it("returns a label per rating without mutating the schedule", () => {
    const s = createScheduleState();
    const before = JSON.stringify(s);
    const out = predictNextIntervals(s);
    expect(out).toHaveProperty("AGAIN");
    expect(out).toHaveProperty("HARD");
    expect(out).toHaveProperty("GOOD");
    expect(out).toHaveProperty("EASY");
    // No mutation.
    expect(JSON.stringify(s)).toBe(before);
  });

  it("on a NEW card, GOOD predicts a sub-day step (10m) and EASY predicts days", () => {
    const s = createScheduleState();
    const out = predictNextIntervals(s);
    expect(out.GOOD).toMatch(/m$/); // sub-hour
    expect(out.EASY).toMatch(/d$/); // days
  });

  it("on a mature REVIEW card, AGAIN predicts a sub-hour relearning step", () => {
    let s = createScheduleState();
    s = computeNextReview(s, RATING.GOOD);
    s = computeNextReview(s, RATING.GOOD);
    s = computeNextReview(s, RATING.GOOD); // bigger interval now
    const out = predictNextIntervals(s);
    expect(out.AGAIN).toMatch(/m$|h$/);
    expect(out.GOOD).toMatch(/d$|mo$/);
  });
});

describe("formatInterval", () => {
  it("formats sub-hour intervals as minutes", () => {
    expect(formatInterval({ dueAt: new Date(Date.now() + 60_000) })).toMatch(/m$/);
  });

  it("formats hour-scale intervals as hours", () => {
    expect(formatInterval({ dueAt: new Date(Date.now() + 2 * 3600_000) })).toMatch(/h$/);
  });

  it("formats day-scale intervals as days", () => {
    expect(formatInterval({ dueAt: new Date(Date.now() + 3 * 86_400_000) })).toMatch(/d$/);
  });

  it("formats year-scale intervals as years", () => {
    expect(formatInterval({ dueAt: new Date(Date.now() + 730 * 86_400_000) })).toMatch(/y$/);
  });
});

describe("isDue", () => {
  it("returns true for past dueAt", () => {
    expect(isDue({ dueAt: new Date(Date.now() - 1000) })).toBe(true);
  });

  it("returns false for future dueAt", () => {
    expect(isDue({ dueAt: new Date(Date.now() + 100000) })).toBe(false);
  });

  it("returns true for missing or non-parseable dueAt", () => {
    expect(isDue({})).toBe(true);
    expect(isDue(null)).toBe(true);
    expect(isDue({ dueAt: "garbage" })).toBe(true);
  });
});

describe("sanitize - migration of legacy schedules", () => {
  it("treats a legacy schedule with intervalDays > 0 as REVIEW state", () => {
    const legacy = { dueAt: new Date(), easeFactor: 2.5, intervalDays: 14, repetitions: 5, lapseCount: 0 };
    const out = sanitize(legacy);
    expect(out.state).toBe(STATE.REVIEW);
    expect(out.intervalDays).toBe(14);
    expect(out.easeFactor).toBe(2.5);
  });

  it("treats a fresh / blank schedule as NEW state", () => {
    expect(sanitize({}).state).toBe(STATE.NEW);
    expect(sanitize(null).state).toBe(STATE.NEW);
  });

  it("falls back to a fresh state for unrecognized state values", () => {
    expect(sanitize({ state: "not-a-state", intervalDays: 0 }).state).toBe(STATE.NEW);
    expect(sanitize({ state: "not-a-state", intervalDays: 5 }).state).toBe(STATE.REVIEW);
  });

  it("recovers numeric fields when corrupted (NaN / undefined)", () => {
    const out = sanitize({ easeFactor: NaN, intervalDays: undefined, repetitions: NaN });
    expect(out.easeFactor).toBe(2.5);
    expect(out.intervalDays).toBe(0);
    expect(out.repetitions).toBe(0);
  });
});

describe("computeNextReview - hardening", () => {
  it("clamps an unknown rating value to GOOD", () => {
    const s = createScheduleState();
    const next = computeNextReview(s, 99);
    // Unknown rating treated as GOOD; on a NEW card, GOOD advances to learning step 1
    expect(next.state).toBe(STATE.LEARNING);
    expect(next.step).toBe(1);
  });

  it("recovers from a corrupted incoming schedule (NaN ease, missing fields)", () => {
    const corrupted = { easeFactor: NaN, intervalDays: NaN, repetitions: undefined };
    const next = computeNextReview(corrupted, RATING.GOOD);
    expect(Number.isFinite(next.easeFactor)).toBe(true);
    // Either learning (sub-day) or review (1d+); both are valid recoveries.
    expect(next.state).toMatch(/^(learning|review)$/);
  });

  it("caps interval growth at 5 years", () => {
    let s = createScheduleState();
    s = computeNextReview(s, RATING.GOOD);
    s = computeNextReview(s, RATING.GOOD); // REVIEW, 1d
    for (let i = 0; i < 100; i++) s = computeNextReview(s, RATING.EASY);
    expect(s.intervalDays).toBeLessThanOrEqual(365 * 5);
    expect(s.intervalDays).toBe(365 * 5); // cap is hit
  });
});
