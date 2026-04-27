/**
 * Review engine - spaced repetition scheduling for oChess.
 *
 * Implements SM-2 based scheduling. Separated from UI and card content
 * so the algorithm can be swapped (e.g. FSRS) without touching components.
 */

const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;

const RATING = Object.freeze({
  AGAIN: 1,
  HARD: 2,
  GOOD: 3,
  EASY: 4,
});

function createScheduleState() {
  return {
    dueAt: new Date(),
    easeFactor: DEFAULT_EASE,
    intervalDays: 0,
    repetitions: 0,
    lapseCount: 0,
    lastReviewedAt: null,
  };
}

function computeNextReview(schedule, rating) {
  const s = { ...schedule };
  s.lastReviewedAt = new Date();

  if (rating === RATING.AGAIN) {
    s.repetitions = 0;
    s.intervalDays = 1;
    s.lapseCount += 1;
    s.easeFactor = Math.max(MIN_EASE, s.easeFactor - 0.2);
  } else {
    if (s.repetitions === 0) {
      s.intervalDays = 1;
    } else if (s.repetitions === 1) {
      s.intervalDays = 6;
    } else {
      s.intervalDays = Math.round(s.intervalDays * s.easeFactor);
    }

    s.easeFactor = Math.max(
      MIN_EASE,
      s.easeFactor + (0.1 - (5 - rating) * (0.08 + (5 - rating) * 0.02))
    );

    if (rating === RATING.HARD) {
      s.intervalDays = Math.max(1, Math.round(s.intervalDays * 0.8));
    } else if (rating === RATING.EASY) {
      s.intervalDays = Math.round(s.intervalDays * 1.3);
    }

    s.repetitions += 1;
  }

  const due = new Date(s.lastReviewedAt);
  due.setDate(due.getDate() + s.intervalDays);
  s.dueAt = due;

  return s;
}

function isDue(schedule) {
  return new Date() >= new Date(schedule.dueAt);
}

export { RATING, createScheduleState, computeNextReview, isDue };
