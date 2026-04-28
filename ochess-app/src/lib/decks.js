/**
 * Deck aggregation for the Anki Today tab.
 *
 * "Decks" in oChess are not separate piles - all cards live in one
 * `ochess_review_cards` array and share one SM-2 schedule (a card
 * has one state, no matter how you found it). What `decks` does is
 * give the UI a list of FILTERED VIEWS into that flat collection,
 * each labelled with a name + counts so the Today tab can render
 * a real deck browser instead of a 2,700-card firehose.
 *
 * Two kinds:
 *
 *   1. Built-ins: type-based slices that always exist when the
 *      collection has at least one card of that type
 *      (Puzzles / Game mistakes / Analysis / Shared / All).
 *
 *   2. User decks: persistent drill sets from `lib/drill-sets.js`.
 *      Each saved drill set surfaces as a deck. Drill sets created
 *      from the AI coach plan get an `aiCoach: true` badge.
 *
 * `listDecks(cards, drillSets, schedules)` returns the merged
 * collection with per-deck queue counts so the browser can render
 * "Hanging queens - 12 cards / 4 due" without each card calling
 * back into the full SM-2 module.
 */

import { COMMON_WEAKNESS_CHIPS, filterCardsByQuery } from "./study-plan";
import { summarizeSchedule } from "./review-engine";
import { getCardType } from "./card-types";

/**
 * Built-in deck definitions. Order matters for the UI - we render
 * decks in this order. Each entry has:
 *   id:       unique deck id (matches the `kind` for routing)
 *   name:     visible label
 *   kind:     "builtin" - distinguishes from user drill sets
 *   match:    predicate against a card; returns true if the card
 *             belongs in this deck
 *   short:    short description for the deck card subtitle
 */
const BUILTIN_DECKS = [
  {
    id: "puzzles",
    name: "Puzzles",
    kind: "builtin",
    match: (c) => c.type === "puzzle" || c.type === "tactic",
    short: "Saved positions from /puzzles",
    color: "blue",
  },
  {
    id: "mistakes",
    name: "Game mistakes",
    kind: "builtin",
    match: (c) => c.type === "mistake" || c.type === "game",
    short: "Stockfish-detected from your imported games",
    color: "amber",
  },
  {
    id: "analysis",
    name: "Analysis positions",
    kind: "builtin",
    match: (c) => c.type === "analysis",
    short: "Hand-saved positions from the analysis board",
    color: "purple",
  },
  {
    id: "shared",
    name: "Shared with you",
    kind: "builtin",
    match: (c) => c.type === "shared",
    short: "Imported from share links",
    color: "green",
  },
  {
    id: "openings",
    name: "Openings",
    kind: "builtin",
    match: (c) => c.type === "opening",
    short: "Repertoire flashcards",
    color: "teal",
  },
  {
    id: "endgames",
    name: "Endgames",
    kind: "builtin",
    match: (c) => c.type === "endgame",
    short: "Theoretical endings",
    color: "teal",
  },
];

/** Apply a drill-set filter to a card. Mirrors the same predicates
 *  as the StudyPlanPanel "Today's plan" picker so deck counts and
 *  the actual session always agree. */
function matchDrillSet(set, card) {
  if (card.type !== "mistake" && card.type !== "puzzle") return false;
  if (set.chipId) {
    const chip = COMMON_WEAKNESS_CHIPS.find((c) => c.id === set.chipId);
    if (chip && !chip.match(card)) return false;
  }
  if (set.query) {
    const matched = filterCardsByQuery([card], set.query);
    if (matched.length === 0) return false;
  }
  return true;
}

/** Compute card-level counts (total + due) for an arbitrary
 *  predicate against the deck. Schedules drive due-ness. */
function deckCounts(cards, predicate, schedules) {
  const matching = cards.filter((c) => c && predicate(c));
  const summary = summarizeSchedule(matching, schedules);
  return {
    total: matching.length,
    due: summary.dueNow,
    new: summary.new,
    learning: summary.learning,
    review: summary.review,
    relearning: summary.relearning,
    mature: summary.mature,
  };
}

/**
 * Build the full deck list for the Today browser.
 *
 * @param {Array}   cards       Full card collection from loadCards()
 * @param {Array}   drillSets   From loadDrillSets()
 * @param {object}  schedules   From loadSchedules()
 * @returns Deck[]
 *
 * Each deck:
 *   {
 *     id, name, kind, color, short, isAICoach,
 *     match: (card) => boolean,
 *     filter: { query, chipId, typeFilter } | null,
 *     counts: { total, due, new, learning, review, relearning, mature }
 *   }
 *
 * Empty built-in decks (zero cards of that type) are dropped to
 * keep the browser focused on actual content. The "All cards"
 * pseudo-deck is always returned LAST so users can fall back to
 * the legacy flat queue if they want.
 */
export function listDecks(cards, drillSets, schedules) {
  const safeCards = Array.isArray(cards) ? cards : [];
  const safeDrills = Array.isArray(drillSets) ? drillSets : [];
  const decks = [];

  for (const def of BUILTIN_DECKS) {
    const counts = deckCounts(safeCards, def.match, schedules);
    if (counts.total === 0) continue;
    decks.push({
      id: `builtin:${def.id}`,
      name: def.name,
      kind: "builtin",
      color: def.color,
      short: def.short,
      isAICoach: false,
      match: def.match,
      filter: { query: "", chipId: null, typeFilter: def.id },
      counts,
    });
  }

  for (const set of safeDrills) {
    const predicate = (card) => matchDrillSet(set, card);
    const counts = deckCounts(safeCards, predicate, schedules);
    decks.push({
      id: `drill:${set.id}`,
      name: set.name,
      kind: "drill",
      color: "primary",
      short: drillSubtitle(set),
      isAICoach: !!set.source && set.source === "coach",
      match: predicate,
      filter: { query: set.query || "", chipId: set.chipId || null, typeFilter: null },
      drillSetId: set.id,
      counts,
    });
  }

  // Always-on "All cards" pseudo-deck. Goes last so the focused
  // decks above grab the user's attention first.
  if (safeCards.length > 0) {
    const allMatch = (c) => c.type === "puzzle" || c.type === "mistake"
      || c.type === "analysis" || c.type === "game" || c.type === "shared"
      || c.type === "tactic" || c.type === "opening" || c.type === "endgame";
    const counts = deckCounts(safeCards, allMatch, schedules);
    decks.push({
      id: "builtin:all",
      name: "All cards",
      kind: "builtin",
      color: "neutral",
      short: "Every card across the deck",
      isAICoach: false,
      match: allMatch,
      filter: { query: "", chipId: null, typeFilter: null },
      counts,
    });
  }

  return decks;
}

function drillSubtitle(set) {
  const bits = [];
  if (set.chipId) {
    const chip = COMMON_WEAKNESS_CHIPS.find((c) => c.id === set.chipId);
    if (chip) bits.push(chip.label);
  }
  if (set.query) bits.push(`"${set.query}"`);
  return bits.length > 0 ? bits.join(" \u00b7 ") : "Custom drill";
}

/**
 * Helper for the AI coach insights surface: turn a single-mistake
 * insight into a focused drill query. The `played_san` + `phase`
 * combination is usually enough to nail the same kind of mistake
 * (e.g. "Bxh7" + "middlegame" matches all bishop blunders that
 * pin point to the same theme as the one the AI flagged).
 */
export function deckQueryForInsight(card) {
  if (!card) return "";
  const tokens = [];
  if (card.phase) tokens.push(card.phase);
  if (Array.isArray(card.themes) && card.themes[0]) tokens.push(card.themes[0]);
  if (card.played_san) tokens.push(card.played_san);
  return tokens.join(" ");
}

/**
 * Look up a deck by its synthetic id (returned by listDecks).
 * The session view re-resolves the deck on every render so a card
 * that just got rated re-counts correctly.
 */
export function getDeckById(decks, id) {
  if (!decks || !id) return null;
  return decks.find((d) => d.id === id) || null;
}

export { BUILTIN_DECKS };
