import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Chess } from "chess.js";
import InteractiveBoard from "./InteractiveBoard";
import SocialPanel from "./SocialPanel";
import ImportGamesPanel from "./ImportGamesPanel";
import AIDeckSheet from "./AIDeckSheet";
import { playMoveSound, playVictory, playError } from "../lib/sounds";
import { filterCardsByQuery, COMMON_WEAKNESS_CHIPS } from "../lib/study-plan";
import {
  cardId,
  loadCards,
  saveCards,
  removeCard,
  loadSchedules,
  saveSchedules,
  rateCard,
  bumpCardDue,
  isCardDue,
  RATING,
  deserializeSharedCard,
  addCardIfNew,
  predictIntervalsFor,
  summarizeDeck,
  forecastDeckNextDays,
  loadAIExplanations,
  saveAIExplanations,
  getAIExplanation,
  setAIExplanation,
  buildShareUrl,
  setSchedule,
  createScheduleState,
} from "../lib/review-cards";
import { explainCardWithAI, isAIAvailable } from "../lib/coach-llm";
import { loadDrillSets, removeDrillSet, saveDrillSets } from "../lib/drill-sets";
import { listDecks, getDeckById } from "../lib/decks";
import { getCardType, TONE_CLASSES } from "../lib/card-types";
import { explainCard } from "../lib/card-explain";

// Convert a 4/5-character UCI string ("e2e4" / "e7e8q") to a chess.js
// move object. Centralized here so review and the puzzle replay
// share the same parser.
function uciToMove(uci) {
  if (!uci || typeof uci !== "string" || uci.length < 4) return null;
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  };
}

// Anki-style rating buttons. The `desc` is a one-word recall
// label that explains *when* to pick this rating - the previous
// version showed only "Again / Hard / Good / Easy" and an
// interval ("1m / 10m / 1d / 4d"), which was opaque to anyone
// who hadn't already used Anki.
//
// Memorization-vs-understanding maps onto these the same way
// Anki advises for any rote material: if you got the move right
// but didn't actually see why, that's "Hard" (or even "Again"
// if you can't reconstruct the idea). "Easy" is reserved for
// "I'd see this instantly forever" - over-using it stretches
// the interval too far and the card stops teaching you.
//
// Visual: tone-only borders on a neutral surface fill, matching
// the rest of the app's quieter button palette. The `tone` value
// is also used to tint the predicted-interval line so the
// per-rating signal stays legible without the loud bg fills the
// previous design used.
const RATING_BUTTONS = [
  { label: "Again", desc: "Forgot / got it wrong",   value: RATING.AGAIN, key: "AGAIN",
    classes: "bg-surface-low border border-error/30 text-on-surface-variant/70 hover:border-error/50 hover:text-error",
    intervalText: "text-error/70" },
  { label: "Hard",  desc: "Right but unsure / slow", value: RATING.HARD,  key: "HARD",
    classes: "bg-surface-low border border-amber-500/30 text-on-surface-variant/70 hover:border-amber-500/50 hover:text-amber-300",
    intervalText: "text-amber-300/70" },
  { label: "Good",  desc: "Knew it without effort",  value: RATING.GOOD,  key: "GOOD",
    classes: "bg-surface-low border border-primary/30 text-on-surface-variant/70 hover:border-primary/50 hover:text-primary",
    intervalText: "text-primary/70" },
  { label: "Easy",  desc: "Spotted it instantly",    value: RATING.EASY,  key: "EASY",
    classes: "bg-surface-low border border-emerald-500/30 text-on-surface-variant/70 hover:border-emerald-500/50 hover:text-emerald-300",
    intervalText: "text-emerald-300/70" },
];

function orientationFor(card) {
  return (card?.fen || "").includes(" b ") ? "black" : "white";
}

/**
 * The user's color in a review card. Determined by who's to move
 * at the saved FEN: if the card is "Black to move - find the
 * best move", the user IS Black for the duration of this card.
 * Multi-move puzzle lines preserve the user's color across the
 * opponent reply (the user always replies after the auto-played
 * opponent move).
 *
 * Without this, InteractiveBoard's default playerColor="w"
 * silently blocks drag attempts on black pieces - which made
 * black-to-move cards literally unplayable.
 */
function playerColorFor(card) {
  return (card?.fen || "").includes(" b ") ? "b" : "w";
}

/**
 * Resolve a "View source" URL for a card, or null if there isn't
 * one. Mistake / shared cards carry an explicit `source_url`; for
 * puzzle cards we fall back to a Lichess training URL synthesized
 * from `puzzleId` (puzzles default to lichess unless explicitly
 * tagged otherwise). Returns null when no useful URL exists,
 * which the overflow-menu uses to hide the row entirely.
 */
function cardSourceUrl(card) {
  if (!card) return null;
  if (typeof card.source_url === "string" && card.source_url) return card.source_url;
  if (card.type === "puzzle" && card.puzzleId) {
    return `https://lichess.org/training/${card.puzzleId}`;
  }
  return null;
}

/** Card-type chip rendered above the prompt - icon + label in
 *  the type's tone color. The icon comes straight from the registry
 *  (a single SVG path string for a 24x24 outlined glyph). */
function CardTypeChip({ card }) {
  const type = getCardType(card);
  const tone = TONE_CLASSES[type.color] || TONE_CLASSES.blue;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 ${tone.bg} ${tone.border} border`}>
      <svg className={`w-3 h-3 ${tone.text}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d={type.iconPath} />
      </svg>
      <span className={`font-headline text-[10px] font-bold uppercase tracking-widest ${tone.text}`}>
        {type.label}
      </span>
    </span>
  );
}

/** Tone-color SM-2 state pill. Mirrors what real Anki shows next
 *  to a card in study mode: NEW (blue) / LEARNING (orange) /
 *  REVIEW (green) / RELEARNING (red). */
function StatePill({ state, intervalDays }) {
  const tone = (() => {
    switch (state) {
      case "new":         return { bg: "bg-blue-500/15",    text: "text-blue-300",    label: "New" };
      case "learning":    return { bg: "bg-amber-500/15",   text: "text-amber-300",   label: "Learning" };
      case "review":      return { bg: "bg-emerald-500/15", text: "text-emerald-300", label: intervalDays >= 21 ? "Mature" : "Young" };
      case "relearning":  return { bg: "bg-error/15",       text: "text-error",       label: "Relearning" };
      default:            return { bg: "bg-surface-high",   text: "text-on-surface-variant/50", label: state || "" };
    }
  })();
  return (
    <span className={`inline-block px-2 py-0.5 ${tone.bg} font-headline text-[9px] font-bold uppercase tracking-widest ${tone.text}`}>
      {tone.label}
    </span>
  );
}

/**
 * Card-action overflow menu. Replaces the previous full-width
 * "Skip / Remove from deck" button row that lived under the
 * rating buttons - the rare destructive actions (Remove, Reset)
 * and one-off actions (Share, View source) don't deserve as much
 * visual weight as the rating row, so we tuck them behind a
 * single 3-dot button next to the type chip.
 *
 * Click-away closes the menu. Each action receives the closing
 * callback so a clicked item can drop the menu before its work
 * (e.g. removing the card from state would unmount the menu
 * anyway, but explicit close keeps the UX consistent).
 *
 * The "Remove" item retains the two-step confirm that the inline
 * button used to provide: first click flips its label to "Tap
 * again to remove", second click within ~4 s actually deletes.
 */
function CardOverflowMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const visibleItems = items.filter((it) => !it.hidden);
  if (visibleItems.length === 0) return null;
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)}
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-7 h-7 flex items-center justify-center bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.96]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {open && (
        <div role="menu"
          className="absolute right-0 top-9 z-20 min-w-[180px] bg-surface-container border border-white/[0.06] py-1 shadow-xl">
          {visibleItems.map((it) => (
            <button key={it.id}
              role="menuitem"
              disabled={it.disabled}
              onClick={() => { it.onClick?.(); if (!it.keepOpen) setOpen(false); }}
              className={`w-full text-left px-3 py-2 font-headline text-[11px] font-bold uppercase tracking-wide transition-colors disabled:opacity-30 disabled:pointer-events-none ${
                it.danger
                  ? it.armed
                    ? "bg-error/15 text-error animate-pulse"
                    : "text-on-surface-variant/60 hover:text-error hover:bg-surface-high"
                  : "text-on-surface-variant/65 hover:text-primary hover:bg-surface-high"
              }`}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Deck filters mirror the card `type` field that PuzzlesPage /
// AnalysisPage / GameScreen attach when saving. "all" is the default;
// the others narrow the queue so a user who's accumulated 200 cards
// can drill down to "just my failed puzzles" or "just analysis
// positions" without rating-resetting the rest.
const DECK_FILTERS = [
  { id: "all",      label: "All",       match: () => true },
  { id: "puzzle",   label: "Puzzles",   match: (c) => c.type === "puzzle" },
  { id: "game",     label: "Games",     match: (c) => c.type === "game" || c.type === "mistake" },
  { id: "analysis", label: "Analysis",  match: (c) => c.type === "analysis" },
];

export default function ReviewPage() {
  const [cards, setCards] = useState(() => loadCards());
  const [schedules, setSchedules] = useState(() => loadSchedules());
  // Drill sets feed the deck browser. Stored separately from cards
  // - they're filter definitions, not new cards. The deck browser
  // listDecks() merges drill sets with type-based built-ins.
  const [drillSets, setDrillSets] = useState(() => loadDrillSets());
  // Per-card AI explanations cache - keyed by cardId, persisted to
  // localStorage. Hydrated once on mount so we don't refetch
  // explanations the user already paid the rate-limit cost for.
  const [aiExplanations, setAIExplanations] = useState(() => loadAIExplanations());
  const [phase, setPhase] = useState("prompt");
  const [highlight, setHighlight] = useState({});
  const [reviewed, setReviewed] = useState(0);
  // URL-driven navigation. Two query params:
  //   ?tab=today|import   - top-level mode (defaults to today)
  //   ?deck=<id>          - active deck for the session view
  // Sharing a deck-link to yourself / a friend now actually works,
  // and the browser back button takes you from session -> browser.
  // Local state is derived from searchParams so we never end up
  // with state and URL out of sync.
  const [searchParams, setSearchParams] = useSearchParams();
  const topTab = searchParams.get("tab") === "import" ? "import" : "today";
  const activeDeckId = searchParams.get("deck") || null;
  // Legacy chip filter, kept for the Import-tab "Practice now" path
  // and the in-session deck filters at the top of the board area.
  // It's redundant with the deck browser for normal navigation but
  // useful as a quick narrowing inside an active deck.
  const [deckFilter, setDeckFilter] = useState("all");
  // Optional plan-driven filter - set when the user clicks "Start
  // session" from the Import tab (either ad-hoc filter or a saved
  // drill set). We narrow the SM-2 queue to the same chip /
  // free-text filter so the session matches what they picked. The
  // optional setName is shown in the banner so the user knows
  // they're drilling "Hanging queens" instead of just `"hanging
  // queen"`. These stay as local state because they're ephemeral
  // session config the user shouldn't accidentally URL-share.
  const [planQuery, setPlanQuery] = useState("");
  const [planChipId, setPlanChipId] = useState(null);
  const [planSetName, setPlanSetName] = useState("");
  const gameRef = useRef(null);
  // Mutex flipped on while the opponent's auto-reply is queued
  // (the 450 ms gap after the user makes a correct move in a
  // multi-move puzzle). Without this, a user dragging another
  // piece during that window would have their move compared
  // against `lineMoves[lineIndex]` - which at that point is the
  // opponent's expected move, not theirs - and incorrectly trip
  // a wrong-attempt flash. Declared up here with the other refs
  // so every callback / effect that needs to clear it has access
  // without ref-ordering ambiguity.
  const awaitingOpponentRef = useRef(false);

  // AI deck-generator sheet. Opened from the deck browser via
  // "+ Generate AI decks". The sheet manages its own request /
  // result / cooldown state internally - we only pass it the
  // shared card collection + drill-set state so saves land in
  // the same store the deck browser reads.
  const [aiSheetOpen, setAiSheetOpen] = useState(false);

  // Card share import - if the URL has `?import=<base64>`, decode the
  // shared card, dedupe against the existing deck, and append. Then
  // strip the query param so a refresh doesn't re-import (which would
  // be benign thanks to addCardIfNew but would surface the toast
  // again). Lives at the top so it runs before the empty-state check
  // and the user immediately sees the imported card.
  const [shareToast, setShareToast] = useState(null);
  useEffect(() => {
    const payload = searchParams.get("import");
    if (!payload) return;
    const incoming = deserializeSharedCard(payload);
    if (!incoming) {
      setShareToast({ kind: "error", text: "Couldn't import that card - the link looks corrupted." });
    } else {
      setCards((prev) => {
        const merged = addCardIfNew(prev, incoming);
        const added = merged.length > prev.length;
        saveCards(merged);
        setShareToast({
          kind: added ? "ok" : "info",
          text: added
            ? "Shared card added to your deck. Switch to Today to drill it."
            : "You already have this card in your deck.",
        });
        return merged;
      });
    }
    // Drop the query param so a refresh / share-with-self doesn't
    // re-fire the import flow.
    const next = new URLSearchParams(searchParams);
    next.delete("import");
    setSearchParams(next, { replace: true });
    const t = setTimeout(() => setShareToast(null), 5000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-deck breakdown of the FULL collection (not just due cards) so
  // the filter chips can show "Puzzles 12 · Games 5 · Analysis 3"
  // and the user knows where their deck mass is concentrated.
  const deckCounts = useMemo(() => {
    const counts = { all: cards.length, puzzle: 0, game: 0, analysis: 0 };
    for (const c of cards) {
      if (c.type === "puzzle") counts.puzzle += 1;
      else if (c.type === "game" || c.type === "mistake") counts.game += 1;
      else if (c.type === "analysis") counts.analysis += 1;
    }
    return counts;
  }, [cards]);

  const activeFilter = DECK_FILTERS.find((f) => f.id === deckFilter) || DECK_FILTERS[0];

  // Deck list for the browser view. Always recomputed from the
  // current card collection + schedules + drill sets so counts stay
  // accurate after every rate / save / drill-set change. Cheap (<
  // few-thousand-card scale).
  const decks = useMemo(
    () => listDecks(cards, drillSets, schedules),
    [cards, drillSets, schedules]
  );
  const activeDeck = useMemo(
    () => getDeckById(decks, activeDeckId),
    [decks, activeDeckId]
  );

  // Recompute the due queue on every render - cheap, ~tens of cards.
  //
  // Filter precedence inside a session:
  //   1. The active deck's match predicate (browser navigation)
  //   2. The legacy deck-chip filter (in-session quick narrow)
  //   3. The plan-driven filter (Plan-tab "Practice now")
  //
  // For the Plan-tab path, activeDeckId is left null and we fall
  // straight through the chip + plan layers - so an unsaved
  // "Practice now" session still works without going through the
  // deck browser.
  const dueIds = useMemo(() => {
    let pool = cards.filter((c) => isCardDue(schedules, cardId(c)));
    if (activeDeck?.match) pool = pool.filter(activeDeck.match);
    else pool = pool.filter((c) => activeFilter.match(c));
    if (planChipId) {
      const chip = COMMON_WEAKNESS_CHIPS.find((c) => c.id === planChipId);
      if (chip) pool = pool.filter(chip.match);
    }
    if (planQuery) pool = filterCardsByQuery(pool, planQuery);
    return pool.map(cardId);
  }, [cards, schedules, activeDeck, activeFilter, planChipId, planQuery]);
  const card = useMemo(
    () => cards.find((c) => cardId(c) === dueIds[0]) || null,
    [cards, dueIds]
  );

  // Spin up a fresh live board whenever the active card changes so
  // multi-move play-out has somewhere to mutate. Each puzzle / line
  // gets a clean Chess instance from the saved FEN. We ALSO reset
  // the per-card transient state (lineIndex, played SAN, wrong-
  // attempt flash, interval hints) here so leftover state from the
  // previous card can't bleed into the next prompt.
  const cardKey = card ? cardId(card) : null;
  useEffect(() => {
    // Drain any opponent-reply / phase-handoff timeouts left over
    // from the previous card. Without this, switching deck (or
    // tabbing back so the focus listener pulls fresh state) mid-
    // line could fire the OLD card's setTimeout against the NEW
    // card's gameRef.
    const set = timeoutsRef.current;
    for (const id of set) clearTimeout(id);
    set.clear();
    if (!card) {
      gameRef.current = null;
      return;
    }
    try {
      gameRef.current = new Chess(card.fen);
    } catch {
      gameRef.current = null;
    }
    setPhase("prompt");
    setHighlight({});
    setLineIndex(0);
    setPlayedSan([]);
    setWrongAttempt(null);
    setIntervalHints(null);
    // The opponent-reply lock can survive card transitions (a
    // mid-line navigation away leaves it true) - reset it here
    // so the new card's first move isn't silently rejected.
    awaitingOpponentRef.current = false;
    // Drop any "tap again to remove" arming - moving to a new
    // card means the user implicitly cancelled.
    setConfirmRemove(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardKey]);

  // URL-bound navigation helpers. We do partial updates against the
  // existing searchParams so unrelated query params (notably
  // `?import=<base64>` while it's still in the URL) survive each
  // navigation. `replace: true` is used everywhere so users don't
  // accumulate dozens of history entries while flipping decks.
  const updateParams = useCallback((mutator) => {
    const next = new URLSearchParams(searchParams);
    mutator(next);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const setTopTab = useCallback((tab) => {
    updateParams((p) => {
      if (tab === "today") p.delete("tab");
      else p.set("tab", tab);
      // Switching top-level tab leaves any in-session deck behind.
      p.delete("deck");
    });
    setPhase("prompt");
    setHighlight({});
    setReviewed(0);
  }, [updateParams]);

  const startPlanSession = useCallback(({ query, chipId, setName } = {}) => {
    setPlanQuery(query || "");
    setPlanChipId(chipId || null);
    setPlanSetName(setName || "");
    setDeckFilter("all"); // Don't double-narrow; plan filter takes over.
    // Import-tab sessions are deliberately ephemeral - skip the deck
    // browser and drop straight into the focused queue. Land on
    // Today so the user sees the board, not the import panel.
    updateParams((p) => {
      p.delete("tab");
      p.delete("deck");
    });
    setPhase("prompt");
    setHighlight({});
    setReviewed(0);
  }, [updateParams]);

  const clearPlanSession = useCallback(() => {
    setPlanQuery("");
    setPlanChipId(null);
    setPlanSetName("");
  }, []);

  // Open a deck from the browser. Clears any plan-driven filter so
  // the deck's match predicate is the only thing narrowing the
  // queue. Sets ?deck=<id> in the URL.
  const openDeck = useCallback((deckId) => {
    setPlanQuery("");
    setPlanChipId(null);
    setPlanSetName("");
    setDeckFilter("all");
    updateParams((p) => {
      p.delete("tab");
      if (deckId) p.set("deck", deckId);
      else p.delete("deck");
    });
    setPhase("prompt");
    setHighlight({});
    setReviewed(0);
  }, [updateParams]);

  // Return to the deck browser without losing scheduling progress.
  const closeDeck = useCallback(() => {
    updateParams((p) => p.delete("deck"));
    setPhase("prompt");
    setHighlight({});
    setReviewed(0);
  }, [updateParams]);

  // Delete a user-created drill set deck. Built-in decks (puzzle /
  // mistake / etc.) can't be deleted - they auto-disappear when
  // the type has zero cards.
  const deleteDeck = useCallback((deck) => {
    if (!deck || deck.kind !== "drill" || !deck.drillSetId) return;
    const next = removeDrillSet(drillSets, deck.drillSetId);
    setDrillSets(next);
    saveDrillSets(next);
    if (activeDeckId === deck.id) {
      updateParams((p) => p.delete("deck"));
    }
  }, [drillSets, activeDeckId, updateParams]);

  // If localStorage is mutated by another page (e.g. user adds a card
  // from the analysis board in another tab), refresh on focus or
  // visibilitychange. Both listeners are removed on unmount.
  useEffect(() => {
    const refresh = () => {
      setCards(loadCards());
      setSchedules(loadSchedules());
      setDrillSets(loadDrillSets());
    };
    const onVis = () => { if (!document.hidden) refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Re-pull drill sets when the user toggles back to the Today tab.
  // The Import tab can save new drills (AI coach Save-as-drill /
  // Save-all-as-drills); without this they only show up after a
  // tab refocus.
  useEffect(() => {
    if (topTab === "today") setDrillSets(loadDrillSets());
  }, [topTab]);

  // Multi-move play-out state.
  //
  //   lineIndex: how many UCI moves from card.lineMoves we've
  //     already played (both player + opponent combined).
  //   playedSan: array of SAN tokens we've played, surfaced under
  //     the board so the user can scan their progress.
  //   wrongAttempt: when set, contains the {from,to} of the move
  //     the user just tried; used to flash a red square AND trigger
  //     the "Try again / See answer" affordance without locking
  //     them out the way the previous version did.
  const [lineIndex, setLineIndex] = useState(0);
  const [playedSan, setPlayedSan] = useState([]);
  const [wrongAttempt, setWrongAttempt] = useState(null);
  // Predicted intervals per rating button - real-Anki UX hint
  // ("Again 1m / Hard 10m / Good 1d / Easy 4d"). Computed lazily
  // when the user reaches the rating phase.
  const [intervalHints, setIntervalHints] = useState(null);

  // Tracker for outstanding setTimeouts so the cleanup effect can
  // cancel them on unmount AND so we can flush them on every card
  // transition. Without this, a user who navigates away (or skips,
  // or rates) mid-line would still trigger an opponent move
  // animation 450 ms later - and in the rare case the same UCI
  // happens to be legal on the *next* card it would silently
  // corrupt state.
  const timeoutsRef = useRef(new Set());

  // Drains every pending timeout immediately. Safe to call as
  // many times as we like.
  const clearPendingTimeouts = useCallback(() => {
    const set = timeoutsRef.current;
    for (const id of set) clearTimeout(id);
    set.clear();
  }, []);

  useEffect(() => () => clearPendingTimeouts(), [clearPendingTimeouts]);

  const scheduleTimeout = useCallback((fn, delay) => {
    const id = setTimeout(() => {
      timeoutsRef.current.delete(id);
      fn();
    }, delay);
    timeoutsRef.current.add(id);
    return id;
  }, []);

  const resetCard = useCallback(() => {
    clearPendingTimeouts();
    setPhase("prompt");
    setHighlight({});
    setLineIndex(0);
    setPlayedSan([]);
    setWrongAttempt(null);
    setIntervalHints(null);
    awaitingOpponentRef.current = false;
    gameRef.current = null;
  }, [clearPendingTimeouts]);

  // Advance the displayed FEN to whatever's currently in gameRef
  // and surface the predicted intervals. Called after the line is
  // fully played out (or revealed), at the rating-prompt phase.
  // Clears any leftover wrong-attempt flash so the rate UI doesn't
  // render the red "Not quite" banner alongside the rating buttons
  // (the banner is supposed to be a transient prompt-phase
  // affordance only). Also flushes any queued opponent-reply
  // timeout - the user has either solved or revealed, so further
  // automated mutations of gameRef would just race the rate UI.
  const enterRatePhase = useCallback((nextPhase) => {
    clearPendingTimeouts();
    awaitingOpponentRef.current = false;
    setPhase(nextPhase);
    setWrongAttempt(null);
    if (card) {
      const id = cardId(card);
      setIntervalHints(predictIntervalsFor(schedules, id));
    }
  }, [card, schedules, clearPendingTimeouts]);

  // Auto-play the opponent's reply (the next entry in lineMoves
  // after a player move). Brief delay so the user sees the move
  // animate in instead of teleporting. Returns whether a reply was
  // actually queued so callers can decide what phase to enter when
  // there isn't one (= line is done).
  const playOpponentReply = useCallback((replyIdx) => {
    if (!card?.lineMoves) return false;
    const replyUci = card.lineMoves[replyIdx];
    if (!replyUci) return false;
    const reply = uciToMove(replyUci);
    if (!reply) return false;
    awaitingOpponentRef.current = true;
    scheduleTimeout(() => {
      awaitingOpponentRef.current = false;
      try {
        const g = gameRef.current;
        if (!g) return;
        const r = g.move(reply);
        if (!r) return;
        playMoveSound(r);
        setPlayedSan((prev) => [...prev, r.san]);
        setHighlight({
          [r.from]: { backgroundColor: "rgba(255,255,255,0.06)" },
          [r.to]:   { backgroundColor: "rgba(255,255,255,0.10)" },
        });
        setLineIndex(replyIdx + 1);
      } catch { /* ignore - line corrupted */ }
    }, 450);
    return true;
  }, [card, scheduleTimeout]);

  const handleMove = useCallback((move) => {
    // Only accept moves while we're showing the prompt and not
    // mid-opponent-reply. The line-complete handoff briefly stays
    // in "prompt" phase before flipping to "correct" via a 300 ms
    // setTimeout, but the board is already non-interactive in that
    // window because the expected-move resolver returns null when
    // the line is done.
    if (!card || phase !== "prompt") return false;
    if (awaitingOpponentRef.current) return false;

    // Resolve the expected next move. Prefer the multi-move line
    // (puzzles), fall back to the single answerMove (analysis cards).
    const lineUci = card.lineMoves?.[lineIndex];
    const lineExpected = lineUci ? uciToMove(lineUci) : null;
    const expected = lineExpected || card.answerMove;
    if (!expected) return false;

    const correct = move.from === expected.from
      && move.to === expected.to
      && (!expected.promotion || expected.promotion === move.promotion);

    if (!correct) {
      playError();
      setWrongAttempt({ from: move.from, to: move.to });
      setHighlight({
        [move.from]: { backgroundColor: "rgba(244,67,54,0.30)" },
        [move.to]:   { backgroundColor: "rgba(244,67,54,0.40)" },
      });
      // Don't lock the user out the way the previous version did.
      // They can dismiss the wrong-move flash and try another move,
      // or hit "Show solution" / rate Again.
      return false;
    }

    // Correct. Apply the move on the working board, surface SAN,
    // briefly green-highlight the played squares, and either play
    // the opponent's reply (multi-move) or enter the rate phase
    // (line done / single-move card).
    try {
      let g = gameRef.current;
      if (!g) {
        g = new Chess(card.fen);
        gameRef.current = g;
      }
      const result = g.move({ from: move.from, to: move.to, promotion: move.promotion });
      if (!result) return false;
      playMoveSound(result);
      setWrongAttempt(null);
      setPlayedSan((prev) => [...prev, result.san]);
      setHighlight({
        [move.from]: { backgroundColor: "rgba(76,175,80,0.25)" },
        [move.to]:   { backgroundColor: "rgba(76,175,80,0.35)" },
      });
      const nextIdx = lineIndex + 1;
      setLineIndex(nextIdx);

      // If there's a follow-up line move AND it's the opponent's
      // (i.e. exists at all - puzzle lines alternate sides), play
      // it. Otherwise the line is done.
      const hasReply = !!card.lineMoves?.[nextIdx];
      if (hasReply) {
        playOpponentReply(nextIdx);
        return true;
      }

      // Line complete. Brief flourish, then rating prompt.
      playVictory();
      scheduleTimeout(() => enterRatePhase("correct"), 300);
      return true;
    } catch { return false; }
  }, [card, phase, lineIndex, enterRatePhase, playOpponentReply, scheduleTimeout]);

  const dismissWrongAttempt = useCallback(() => {
    setWrongAttempt(null);
    setHighlight({});
  }, []);

  const showAnswer = useCallback(() => {
    if (!card) return;
    // If the user clicks Show Answer during the brief opponent-
    // reply window, lineIndex points at the opponent's move - not
    // theirs. Highlighting that would show the wrong square. Apply
    // the queued opp move synchronously first so the highlight
    // lands on the user's actual next expected move instead.
    let cursor = lineIndex;
    if (awaitingOpponentRef.current && card.lineMoves?.[cursor]) {
      try {
        const reply = uciToMove(card.lineMoves[cursor]);
        const g = gameRef.current;
        if (g && reply) {
          const r = g.move(reply);
          if (r) {
            setPlayedSan((prev) => [...prev, r.san]);
            cursor = cursor + 1;
            setLineIndex(cursor);
          }
        }
      } catch { /* ignore - line corrupted */ }
    }
    const lineUci = card.lineMoves?.[cursor];
    const expected = (lineUci ? uciToMove(lineUci) : null) || card.answerMove;
    if (expected) {
      setHighlight({
        [expected.from]: { backgroundColor: "rgba(76,175,80,0.3)" },
        [expected.to]:   { backgroundColor: "rgba(76,175,80,0.4)" },
      });
    }
    enterRatePhase("revealed");
  }, [card, lineIndex, enterRatePhase]);

  const rate = useCallback((rating) => {
    if (!card) return;
    const id = cardId(card);
    setSchedules((prev) => {
      const next = rateCard(prev, id, rating);
      saveSchedules(next);
      return next;
    });
    setReviewed((r) => r + 1);
    resetCard();
  }, [card, resetCard]);

  const skip = useCallback(() => {
    if (!card) return;
    // Skip is cost-free: defer the card by 5 minutes so it falls
    // out of the current queue but doesn't get penalised. The
    // user explicitly didn't want to rate this one - we honor
    // that, instead of rating it AGAIN (which would lapse a
    // review card to relearning and trash its schedule).
    resetCard();
    setSchedules((prev) => {
      const next = bumpCardDue(prev, cardId(card), 5);
      saveSchedules(next);
      return next;
    });
  }, [card, resetCard]);

  // Two-step destructive action. First click flips the button
  // copy to "Tap again to remove" + a 4 s timeout so the user
  // can't fire it by accident. Second click within the window
  // actually removes the card from cards + schedules + AI cache.
  const [confirmRemove, setConfirmRemove] = useState(false);
  const confirmRemoveTimerRef = useRef(null);

  useEffect(() => () => {
    if (confirmRemoveTimerRef.current) clearTimeout(confirmRemoveTimerRef.current);
  }, []);

  const removeCurrent = useCallback(() => {
    if (!card) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      if (confirmRemoveTimerRef.current) clearTimeout(confirmRemoveTimerRef.current);
      confirmRemoveTimerRef.current = setTimeout(() => setConfirmRemove(false), 4000);
      return;
    }
    if (confirmRemoveTimerRef.current) clearTimeout(confirmRemoveTimerRef.current);
    setConfirmRemove(false);
    const id = cardId(card);
    setCards((prev) => {
      const next = removeCard(prev, id);
      saveCards(next);
      return next;
    });
    setSchedules((prev) => {
      const { [id]: _omit, ...rest } = prev;
      saveSchedules(rest);
      return rest;
    });
    resetCard();
  }, [card, resetCard, confirmRemove]);

  // Reset-schedule action mirrors Remove's two-step confirm. The
  // user clicks once to arm; the menu item flips its label and
  // tone, and a second click within 4 s replaces the card's
  // schedule with a fresh STATE.NEW entry. Useful when a rating
  // landed wrong (mis-clicked Easy on a card you barely knew),
  // since neither rate nor skip can resurrect a card from the
  // far-future review interval an over-eager Easy creates.
  const [confirmReset, setConfirmReset] = useState(false);
  const confirmResetTimerRef = useRef(null);
  useEffect(() => () => {
    if (confirmResetTimerRef.current) clearTimeout(confirmResetTimerRef.current);
  }, []);
  const resetSchedule = useCallback(() => {
    if (!card) return;
    if (!confirmReset) {
      setConfirmReset(true);
      if (confirmResetTimerRef.current) clearTimeout(confirmResetTimerRef.current);
      confirmResetTimerRef.current = setTimeout(() => setConfirmReset(false), 4000);
      return;
    }
    if (confirmResetTimerRef.current) clearTimeout(confirmResetTimerRef.current);
    setConfirmReset(false);
    const id = cardId(card);
    setSchedules((prev) => {
      const next = setSchedule(prev, id, createScheduleState());
      saveSchedules(next);
      return next;
    });
    resetCard();
  }, [card, resetCard, confirmReset]);

  // Share + view-source one-shot actions. Share writes the
  // deserializable share URL to the clipboard and surfaces the
  // result through the same ShareToast used for `?import=`
  // imports, so users get one consistent toast for both flows.
  const shareCard = useCallback(async () => {
    if (!card) return;
    const url = buildShareUrl(card);
    if (!url) {
      setShareToast({ kind: "error", text: "Couldn't build a share link for this card." });
      return;
    }
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setShareToast({ kind: "ok", text: "Share link copied to clipboard." });
      } else {
        setShareToast({ kind: "info", text: url });
      }
    } catch {
      setShareToast({ kind: "error", text: "Couldn't copy to clipboard." });
    }
    setTimeout(() => setShareToast(null), 4000);
  }, [card]);

  const viewSource = useCallback(() => {
    if (!card) return;
    // Prefer an explicit source_url (set by mistake-card writers
    // and the share importer), otherwise synthesize a Lichess
    // training URL from the puzzleId for puzzle cards. Mistake
    // cards without a source_url and analysis / game / shared
    // cards have no useful source - the menu item is hidden in
    // those cases via `cardSourceUrl(card)`.
    const url = cardSourceUrl(card);
    if (!url) return;
    if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
  }, [card]);

  // ── AI explanation request state ──
  // The "Explain with AI" button below the answer panel kicks off a
  // request to the coach Edge Function in mode=explain. Result is
  // cached per-card in localStorage so repeated reviews of the
  // same card don't keep burning the rate limit. The cooldown
  // mirrors the deck-generator UX so the user gets a single
  // consistent feel for "how often can I push the AI button".
  const [aiExplainLoading, setAIExplainLoading] = useState(false);
  const [aiExplainError, setAIExplainError] = useState(null);
  const [aiCooldownSec, setAICooldownSec] = useState(0);

  useEffect(() => {
    if (aiCooldownSec <= 0) return undefined;
    const id = setTimeout(() => setAICooldownSec((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(id);
  }, [aiCooldownSec]);

  // Clear transient AI-call error when navigating between cards so
  // the previous card's failure message doesn't bleed into the
  // next one's panel.
  useEffect(() => {
    setAIExplainError(null);
  }, [cardKey]);

  const requestAIExplanation = useCallback(async () => {
    if (!card || aiExplainLoading) return;
    setAIExplainLoading(true);
    setAIExplainError(null);
    try {
      const result = await explainCardWithAI(card);
      if (result.ok && result.explanation) {
        const id = cardId(card);
        setAIExplanations((prev) => {
          const next = setAIExplanation(prev, id, result.explanation, result.model);
          saveAIExplanations(next);
          return next;
        });
      } else {
        setAIExplainError(result.error || "Couldn't generate an explanation.");
        if (result.rateLimited && result.retryAfterSeconds) {
          setAICooldownSec(Math.ceil(Number(result.retryAfterSeconds)) || 0);
        }
      }
    } catch (e) {
      setAIExplainError(e?.message || "AI request failed.");
    } finally {
      setAIExplainLoading(false);
    }
  }, [card, aiExplainLoading]);

  const totalCards = cards.length;
  const remaining = dueIds.length;
  // Anki-style deck summary - drives the queue-breakdown widget
  // and the still-due counter on the sidebar.
  // Stats are scoped to the active deck when one is open, so the
  // sidebar tells you about THIS pile of cards, not the global
  // collection. Falls back to the full deck for the legacy /
  // Plan-tab "Practice now" path where activeDeck is null.
  const scopedCards = useMemo(
    () => (activeDeck?.match ? cards.filter(activeDeck.match) : cards),
    [cards, activeDeck]
  );
  const deckSummary = useMemo(() => summarizeDeck(scopedCards, schedules), [scopedCards, schedules]);
  // 7-day forecast for the upcoming-reviews chart.
  const deckForecast = useMemo(() => forecastDeckNextDays(scopedCards, schedules, 7), [scopedCards, schedules]);

  // Top-level tab strip is shared across every state - the Import
  // tab is useful even before the user has any cards (so they can
  // build the initial deck), and useful after they've reviewed
  // everything (so they can pull more games). Pill style matches
  // the Play page's Humans/Bots tabs for cross-page consistency.
  const TopTabs = (
    <div className="anim-fade-up flex gap-1 mb-6" style={{ "--delay": "0.08s" }}>
      {[
        { id: "today",  label: "Today" },
        { id: "import", label: "Import games" },
      ].map((t) => (
        <button key={t.id} onClick={() => setTopTab(t.id)}
          className={`px-5 py-2.5 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${
            topTab === t.id
              ? "bg-primary text-on-primary"
              : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );

  // Inline banner shown after a `?import=<card>` URL adds a shared
  // card. Stays for 5 s then auto-dismisses. Restyled to match the
  // Play "Resume game" banner idiom (surface-container + accent
  // border) instead of a strong tonal fill.
  const ShareToast = shareToast ? (
    <div className={`anim-fade-up mb-4 px-4 py-3 border text-[12px] ${
      shareToast.kind === "error"
        ? "bg-surface-container border-error/20 text-error"
        : shareToast.kind === "info"
        ? "bg-surface-container border-white/[0.06] text-on-surface-variant/65"
        : "bg-surface-container border-primary/20 text-primary"
    }`}>
      {shareToast.text}
    </div>
  ) : null;

  if (topTab === "import") {
    return (
      <div className="flex">
        <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
          <h1 className="anim-fade-up font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-1" style={{ "--delay": "0.05s" }}>Review</h1>
          <p className="anim-fade-up text-sm text-on-surface-variant/40 mb-6" style={{ "--delay": "0.06s" }}>
            Pull your recent games and turn the mistakes into review cards.
          </p>
          {TopTabs}
          {ShareToast}
          <ImportGamesPanel
            cards={cards}
            onCardsChange={setCards}
            onDone={() => setTopTab("today")}
          />
        </div>
        <SocialPanel />
      </div>
    );
  }

  if (totalCards === 0) {
    return (
      <div className="flex">
        <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
          <h1 className="anim-fade-up font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-1" style={{ "--delay": "0.05s" }}>Review</h1>
          {TopTabs}
          {ShareToast}
          <div className="text-center py-10">
            <h2 className="font-headline text-2xl font-extrabold tracking-tighter text-primary mb-3">No cards yet</h2>
            <p className="text-sm text-on-surface-variant/40 max-w-md mx-auto leading-relaxed mb-5">
              Save positions from the Analysis board, your bot games, or failed puzzles - or open{" "}
              <button onClick={() => setTopTab("import")} className="text-primary hover:underline font-bold">Import games</button>{" "}
              to pull your chess.com / Lichess games and auto-extract mistake cards.
            </p>
          </div>
        </div>
        <SocialPanel />
      </div>
    );
  }

  // Deck browser - the default Today view. The user picks a deck
  // from the list, or jumps to Import games to add more cards, or
  // launches the AI deck generator sheet. Only shown when no deck
  // and no plan filter are active.
  const inPlanSession = !!(planChipId || planQuery);
  if (topTab === "today" && !activeDeck && !inPlanSession) {
    return (
      <div className="flex">
        <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
          <h1 className="anim-fade-up font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-1" style={{ "--delay": "0.05s" }}>Review</h1>
          <p className="anim-fade-up text-sm text-on-surface-variant/40 mb-6" style={{ "--delay": "0.06s" }}>
            Pick a focused deck. Each deck pulls from your real cards.
          </p>
          {TopTabs}
          {ShareToast}
          <DeckBrowser
            decks={decks}
            onOpen={openDeck}
            onDelete={deleteDeck}
            onOpenImport={() => setTopTab("import")}
            onOpenAI={() => setAiSheetOpen(true)}
          />
        </div>
        <SocialPanel />
        <AIDeckSheet
          open={aiSheetOpen}
          onClose={() => setAiSheetOpen(false)}
          cards={cards}
          drillSets={drillSets}
          onDrillSetsChange={setDrillSets}
          onPracticeDeck={startPlanSession}
        />
      </div>
    );
  }

  if (!card) {
    // We're inside a session (an open deck or an Import-tab
    // Practice session) and the queue is empty. Offer the right
    // escape - back to the deck browser, or back to import,
    // depending on how the session started.
    return (
      <div className="flex">
        <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
          <h1 className="anim-fade-up font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-1" style={{ "--delay": "0.05s" }}>Review</h1>
          {TopTabs}
          {ShareToast}
          <div className="text-center py-6">
            <h2 className="font-headline text-2xl font-extrabold tracking-tighter text-primary mb-3">
              {activeDeck ? `Done with ${activeDeck.name}` : "Done with this drill"}
            </h2>
            <p className="text-sm text-on-surface-variant/40 max-w-md mx-auto leading-relaxed mb-6">
              {activeDeck
                ? `Every card in ${activeDeck.name} is reviewed for now. Pick another deck or come back tomorrow.`
                : "Every card matching this filter is reviewed. Try another deck or come back tomorrow."}
            </p>
            <div className="flex flex-wrap gap-2 justify-center mb-6">
              {activeDeck && (
                <button onClick={closeDeck}
                  className="btn btn-primary px-5 py-2 text-xs">
                  Pick another deck
                </button>
              )}
              {inPlanSession && (
                <button onClick={() => { clearPlanSession(); closeDeck(); }}
                  className="btn btn-primary px-5 py-2 text-xs">
                  Pick another deck
                </button>
              )}
              <button onClick={() => setTopTab("import")}
                className="btn btn-secondary px-5 py-2 text-xs">
                Import games
              </button>
            </div>
            <p className="text-[11px] uppercase tracking-widest text-on-surface-variant/25">
              {totalCards} card{totalCards === 1 ? "" : "s"} in your collection
            </p>
          </div>
        </div>
        <SocialPanel />
      </div>
    );
  }

  // The displayed position follows the live board through every
  // played move (player + opponent). When the user enters the rate
  // phase the live board is at the post-line state; for prompt /
  // unmoved cards we render the saved start FEN. The start FEN
  // itself drives orientation so the user is always playing from
  // the correct side.
  const fen = gameRef.current ? gameRef.current.fen() : card.fen;
  const orientation = orientationFor(card);

  // Session-header label. Resolves the active deck name, the named
  // drill set if the user came from Import, the chip label, or the
  // raw query - in that order. Falls back to "Review" so the h1
  // never reads as empty.
  const sessionLabel = activeDeck
    ? activeDeck.name
    : planSetName
      ? planSetName
      : planChipId
        ? COMMON_WEAKNESS_CHIPS.find((c) => c.id === planChipId)?.label || planChipId
        : planQuery
          ? `"${planQuery}"`
          : "Review";

  return (
    <div className="flex">
      <div className="flex-1 min-w-0 max-w-[1400px] xl:max-w-[1500px] 2xl:max-w-[1600px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10 min-h-[calc(100dvh-4rem)]">
        {TopTabs}
        {ShareToast}

        {/* Compact session header. Replaces the old "Studying X"
            banner with an Analysis/Puzzles-style header: small
            breadcrumb above, deck name as h1, inline reviewed/left
            counter on the right. Keeps the page identifiable
            without dominating the screen the way the big "Review"
            hero would. */}
        {(activeDeck || inPlanSession) && (
          <div className="anim-fade-up mb-5" style={{ "--delay": "0.05s" }}>
            <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
              <button onClick={() => activeDeck ? closeDeck() : clearPlanSession()}
                className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40 hover:text-primary transition-colors flex items-center gap-1">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                {activeDeck ? "All decks" : "Clear filter"}
              </button>
              <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/30">
                {reviewed} reviewed &middot; {remaining} left
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-headline text-xl sm:text-2xl font-extrabold tracking-tighter text-primary leading-tight">
                {sessionLabel}
              </h1>
              {activeDeck?.isAICoach && (
                <span className="px-1.5 py-0.5 bg-primary/15 text-primary font-headline text-[9px] font-bold uppercase tracking-widest">
                  AI
                </span>
              )}
            </div>
            {/* Deck-level summary for AI-generated decks. The AI
                writes a 1-2 sentence "what this deck is" line when
                generating; surfacing it here gives the user that
                context every time they study the deck. Hand-saved
                decks (no summary) skip this. */}
            {activeDeck?.summary && (
              <p className="mt-3 px-4 py-3 text-[12px] text-on-surface-variant/65 bg-surface-low border border-white/[0.04] leading-relaxed">
                {activeDeck.summary}
              </p>
            )}
          </div>
        )}

        {/* Legacy deck-filter chips - only shown when there's NO
            active deck (i.e. the user came in through the
            Import-tab Practice-now path and never picked a deck).
            Restyled to match Play's Humans/Bots tab pattern for
            cross-page consistency. */}
        {!activeDeck && (
        <div className="anim-fade-up flex flex-wrap gap-1.5 mb-5" style={{ "--delay": "0.04s" }}>
          {DECK_FILTERS.map((f) => {
            const count = deckCounts[f.id] ?? 0;
            const active = deckFilter === f.id;
            const empty = count === 0 && f.id !== "all";
            return (
              <button
                key={f.id}
                disabled={empty}
                onClick={() => setDeckFilter(f.id)}
                className={`px-4 py-2 font-headline text-[11px] font-bold uppercase tracking-wide transition-colors active:scale-[0.96] disabled:opacity-30 disabled:pointer-events-none ${
                  active
                    ? "bg-primary text-on-primary"
                    : "bg-surface-container border border-white/[0.04] text-on-surface-variant/55 hover:text-primary hover:bg-surface-high"
                }`}
              >
                {f.label}
                <span className={`ml-1.5 ${active ? "text-on-primary/55" : "text-on-surface-variant/30"}`}>{count}</span>
              </button>
            );
          })}
        </div>
        )}

        <div className="flex flex-col xl:flex-row gap-6 xl:gap-8">
          {/* Board column */}
          <div className="flex-1 flex flex-col items-center xl:items-start max-w-[700px]">
            <div className="w-full mb-4">
              {/* Type chip + SM-2 state pill + 3-dot overflow.
                  The session header already carries the deck name
                  + reviewed/left counter, so this row stays
                  compact and only describes the current CARD (not
                  the whole session). The overflow menu replaces
                  the previous "Skip / Remove" button row that
                  lived under the rating buttons - rare destructive
                  actions don't deserve as much weight as ratings,
                  so they're tucked behind a single button here. */}
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <CardTypeChip card={card} />
                <StatePill
                  state={schedules[cardId(card)]?.state || "new"}
                  intervalDays={schedules[cardId(card)]?.intervalDays || 0}
                />
                <div className="ml-auto">
                  <CardOverflowMenu items={[
                    { id: "share", label: "Share card", onClick: shareCard },
                    {
                      id: "view-source",
                      label: "View source",
                      onClick: viewSource,
                      hidden: !cardSourceUrl(card),
                    },
                    {
                      id: "reset",
                      label: confirmReset ? "Tap again to reset" : "Reset schedule",
                      onClick: resetSchedule,
                      danger: true,
                      armed: confirmReset,
                      keepOpen: !confirmReset,
                    },
                    {
                      id: "remove",
                      label: confirmRemove ? "Tap again to remove" : "Remove from deck",
                      onClick: removeCurrent,
                      danger: true,
                      armed: confirmRemove,
                      keepOpen: !confirmRemove,
                    },
                  ]} />
                </div>
              </div>
              {/* Card prompt drops to h2-equivalent sizing because
                  the session h1 already owns the page title. */}
              <h2 className="font-headline text-lg sm:text-xl font-extrabold tracking-tighter text-on-surface leading-tight">
                {getCardType(card).prompt(card)}
              </h2>
              <p className="text-[12px] text-on-surface-variant/55 mt-1 leading-snug">
                {getCardType(card).instruction(card)}
              </p>
            </div>

            <InteractiveBoard
              fen={fen}
              onMove={handleMove}
              orientation={orientation}
              playerColor={playerColorFor(card)}
              interactive={phase === "prompt" && !!(card.answerMove || card.lineMoves?.[lineIndex])}
              highlightSquares={highlight}
            />

            {/* Played-line ledger surfaces the moves both sides have
                actually played in this session below the board. Same
                vibe as a normal game's move list, distinct from the
                puzzle's saved SAN metadata. Stays present from prompt
                through rate so the user can see the full sequence
                they walked through before clicking a rating. */}
            {playedSan.length > 0 && (
              <div className="w-full mt-3 px-3 py-2 bg-surface-low border border-white/[0.04] flex items-center gap-2">
                <span className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/30 shrink-0">
                  Line
                </span>
                <span className="font-mono text-[12px] text-on-surface-variant/70 truncate">
                  {playedSan.map((s, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${s}` : s)).join(" ")}
                </span>
              </div>
            )}

            <div className="w-full mt-4">
              {phase === "prompt" && (
                <>
                  {/* Inline retry affordance when the user just
                      played a wrong move. Lets them try again
                      without having to click "Show answer" - fixes
                      the previous behaviour where one wrong drag
                      locked them into rate-only mode. */}
                  {wrongAttempt && (
                    <div className="anim-fade-up mb-2 flex items-center gap-2 px-3 py-2 bg-error/10 border border-error/20">
                      <span className="font-headline text-[11px] font-bold uppercase tracking-wide text-error">
                        Not quite - try again
                      </span>
                      <button onClick={dismissWrongAttempt}
                        className="ml-auto text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40 hover:text-primary transition-colors">
                        Reset board
                      </button>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button onClick={showAnswer}
                      className="flex-1 py-3.5 bg-surface-low border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.96]">
                      {(card.answerMove || card.lineMoves) ? "Show Answer" : "Reveal & Rate"}
                    </button>
                    <span className="flex-[2] py-3.5 bg-primary/5 border border-primary/10 text-center font-headline text-xs font-bold uppercase tracking-wide text-primary/60">
                      {card.lineMoves
                        ? lineIndex === 0
                          ? "Play out the line on the board"
                          : "Keep going - find the next move"
                        : card.answerMove
                          ? "Make your move on the board"
                          : "Recall - then rate yourself"}
                    </span>
                  </div>
                </>
              )}

              {(phase === "correct" || phase === "revealed") && (
                <>
                  {/* Minimal "Solved" / "Revealed" banner. The
                      detailed templated explanation + AI coach
                      take now live in dedicated sidebar widgets so
                      the rating buttons sit immediately under the
                      board, where the user's eyes already are. */}
                  <div className="flex items-baseline justify-between gap-2 mb-3">
                    <span className={`font-headline text-[10px] font-bold uppercase tracking-widest ${
                      phase === "correct" ? "text-emerald-400" : "text-on-surface-variant/50"
                    }`}>
                      {phase === "correct" ? "Solved" : "Revealed"}
                    </span>
                    <span className="text-[10px] text-on-surface-variant/35 leading-snug text-right">
                      Rate your recall, not just the move. Memorized without
                      understanding = &quot;Hard&quot;.
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5 mb-2">
                    {RATING_BUTTONS.map((r) => (
                      <button key={r.value} onClick={() => rate(r.value)}
                        title={r.desc}
                        className={`py-3 px-2 flex flex-col items-center justify-center text-center font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${r.classes}`}>
                        <span className="leading-none">{r.label}</span>
                        {intervalHints && (
                          <span className={`font-mono text-[9px] mt-1 normal-case tracking-normal leading-none ${r.intervalText}`}>
                            {intervalHints[r.key] || ""}
                          </span>
                        )}
                        <span className="mt-1.5 text-[9px] opacity-70 normal-case font-normal tracking-normal leading-tight">
                          {r.desc}
                        </span>
                      </button>
                    ))}
                  </div>
                  {/* Inline Skip text-link. Distinct from rating
                      Again - skip defers 5 minutes without
                      lapsing the card. Kept as a quiet text
                      action so it doesn't compete with the
                      rating row visually. */}
                  <div className="flex justify-end mt-2">
                    <button onClick={skip}
                      title="Defer this card 5 minutes - no penalty"
                      className="text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/35 hover:text-primary transition-colors">
                      Skip for now
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Sidebar - card metadata + answer panel + AI coach
              widget + Anki queue breakdown + 7-day forecast. The
              session counter that used to live here is now in the
              compact session header above the board. */}
          <div className="w-full xl:w-[300px] shrink-0 space-y-4">
            {/* Card metadata - rating, themes, opening, source link.
                All optional. Skipped if the card carries none.
                `revealed` gates the spoiler-bearing fields (engine
                line, eval loss, themes) so the user can't read the
                answer off the sidebar before solving. */}
            <CardMetadata card={card} revealed={phase === "correct" || phase === "revealed"} />

            {/* Answer panel - templated explanation of why the
                engine line is preferred. Only renders after the
                user solves or reveals so it can't spoil the
                answer. Replaces the inline emerald box that used
                to sit above the rating row. */}
            {(phase === "correct" || phase === "revealed") && (
              <AnswerPanel card={card} phase={phase} />
            )}

            {/* AI Coach widget - cached / on-demand AI explanation.
                Gated by reveal so it can't spoil the answer; only
                shown for cards that carry the played_san +
                best_san pair the coach needs. Loading state spells
                "Asking coach\u2026" out instead of leaving a bare
                spinner. */}
            {(phase === "correct" || phase === "revealed") && (
              <CoachTake
                card={card}
                aiExplanations={aiExplanations}
                loading={aiExplainLoading}
                error={aiExplainError}
                cooldownSec={aiCooldownSec}
                onRequest={requestAIExplanation}
              />
            )}

            {/* Anki queue breakdown - Today's queue grouped by state
                so the user knows whether they're seeing new cards
                vs. learning steps vs. reviews. */}
            <QueueBreakdown summary={deckSummary} />

            {/* 7-day forecast bars. Same data Anki shows on its
                deck page. Lets the user see the upcoming load
                before they get there. */}
            <Forecast forecast={deckForecast} />
          </div>
        </div>
      </div>
      <SocialPanel />
    </div>
  );
}

// ── Sidebar widgets ───────────────────────────────────────────────

/**
 * Card metadata strip. Pulls together everything the writer side
 * may have attached: puzzle rating, theme tags, opening name, eval
 * loss, source link, played-vs-best SAN.
 *
 * `revealed` controls spoilers. Until the user solves or clicks
 * Show Answer, the engine line, eval loss, and theme tags are
 * hidden - reading them off the sidebar before playing would give
 * away the answer (e.g. "hanging bishop" tells you exactly what
 * to capture). Played SAN, rating, opening, and source link are
 * never spoilers (the user already saw their own move in the
 * prompt; rating / opening are framing) so they show through.
 */
function CardMetadata({ card, revealed = false }) {
  if (!card) return null;
  const themes = Array.isArray(card.themes) ? card.themes.slice(0, 5) : [];
  // Treat 0 (or negative) eval-loss as "no real loss to show" for
  // visibility purposes - rendering an empty bar is more confusing
  // than just hiding it.
  const evalLoss = Number.isFinite(card.eval_loss_cp) && card.eval_loss_cp > 0
    ? card.eval_loss_cp
    : null;

  // Spoiler-bearing fields are gated by `revealed`. The visible-now
  // set is what determines whether the panel renders at all.
  const showBest = revealed && !!card.best_san;
  const showEvalLoss = revealed && evalLoss != null;
  const showThemes = revealed && themes.length > 0;

  const hasAny = card.rating || card.opening || card.played_san
    || showBest || showEvalLoss || showThemes
    || card.source_url || card.source;
  if (!hasAny) return null;

  const lossPct = evalLoss != null ? Math.min(100, Math.round((evalLoss / 600) * 100)) : null;
  const lossTone = evalLoss == null ? "" : evalLoss >= 300 ? "bg-error" : evalLoss >= 100 ? "bg-amber-400" : "bg-on-surface-variant/40";

  return (
    <div className="p-4 bg-surface-low border border-white/[0.04] space-y-3">
      <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">
        Card details
      </h3>

      {(card.played_san || showBest) && (
        <div className={`grid gap-2 ${card.played_san && showBest ? "grid-cols-2" : "grid-cols-1"}`}>
          {card.played_san && (
            <div>
              <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/30 block mb-0.5">You played</span>
              <span className="font-mono text-sm text-error/80">{card.played_san}</span>
            </div>
          )}
          {showBest && (
            <div>
              <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/30 block mb-0.5">Engine line</span>
              <span className="font-mono text-sm text-emerald-400">{card.best_san}</span>
            </div>
          )}
        </div>
      )}

      {showEvalLoss && (
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/30">Eval loss</span>
            <span className="font-mono text-[11px] text-on-surface-variant/65">-{(evalLoss / 100).toFixed(1)} pawns</span>
          </div>
          <div className="h-1 bg-surface-high overflow-hidden">
            <div className={`h-full ${lossTone}`} style={{ width: `${lossPct}%` }} />
          </div>
        </div>
      )}

      {card.rating && (
        <div className="flex items-baseline justify-between">
          <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/30">Puzzle rating</span>
          <span className="font-mono text-[12px] text-on-surface-variant/70">{card.rating}</span>
        </div>
      )}

      {card.opening && (
        <div>
          <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/30 block mb-0.5">Opening</span>
          <span className="text-[12px] text-on-surface-variant/65">{card.opening}</span>
        </div>
      )}

      {showThemes && (
        <div>
          <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/30 block mb-1.5">Themes</span>
          <div className="flex flex-wrap gap-1.5">
            {themes.map((t) => (
              <span key={t} className="px-1.5 py-0.5 bg-surface-container border border-white/[0.04] text-[10px] text-on-surface-variant/60">
                {t.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Pre-reveal hint that there are spoiler-tagged details
          waiting. Tells the user the panel isn't broken or empty -
          they're just looking at it before they're meant to. */}
      {!revealed && (card.best_san || evalLoss != null || themes.length > 0) && (
        <p className="text-[10px] text-on-surface-variant/35 italic leading-snug">
          Engine line and themes appear after you solve or reveal.
        </p>
      )}

      {(card.source_url || card.source) && (
        <div className="pt-2 border-t border-white/[0.04]">
          {card.source_url ? (
            <a href={card.source_url} target="_blank" rel="noopener noreferrer"
              className="text-[10px] text-on-surface-variant/45 hover:text-primary transition-colors inline-flex items-center gap-1">
              View on {card.source || "source"}
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 3h7v7M10 14L21 3M19 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h6" />
              </svg>
            </a>
          ) : (
            <span className="text-[10px] text-on-surface-variant/30 uppercase tracking-widest">
              From {card.source}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Templated answer panel. Surfaces the writer-supplied
 * `answerText` / `notes` for cards that ship with hand-written
 * coaching, and falls back to a tone-template via `explainCard`
 * for everything else (so puzzle / mistake / game cards always
 * get feedback after solving, not just curated ones). Renders as
 * a sidebar widget so the rating buttons can sit immediately
 * under the board.
 */
function AnswerPanel({ card, phase }) {
  const explanation = explainCard(card);
  if (!explanation) return null;
  return (
    <div className="p-4 bg-surface-low border border-white/[0.04]">
      <h3 className={`font-headline text-[10px] font-bold uppercase tracking-widest mb-2 ${
        phase === "correct" ? "text-emerald-400" : "text-on-surface-variant/45"
      }`}>
        {phase === "correct" ? "Solved" : "Answer"}
      </h3>
      <p className="text-sm text-on-surface-variant/70 leading-relaxed">{explanation}</p>
    </div>
  );
}

/**
 * AI Coach widget. Three states by precedence:
 *
 *   1. Cached explanation already exists -> render it.
 *   2. Card carries the (played_san, best_san) pair the coach
 *      needs -> render the request button + a one-line
 *      "what this is" prompt. Loading state spells "Asking
 *      coach\u2026" so a user staring at a spinner knows what's
 *      blocking them. Cooldown countdown comes from the rate-
 *      limit response.
 *   3. Card lacks the pair (e.g. analysis-card stubs) or AI is
 *      unavailable -> widget hides itself entirely so the
 *      sidebar doesn't render an unactionable button.
 */
function CoachTake({ card, aiExplanations, loading, error, cooldownSec, onRequest }) {
  if (!card) return null;
  const id = cardId(card);
  const cached = getAIExplanation(aiExplanations, id);
  const canAskAI = isAIAvailable() && !!card.played_san && !!card.best_san;
  if (!cached && !canAskAI) return null;
  return (
    <div className="p-4 bg-surface-low border border-white/[0.04] space-y-3">
      <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-primary/60">
        Coach take
      </h3>
      {cached && (
        <p className="text-sm text-on-surface-variant/75 leading-relaxed">{cached}</p>
      )}
      {!cached && canAskAI && (
        <>
          <p className="text-[11px] text-on-surface-variant/40 leading-snug">
            Get a deeper, position-aware take from the coach.
          </p>
          <button
            onClick={onRequest}
            disabled={loading || cooldownSec > 0}
            className="w-full px-3 py-2 bg-surface-container border border-primary/20 font-headline text-[10px] font-bold uppercase tracking-widest text-primary/80 hover:bg-surface-high hover:text-primary transition-colors active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none">
            {loading
              ? "Loading\u2026 asking coach"
              : cooldownSec > 0
                ? `Try again in ${cooldownSec}s`
                : "Explain with AI"}
          </button>
          {error && (
            <p className="text-[11px] text-amber-300/80 leading-relaxed bg-amber-500/5 border border-amber-500/15 px-3 py-2">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Anki-style queue breakdown showing how many cards are in each
 * state today. Mirrors the New / Learning / Review counts you'd
 * see at the top of an Anki study session.
 */
function QueueBreakdown({ summary }) {
  if (!summary || summary.total === 0) return null;
  const rows = [
    { label: "New", count: summary.new, dot: "bg-blue-400" },
    { label: "Learning", count: summary.learning, dot: "bg-amber-400" },
    { label: "Review", count: summary.review, dot: "bg-emerald-400" },
    { label: "Relearning", count: summary.relearning, dot: "bg-error" },
  ];
  return (
    <div className="p-4 bg-surface-low border border-white/[0.04]">
      <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40 mb-3">
        Queue
      </h3>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 ${r.dot}`} />
            <span className="text-[12px] text-on-surface-variant/70 flex-1">{r.label}</span>
            <span className="font-mono text-[12px] text-on-surface-variant/50 tabular-nums">{r.count}</span>
          </div>
        ))}
      </div>
      {summary.mature > 0 && (
        <div className="mt-3 pt-3 border-t border-white/[0.04] flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/30">Mature</span>
          <span className="font-mono text-[11px] text-emerald-400/70">{summary.mature}/{summary.review}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Compact 7-day forecast bar chart - shows tomorrow + 6 more days
 * worth of upcoming reviews. The first bar (today) is highlighted
 * because that's what the user is working through right now.
 */
function Forecast({ forecast }) {
  if (!Array.isArray(forecast) || forecast.length === 0) return null;
  const max = Math.max(1, ...forecast.map((d) => d.count));
  const dayLabel = (d, i) => {
    if (i === 0) return "Today";
    return d.date.toLocaleDateString(undefined, { weekday: "short" });
  };
  return (
    <div className="p-4 bg-surface-low border border-white/[0.04]">
      <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40 mb-3">
        Next 7 days
      </h3>
      <div className="flex items-end gap-1 h-16">
        {forecast.map((d, i) => {
          const h = Math.max(2, Math.round((d.count / max) * 100));
          const tone = i === 0 ? "bg-primary" : "bg-on-surface-variant/25";
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <div className="w-full flex items-end justify-center" style={{ height: "44px" }}>
                <div className={`w-full ${tone} transition-all`} style={{ height: `${h}%` }} title={`${d.count} cards`} />
              </div>
              <span className="text-[8px] text-on-surface-variant/30 uppercase tracking-wide">
                {dayLabel(d, i)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Deck browser ─────────────────────────────────────────────────

/**
 * Today-tab deck list. Each row is a focused, clickable deck.
 *
 * Sectioned: built-in type-decks first (Puzzles, Game mistakes,
 * Analysis, ...), then "My decks" - user-created drill sets first,
 * AI-generated drills next, and the catch-all "All cards" pseudo-
 * deck as the last row. Collapsing "Everything" into the My decks
 * tail keeps the browser to two scannable groups instead of three
 * tiny ones; the user still has the escape hatch when they want a
 * single firehose queue.
 *
 * Drill sets show a delete button. Built-ins and "All cards" don't
 * - they're derived from the card collection and auto-disappear
 * when the underlying types are empty. Coach-tagged drill sets get
 * a subtle "AI" pill on the row.
 */
function DeckBrowser({ decks, onOpen, onDelete, onOpenImport, onOpenAI }) {
  const builtins = decks.filter((d) => d.kind === "builtin" && d.id !== "builtin:all");
  const drills = decks.filter((d) => d.kind === "drill");
  const allDeck = decks.find((d) => d.id === "builtin:all");

  if (decks.length === 0) {
    return (
      <div className="text-center py-10 anim-fade-up">
        <h2 className="font-headline text-2xl font-extrabold tracking-tighter text-primary mb-3">No decks yet</h2>
        <p className="text-sm text-on-surface-variant/40 max-w-md mx-auto leading-relaxed mb-5">
          Save positions from the analysis board, fail a puzzle, or pull your recent games from the Import tab to auto-extract mistakes.
        </p>
        <button onClick={onOpenImport} className="btn btn-primary px-5 py-2 text-xs">
          Import games
        </button>
      </div>
    );
  }

  // "My decks" trailing pseudo-row - the All-cards firehose. Only
  // surfaced when there's actual content, so the row doesn't appear
  // in the truly-empty case (which is already handled above by the
  // `decks.length === 0` branch).
  const myDecksHasRows = drills.length > 0 || !!allDeck;

  return (
    <div className="space-y-6 anim-fade-up">
      {builtins.length > 0 && (
        <DeckSection title="Built-in" subtitle="Type-based decks pulled from your card collection">
          {builtins.map((d) => (
            <DeckCard key={d.id} deck={d} onClick={() => onOpen(d.id)} />
          ))}
        </DeckSection>
      )}

      {myDecksHasRows && (
        <DeckSection
          title="My decks"
          subtitle={drills.length > 0
            ? "Your saved drills. Click to study, or generate new decks with AI."
            : "No saved drills yet. Generate decks from your weakness profile with AI, or open the Import tab to pull more games."}
          action={(
            <div className="flex items-center gap-3">
              {onOpenAI && (
                <button onClick={onOpenAI}
                  className="text-[10px] font-headline font-bold uppercase tracking-widest text-primary/70 hover:text-primary transition-colors">
                  + Generate AI decks
                </button>
              )}
              <button onClick={onOpenImport}
                className="text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40 hover:text-primary transition-colors">
                + Import games
              </button>
            </div>
          )}
        >
          {drills.map((d) => (
            <DeckCard key={d.id} deck={d} onClick={() => onOpen(d.id)} onDelete={() => onDelete(d)} />
          ))}
          {/* "All cards" tail - the catch-all firehose. Rendered
              muted so it visually subordinates to the focused
              decks above without being hidden in a separate
              section. */}
          {allDeck && (
            <DeckCard deck={allDeck} onClick={() => onOpen(allDeck.id)} muted />
          )}
        </DeckSection>
      )}
    </div>
  );
}

function DeckSection({ title, subtitle, action, children }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/40">{title}</h3>
        {action}
      </div>
      {subtitle && <p className="text-[11px] text-on-surface-variant/30 mb-3 leading-snug">{subtitle}</p>}
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function DeckCard({ deck, onClick, onDelete, muted }) {
  const counts = deck.counts || {};
  const dueCount = counts.due || 0;
  const totalCount = counts.total || 0;
  const isEmpty = totalCount === 0;
  const isDone = !isEmpty && dueCount === 0;

  const dotRows = [
    { label: "New", count: counts.new || 0, dot: "bg-blue-400" },
    { label: "Learning", count: counts.learning || 0, dot: "bg-amber-400" },
    { label: "Review", count: counts.review || 0, dot: "bg-emerald-400" },
    { label: "Relearning", count: counts.relearning || 0, dot: "bg-error" },
  ].filter((r) => r.count > 0);

  return (
    <div className={`group flex items-center gap-3 px-4 py-3 ${muted ? "bg-surface-lowest/50" : "bg-surface-low"} border border-white/[0.04] hover:border-primary/30 transition-colors`}>
      <button onClick={onClick}
        disabled={isEmpty}
        className="flex-1 min-w-0 text-left disabled:cursor-default disabled:opacity-50">
        <div className="flex items-baseline gap-2 flex-wrap mb-1">
          <span className="font-headline text-[14px] font-bold text-on-surface truncate">
            {deck.name}
          </span>
          {deck.isAICoach && (
            <span className="px-1.5 py-0.5 bg-primary/15 text-primary font-headline text-[9px] font-bold uppercase tracking-widest">
              AI
            </span>
          )}
          {deck.kind === "drill" && !deck.isAICoach && (
            <span className="px-1.5 py-0.5 bg-surface-container text-on-surface-variant/50 font-headline text-[9px] font-bold uppercase tracking-widest">
              Drill
            </span>
          )}
        </div>
        <span className="text-[11px] text-on-surface-variant/40 block truncate mb-1.5">
          {deck.short}
        </span>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/30">
            {totalCount} card{totalCount === 1 ? "" : "s"}
          </span>
          {dueCount > 0 && (
            <span className="text-[10px] uppercase tracking-widest text-primary font-bold">
              {dueCount} due
            </span>
          )}
          {dotRows.length > 0 && (
            <span className="flex items-center gap-2 text-[10px] text-on-surface-variant/45">
              {dotRows.map((r) => (
                <span key={r.label} className="flex items-center gap-1">
                  <span className={`w-1.5 h-1.5 ${r.dot}`} />
                  <span className="tabular-nums">{r.count}</span>
                </span>
              ))}
            </span>
          )}
          {isDone && (
            <span className="text-[10px] uppercase tracking-widest text-emerald-400/80">
              Caught up
            </span>
          )}
        </div>
      </button>
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete this deck"
          className="px-2 py-1 font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/30 hover:text-error transition-colors opacity-0 group-hover:opacity-100"
        >
          Delete
        </button>
      )}
      <button onClick={onClick} disabled={isEmpty}
        className="px-3 py-1.5 font-headline text-[11px] font-bold uppercase tracking-widest text-primary/80 hover:text-primary transition-colors disabled:opacity-30 disabled:cursor-default">
        {dueCount > 0 ? "Study" : "Open"}
      </button>
    </div>
  );
}
