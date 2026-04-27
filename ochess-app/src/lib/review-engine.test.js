import { describe, it, expect } from "vitest";
import { RATING, createScheduleState, computeNextReview, isDue } from "./review-engine";

describe("createScheduleState", () => {
  it("returns a fresh schedule with default values", () => {
    const s = createScheduleState();
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

describe("computeNextReview", () => {
  it("AGAIN resets repetitions and sets interval to 1", () => {
    const s = createScheduleState();
    const next = computeNextReview(s, RATING.AGAIN);
    expect(next.repetitions).toBe(0);
    expect(next.intervalDays).toBe(1);
    expect(next.lapseCount).toBe(1);
    expect(next.easeFactor).toBeLessThan(2.5);
    expect(next.lastReviewedAt).toBeInstanceOf(Date);
  });

  it("GOOD on first review sets interval to 1, then 6", () => {
    const s = createScheduleState();
    const first = computeNextReview(s, RATING.GOOD);
    expect(first.intervalDays).toBe(1);
    expect(first.repetitions).toBe(1);

    const second = computeNextReview(first, RATING.GOOD);
    expect(second.intervalDays).toBe(6);
    expect(second.repetitions).toBe(2);
  });

  it("EASY gives a longer interval than GOOD", () => {
    const s = createScheduleState();
    const afterGood = computeNextReview(computeNextReview(computeNextReview(s, RATING.GOOD), RATING.GOOD), RATING.GOOD);
    const afterEasy = computeNextReview(computeNextReview(computeNextReview(s, RATING.GOOD), RATING.GOOD), RATING.EASY);
    expect(afterEasy.intervalDays).toBeGreaterThan(afterGood.intervalDays);
  });

  it("HARD shortens the interval", () => {
    const s = createScheduleState();
    const afterGood = computeNextReview(computeNextReview(computeNextReview(s, RATING.GOOD), RATING.GOOD), RATING.GOOD);
    const afterHard = computeNextReview(computeNextReview(computeNextReview(s, RATING.GOOD), RATING.GOOD), RATING.HARD);
    expect(afterHard.intervalDays).toBeLessThanOrEqual(afterGood.intervalDays);
  });

  it("ease factor never drops below 1.3", () => {
    let s = createScheduleState();
    for (let i = 0; i < 20; i++) s = computeNextReview(s, RATING.AGAIN);
    expect(s.easeFactor).toBe(1.3);
  });

  it("dueAt is in the future after a review", () => {
    const next = computeNextReview(createScheduleState(), RATING.GOOD);
    expect(new Date(next.dueAt).getTime()).toBeGreaterThan(Date.now() - 1000);
  });
});

describe("isDue", () => {
  it("returns true for past dueAt", () => {
    expect(isDue({ dueAt: new Date(Date.now() - 1000) })).toBe(true);
  });

  it("returns false for future dueAt", () => {
    expect(isDue({ dueAt: new Date(Date.now() + 100000) })).toBe(false);
  });

  // Regression: a corrupted/missing dueAt used to silently wedge the
  // card as "never due" because new Date(undefined) is Invalid Date
  // and any comparison with it returns false. Treat corrupted state
  // as due so the user can rescue the card by reviewing it.
  it("returns true for missing dueAt", () => {
    expect(isDue({})).toBe(true);
    expect(isDue(null)).toBe(true);
    expect(isDue({ dueAt: null })).toBe(true);
  });

  it("returns true for non-parseable dueAt strings", () => {
    expect(isDue({ dueAt: "not a date" })).toBe(true);
    expect(isDue({ dueAt: "" })).toBe(true);
  });
});

describe("computeNextReview - hardening", () => {
  it("clamps an unknown rating value to GOOD instead of producing NaN", () => {
    const s = createScheduleState();
    const next = computeNextReview(s, 99);
    expect(Number.isFinite(next.intervalDays)).toBe(true);
    expect(next.intervalDays).toBe(1); // first review treated as GOOD → interval 1
  });

  it("recovers from a corrupted incoming schedule (NaN ease, missing fields)", () => {
    const corrupted = { easeFactor: NaN, intervalDays: NaN, repetitions: undefined };
    const next = computeNextReview(corrupted, RATING.GOOD);
    expect(Number.isFinite(next.easeFactor)).toBe(true);
    expect(Number.isFinite(next.intervalDays)).toBe(true);
    expect(next.intervalDays).toBeGreaterThanOrEqual(1);
  });

  it("caps interval growth at 5 years even after many EASY ratings", () => {
    let s = createScheduleState();
    for (let i = 0; i < 100; i++) s = computeNextReview(s, RATING.EASY);
    expect(s.intervalDays).toBeLessThanOrEqual(365 * 5);
    // The cap should actually be hit, not just respected by accident.
    expect(s.intervalDays).toBe(365 * 5);
  });

  it("never returns intervalDays below 1", () => {
    let s = createScheduleState();
    for (let i = 0; i < 20; i++) s = computeNextReview(s, RATING.AGAIN);
    expect(s.intervalDays).toBeGreaterThanOrEqual(1);
  });
});
