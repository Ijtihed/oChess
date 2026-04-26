/**
 * Review-card storage for oChess.
 *
 * Cards are written by PuzzlesPage / AnalysisPage / GameScreen into
 * localStorage under `ochess_review_cards`. Their shape varies (see
 * the writers) but they all carry at least `fen`, `type`, `ts`.
 *
 * Scheduling state is stored separately in `ochess_review_schedule`
 * keyed by a stable card id, so refreshing the queue doesn't reset
 * what the user has already practiced. The SM-2 algorithm itself
 * lives in `review-engine.js` and is unchanged.
 */

import { createScheduleState, computeNextReview, isDue, RATING } from "./review-engine";

const CARDS_KEY = "ochess_review_cards";
const SCHEDULE_KEY = "ochess_review_schedule";

/** Stable id for a card. Card writers may use shapes that don't include
 *  `id`, so we fall back to a hash of `fen + type + ts` so two cards
 *  for the same position from different times are still distinct. */
export function cardId(card) {
  if (card?.id) return String(card.id);
  return [card?.type || "x", card?.fen || "", card?.ts || 0].join("|");
}

export function loadCards() {
  try {
    const raw = JSON.parse(localStorage.getItem(CARDS_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.map((c, i) => ({ ...c, ts: c.ts || i }));
  } catch { return []; }
}

export function saveCards(cards) {
  try { localStorage.setItem(CARDS_KEY, JSON.stringify(cards)); } catch {}
}

export function removeCard(cards, id) {
  return cards.filter((c) => cardId(c) !== id);
}

export function loadSchedules() {
  try {
    const raw = JSON.parse(localStorage.getItem(SCHEDULE_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

export function saveSchedules(map) {
  try { localStorage.setItem(SCHEDULE_KEY, JSON.stringify(map)); } catch {}
}

/** Get the schedule for a card, lazily creating one on first review. */
export function getSchedule(map, id) {
  const s = map[id];
  if (s && s.dueAt) return { ...s, dueAt: new Date(s.dueAt), lastReviewedAt: s.lastReviewedAt ? new Date(s.lastReviewedAt) : null };
  return createScheduleState();
}

export function setSchedule(map, id, schedule) {
  return { ...map, [id]: schedule };
}

export function isCardDue(map, id) {
  const s = map[id];
  if (!s) return true; // Brand-new cards are always due.
  return isDue(s);
}

/** Apply a rating to a card, returning the updated schedule map. */
export function rateCard(map, id, rating) {
  const current = getSchedule(map, id);
  const next = computeNextReview(current, rating);
  return setSchedule(map, id, next);
}

export { RATING };
