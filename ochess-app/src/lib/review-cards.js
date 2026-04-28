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

import {
  createScheduleState,
  computeNextReview,
  isDue,
  RATING,
  STATE,
  sanitize as sanitizeSchedule,
  predictNextIntervals,
  summarizeSchedule,
  forecastNextDays,
} from "./review-engine";

const CARDS_KEY = "ochess_review_cards";
const SCHEDULE_KEY = "ochess_review_schedule";
const AI_EXPLAIN_KEY = "ochess_review_ai_explanations";

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
    // Defensive: drop any entry that isn't a real card object. A
    // bad write from a different version (or storage tampering)
    // would otherwise crash the .map below trying to spread null.
    return raw
      .filter((c) => c && typeof c === "object" && c.fen)
      .map((c, i) => ({ ...c, ts: c.ts || i }));
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

/**
 * Get the schedule for a card, lazily creating one on first
 * review. Pre-Anki schedules (without the `state` field) are
 * migrated transparently by sanitizeSchedule: cards with a
 * non-zero interval keep their progress as REVIEW state; brand
 * new ones become NEW.
 */
export function getSchedule(map, id) {
  const s = map[id];
  if (!s) return createScheduleState();
  const dueAt = s.dueAt ? new Date(s.dueAt) : new Date(0);
  if (Number.isNaN(dueAt.getTime())) return createScheduleState();
  const lastReviewedAt = s.lastReviewedAt && !Number.isNaN(new Date(s.lastReviewedAt).getTime())
    ? new Date(s.lastReviewedAt)
    : null;
  return sanitizeSchedule({ ...s, dueAt, lastReviewedAt });
}

export function setSchedule(map, id, schedule) {
  return { ...map, [id]: schedule };
}

export function isCardDue(map, id) {
  const s = map[id];
  if (!s) return true; // Brand-new cards are always due.
  if (!s.dueAt) return true; // Corrupted: treat as new.
  const t = new Date(s.dueAt).getTime();
  if (Number.isNaN(t)) return true; // Corrupted: treat as new.
  return Date.now() >= t;
}

/** Apply a rating to a card, returning the updated schedule map. */
export function rateCard(map, id, rating) {
  const current = getSchedule(map, id);
  const next = computeNextReview(current, rating);
  return setSchedule(map, id, next);
}

/**
 * Defer a card without altering its state, ease, or interval - the
 * "skip for now" gesture in the review UI. The card's dueAt is
 * pushed `delayMin` minutes into the future so it falls out of the
 * current queue, then returns later in the session.
 *
 * Distinct from rating the card AGAIN, which would lapse a review
 * card to relearning, drop ease by 0.20, and bump lapseCount. Skip
 * should be cost-free.
 */
export function bumpCardDue(map, id, delayMin = 5) {
  const current = getSchedule(map, id);
  const minutes = Math.max(1, Math.round(delayMin));
  const dueAt = new Date(Date.now() + minutes * 60_000);
  return setSchedule(map, id, { ...current, dueAt });
}

/**
 * Look up "what would the next interval be for each rating button,
 * if I clicked it right now" without mutating anything. Powers the
 * real-Anki "Again 1m / Hard 10m / Good 1d / Easy 4d" hints under
 * the rating buttons.
 */
export function predictIntervalsFor(map, id) {
  return predictNextIntervals(getSchedule(map, id));
}

/**
 * Summarize the deck for the UI's status header. Returns counts by
 * state (new / learning / review / relearning / mature / young /
 * lapsed) plus dueNow / dueToday.
 */
export function summarizeDeck(cards, map) {
  return summarizeSchedule(cards, map);
}

/** 7-day forecast strip data for the Plan tab. */
export function forecastDeckNextDays(cards, map, days = 7) {
  return forecastNextDays(cards, map, days);
}

/**
 * Per-card AI-generated move explanations, cached locally so we
 * never re-spend the rate-limited coach call on a card the user
 * already asked about. Stored separately from cards/schedules so
 * the existing data shapes stay clean and a stale explanation
 * (e.g. card metadata changed) is easy to evict by clearing this
 * one key alone.
 *
 * Shape: { [cardId]: { explanation: string, model?: string, ts: number } }
 */
export function loadAIExplanations() {
  try {
    const raw = JSON.parse(localStorage.getItem(AI_EXPLAIN_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

export function saveAIExplanations(map) {
  try { localStorage.setItem(AI_EXPLAIN_KEY, JSON.stringify(map)); } catch {}
}

export function getAIExplanation(map, id) {
  const entry = map?.[id];
  if (!entry || typeof entry !== "object") return null;
  return typeof entry.explanation === "string" && entry.explanation.trim()
    ? entry.explanation.trim()
    : null;
}

export function setAIExplanation(map, id, explanation, model) {
  if (!id) return map;
  return {
    ...map,
    [id]: {
      explanation: String(explanation || "").slice(0, 1000),
      model: typeof model === "string" ? model : null,
      ts: Date.now(),
    },
  };
}

export { RATING, STATE };

// ─────────────────────────────────────────────────────────────────────
// Card sharing — encode a card to a URL fragment, decode on the
// receiving side, dedupe against the existing deck. Uses a custom
// type marker (`shared`) and a recipient-namespaced id so the same
// card shared twice (or shared and then saved again) doesn't pile up
// duplicates.
// ─────────────────────────────────────────────────────────────────────

const SHARED_FIELDS = [
  "fen", "type", "played_san", "best_san", "answerMove", "answerText",
  "themes", "phase", "opening", "rating", "themes", "source", "source_url",
  "title", "notes",
];

/** URL-safe base64 helpers. We avoid + / = which break in query
 *  params; replace them with - _ and trim. */
function base64UrlEncode(json) {
  const utf8 = unescape(encodeURIComponent(json));
  // btoa is in jsdom; in Node tests we shim with Buffer.
  const b64 = typeof btoa === "function" ? btoa(utf8) : Buffer.from(utf8, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(b64url) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const utf8 = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  return decodeURIComponent(escape(utf8));
}

/**
 * Pack a card down to a shareable string. Strips fields that don't
 * round-trip well (timestamps, ids - the recipient generates fresh
 * ones) and only keeps the per-card content the recipient needs.
 */
export function serializeCardForShare(card) {
  if (!card || typeof card !== "object" || !card.fen) return null;
  const slim = {};
  for (const k of SHARED_FIELDS) {
    if (card[k] !== undefined && card[k] !== null) slim[k] = card[k];
  }
  // Add a shape marker so we can detect malformed payloads on import.
  slim.v = 1;
  try {
    return base64UrlEncode(JSON.stringify(slim));
  } catch {
    return null;
  }
}

/**
 * Decode a share string back to a card. Returns null on any parse
 * failure - never throws. The returned card has a fresh id + ts so
 * it slots into the recipient's deck like any other card.
 */
export function deserializeSharedCard(b64url) {
  if (!b64url || typeof b64url !== "string") return null;
  try {
    const json = base64UrlDecode(b64url);
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1 || !parsed.fen) return null;
    const ts = Date.now();
    return {
      ...parsed,
      // Force the type-marker for shared cards so they're easy to
      // surface separately if the user wants to filter or remove
      // shared imports later.
      type: parsed.type || "shared",
      id: `shared-${ts}-${Math.random().toString(36).slice(2, 8)}`,
      ts,
    };
  } catch {
    return null;
  }
}

/** Build a full sharable URL given a card and the current origin. */
export function buildShareUrl(card, origin) {
  const payload = serializeCardForShare(card);
  if (!payload) return null;
  const base = origin || (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/review?import=${payload}`;
}

/** Add a card to the deck unless an identical (fen + type + answer)
 *  card already exists. Returns the merged deck. */
export function addCardIfNew(cards, newCard) {
  if (!newCard?.fen) return cards;
  const sigOf = (c) => `${c.type || ""}|${c.fen}|${c.played_san || ""}|${c.best_san || ""}`;
  const incoming = sigOf(newCard);
  if (cards.some((c) => sigOf(c) === incoming)) return cards;
  return [...cards, newCard];
}
