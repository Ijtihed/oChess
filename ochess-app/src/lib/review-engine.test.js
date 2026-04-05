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
});
