import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Chess } from "chess.js";
import InteractiveBoard from "./InteractiveBoard";
import SocialPanel from "./SocialPanel";
import StudyPlanPanel from "./StudyPlanPanel";
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
} from "../lib/review-cards";
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

const RATING_BUTTONS = [
  { label: "Again", value: RATING.AGAIN, key: "AGAIN", color: "bg-error/20 text-error hover:bg-error/30 border border-error/10" },
  { label: "Hard",  value: RATING.HARD,  key: "HARD",  color: "bg-surface-low border border-white/[0.04] text-on-surface-variant/60 hover:text-primary hover:bg-surface-high" },
  { label: "Good",  value: RATING.GOOD,  key: "GOOD",  color: "bg-surface-low border border-white/[0.04] text-on-surface-variant/60 hover:text-primary hover:bg-surface-high" },
  { label: "Easy",  value: RATING.EASY,  key: "EASY",  color: "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/10" },
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
  const [phase, setPhase] = useState("prompt");
  const [highlight, setHighlight] = useState({});
  const [reviewed, setReviewed] = useState(0);
  // Deck browser: the deck the user is currently studying. null
  // means "show the deck list, not a single-card session". Today
  // tab opens with `activeDeckId === null` so the user lands on
  // the browser; clicking a deck flips this to its id.
  const [activeDeckId, setActiveDeckId] = useState(null);
  // Legacy chip filter, kept for the Plan-tab "Practice now" path
  // and the in-session deck filters at the top of the board area.
  // It's redundant with the deck browser for normal navigation but
  // useful as a quick narrowing inside an active deck.
  const [deckFilter, setDeckFilter] = useState("all");
  // Top-level tab: "today" runs the standard SM-2 flow you've always
  // had; "plan" surfaces the new pulled-from-your-games study plan
  // (StudyPlanPanel handles its own state + persistence).
  const [topTab, setTopTab] = useState("today");
  // Optional plan-driven filter - set when the user clicks "Start
  // session" from the Plan tab (either ad-hoc filter or a saved
  // drill set). We narrow the SM-2 queue to the same chip /
  // free-text filter so the session matches what they picked. The
  // optional setName is shown in the banner so the user knows
  // they're drilling "Hanging queens" instead of just `"hanging
  // queen"`.
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

  // Card share import - if the URL has `?import=<base64>`, decode the
  // shared card, dedupe against the existing deck, and append. Then
  // strip the query param so a refresh doesn't re-import (which would
  // be benign thanks to addCardIfNew but would surface the toast
  // again). Lives at the top so it runs before the empty-state check
  // and the user immediately sees the imported card.
  const [searchParams, setSearchParams] = useSearchParams();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardKey]);

  const startPlanSession = useCallback(({ query, chipId, setName } = {}) => {
    setPlanQuery(query || "");
    setPlanChipId(chipId || null);
    setPlanSetName(setName || "");
    setDeckFilter("all"); // Don't double-narrow; Plan filter takes over.
    // Plan-tab sessions are deliberately ephemeral - skip the deck
    // browser and drop straight into the focused queue.
    setActiveDeckId(null);
    setTopTab("today");
    setPhase("prompt");
    setHighlight({});
    setReviewed(0);
  }, []);

  const clearPlanSession = useCallback(() => {
    setPlanQuery("");
    setPlanChipId(null);
    setPlanSetName("");
  }, []);

  // Open a deck from the browser. Clears any plan-driven filter so
  // the deck's match predicate is the only thing narrowing the
  // queue.
  const openDeck = useCallback((deckId) => {
    setActiveDeckId(deckId);
    setPlanQuery("");
    setPlanChipId(null);
    setPlanSetName("");
    setDeckFilter("all");
    setPhase("prompt");
    setHighlight({});
    setReviewed(0);
  }, []);

  // Return to the deck browser without losing scheduling progress.
  const closeDeck = useCallback(() => {
    setActiveDeckId(null);
    setPhase("prompt");
    setHighlight({});
    setReviewed(0);
  }, []);

  // Delete a user-created drill set deck. Built-in decks (puzzle /
  // mistake / etc.) can't be deleted - they auto-disappear when
  // the type has zero cards.
  const deleteDeck = useCallback((deck) => {
    if (!deck || deck.kind !== "drill" || !deck.drillSetId) return;
    const next = removeDrillSet(drillSets, deck.drillSetId);
    setDrillSets(next);
    saveDrillSets(next);
    if (activeDeckId === deck.id) setActiveDeckId(null);
  }, [drillSets, activeDeckId]);

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
  // The Plan tab can save new drills (AI coach Save-as-drill /
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

  const removeCurrent = useCallback(() => {
    if (!card) return;
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
  }, [card, resetCard]);

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

  // Top-level tab strip is shared across every state - the Plan tab is
  // useful even before the user has any cards (so they can build the
  // initial deck), and useful after they've reviewed everything (so
  // they can pull more games).
  const TopTabs = (
    <div className="anim-fade-up flex gap-1 mb-5 border-b border-white/[0.04]" style={{ "--delay": "0.04s" }}>
      {[
        { id: "today", label: "Today" },
        { id: "plan",  label: "Plan"  },
      ].map((t) => (
        <button key={t.id} onClick={() => setTopTab(t.id)}
          className={`px-4 py-2 font-headline text-[12px] font-bold uppercase tracking-wide transition-colors ${
            topTab === t.id ? "text-primary border-b-2 border-primary -mb-px" : "text-on-surface-variant/40 hover:text-primary"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );

  // Inline banner shown after a `?import=<card>` URL adds a shared
  // card. Stays for 5 s then auto-dismisses.
  const ShareToast = shareToast ? (
    <div className={`anim-fade-up mb-4 px-4 py-3 border text-[12px] ${
      shareToast.kind === "error" ? "bg-error/10 border-error/20 text-error"
      : shareToast.kind === "info" ? "bg-surface-low border-white/[0.06] text-on-surface-variant/65"
      : "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
    }`}>
      {shareToast.text}
    </div>
  ) : null;

  if (topTab === "plan") {
    return (
      <div className="flex">
        <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
          <h1 className="anim-fade-up font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-1" style={{ "--delay": "0.05s" }}>Review</h1>
          <p className="anim-fade-up text-sm text-on-surface-variant/40 mb-6" style={{ "--delay": "0.06s" }}>
            Drill the positions where you keep slipping up.
          </p>
          {TopTabs}
          {ShareToast}
          <StudyPlanPanel onStartSession={startPlanSession} />
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
              Save positions from the Analysis board, your bot games, or failed puzzles - or open the{" "}
              <button onClick={() => setTopTab("plan")} className="text-primary hover:underline font-bold">Plan tab</button>{" "}
              to import your chess.com / Lichess games and auto-extract mistake cards.
            </p>
          </div>
        </div>
        <SocialPanel />
      </div>
    );
  }

  // Deck browser - the default Today view. The user picks a deck
  // from the list (or starts a Plan-tab "Practice now" session via
  // the StudyPlanPanel which routes through startPlanSession and
  // skips this branch). Only shown when no deck / plan filter is
  // active.
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
            onOpenPlan={() => setTopTab("plan")}
          />
        </div>
        <SocialPanel />
      </div>
    );
  }

  if (!card) {
    // We're inside a session (an open deck or a Plan-tab Practice
    // session) and the queue is empty. Offer the right escape -
    // back to the deck browser, or back to the plan, depending on
    // how the session started.
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
                <button onClick={() => { clearPlanSession(); setActiveDeckId(null); }}
                  className="btn btn-primary px-5 py-2 text-xs">
                  Pick another deck
                </button>
              )}
              <button onClick={() => setTopTab("plan")}
                className="btn btn-secondary px-5 py-2 text-xs">
                Open Plan
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

  return (
    <div className="flex">
      <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
        {TopTabs}
        {ShareToast}

        {/* Active-deck header. When the user is studying a deck
            from the browser, show its name + a "Switch deck"
            button so they can return to the browser without
            losing schedule progress. The Plan-tab "Practice now"
            path uses the same banner for visual consistency. */}
        {(activeDeck || inPlanSession) && (
          <div className="anim-fade-up mb-4">
            <div className="flex items-center justify-between gap-3 px-3 py-2 bg-primary/5 border border-primary/15">
              <span className="text-[12px] text-on-surface-variant/65">
                Studying{" "}
                <span className="font-bold text-primary">
                  {activeDeck
                    ? activeDeck.name
                    : planSetName
                      ? planSetName
                      : planChipId
                        ? COMMON_WEAKNESS_CHIPS.find((c) => c.id === planChipId)?.label || planChipId
                        : `"${planQuery}"`}
                </span>
                {activeDeck?.isAICoach && (
                  <span className="ml-2 px-1.5 py-0.5 bg-primary/15 text-primary font-headline text-[9px] font-bold uppercase tracking-widest">
                    AI
                  </span>
                )}
              </span>
              <button onClick={() => activeDeck ? closeDeck() : clearPlanSession()}
                className="text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40 hover:text-primary transition-colors">
                {activeDeck ? "Switch deck" : "Clear filter"}
              </button>
            </div>
            {/* Deck-level summary banner for AI-generated decks.
                The AI writes a 1-2 sentence "what this deck is and
                why it matters for you" line when generating;
                surfacing it here gives the user that context every
                time they study the deck without needing the Plan
                tab. Hand-saved decks (no summary) skip this. */}
            {activeDeck?.summary && (
              <p className="mt-2 px-3 py-2 text-[12px] text-on-surface-variant/65 bg-surface-low border border-white/[0.04] leading-relaxed">
                {activeDeck.summary}
              </p>
            )}
          </div>
        )}

        {/* Legacy deck-filter chips - only shown when there's NO
            active deck, since the deck browser is the primary
            navigation now. Kept for the Plan-tab "Practice now"
            path so users still have a quick narrow there. */}
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
                className={`px-3 py-1.5 font-headline text-[11px] font-bold uppercase tracking-wide transition-colors disabled:opacity-30 disabled:pointer-events-none ${
                  active
                    ? "bg-primary text-on-primary"
                    : "bg-surface-low border border-white/[0.04] text-on-surface-variant/55 hover:text-primary hover:bg-surface-high"
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
              {/* Type chip + SM-2 state pill side-by-side. Replaces the
                  old plain-text "Puzzle · Rating 1500 · fork" line with
                  a colour-coded affordance the user can scan in a
                  second. */}
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <CardTypeChip card={card} />
                <StatePill
                  state={schedules[cardId(card)]?.state || "new"}
                  intervalDays={schedules[cardId(card)]?.intervalDays || 0}
                />
                <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/30">
                  {reviewed + 1} of {reviewed + remaining}
                </span>
              </div>
              <h1 className="font-headline text-xl sm:text-2xl font-extrabold tracking-tighter text-primary leading-tight">
                {getCardType(card).prompt(card)}
              </h1>
              <p className="text-[12px] text-on-surface-variant/45 mt-0.5 leading-snug">
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
                  {/* Explanation panel. Prefers a writer-supplied
                      answerText / notes, falls back to a coach-tone
                      template using the card's metadata (themes,
                      eval loss, opening, phase, played-vs-best
                      SAN). Always shows for mistake / puzzle / game
                      cards so the user gets feedback every solve,
                      not only on cards that happened to ship with
                      hand-written notes. */}
                  {(() => {
                    const explanation = explainCard(card);
                    if (!explanation) return null;
                    return (
                      <div className={`p-4 mb-3 border ${
                        phase === "correct" ? "bg-emerald-500/5 border-emerald-500/10" : "bg-surface-container border-white/[0.04]"
                      }`}>
                        <span className={`text-xs font-headline font-bold uppercase tracking-wide block mb-2 ${
                          phase === "correct" ? "text-emerald-400" : "text-on-surface-variant/50"
                        }`}>
                          {phase === "correct" ? "Solved" : "Answer"}
                        </span>
                        <p className="text-sm text-on-surface-variant/65 leading-relaxed">{explanation}</p>
                      </div>
                    );
                  })()}
                  <div className="grid grid-cols-4 gap-1.5 mb-2">
                    {RATING_BUTTONS.map((r) => (
                      <button key={r.value} onClick={() => rate(r.value)}
                        className={`py-3 flex flex-col items-center justify-center font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${r.color}`}>
                        <span>{r.label}</span>
                        {/* Real-Anki affordance: tell the user
                            exactly when each rating will surface
                            this card again. Shows up right under
                            the label on its own line. */}
                        {intervalHints && (
                          <span className="font-mono text-[9px] opacity-60 mt-0.5 normal-case tracking-normal">
                            {intervalHints[r.key] || ""}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <div className="flex gap-2 mt-3">
                <button onClick={skip}
                  className="flex-1 py-2 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-primary transition-colors">
                  Skip
                </button>
                <button onClick={removeCurrent}
                  className="flex-1 py-2 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/30 hover:text-error hover:border-error/20 transition-colors">
                  Remove from deck
                </button>
              </div>
            </div>
          </div>

          {/* Sidebar - rich card metadata + Anki-style queue
              breakdown + 7-day forecast. Replaces the old plain
              "cards due / total" block. */}
          <div className="w-full xl:w-[300px] shrink-0 space-y-4">
            {/* Card metadata - rating, themes, opening, source link.
                All optional. Skipped if the card carries none. */}
            <CardMetadata card={card} />

            {/* Anki queue breakdown - Today's queue grouped by state
                so the user knows whether they're seeing new cards
                vs. learning steps vs. reviews. */}
            <QueueBreakdown summary={deckSummary} />

            {/* 7-day forecast bars. Same data Anki shows on its
                deck page. Lets the user see the upcoming load
                before they get there. */}
            <Forecast forecast={deckForecast} />

            {/* Session counter - kept compact so the rest of the
                sidebar can breathe. */}
            <div className="p-3 bg-surface-container border border-white/[0.04] grid grid-cols-2 gap-1.5">
              <div className="text-center">
                <span className="font-headline text-2xl font-extrabold text-primary block leading-none">{reviewed}</span>
                <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25 mt-1 block">Done today</span>
              </div>
              <div className="text-center">
                <span className="font-headline text-2xl font-extrabold text-on-surface-variant/45 block leading-none">{deckSummary.dueNow}</span>
                <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25 mt-1 block">Still due</span>
              </div>
            </div>
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
 * loss, source link, played-vs-best SAN. Each row only renders
 * when the underlying field is present.
 */
function CardMetadata({ card }) {
  if (!card) return null;
  const themes = Array.isArray(card.themes) ? card.themes.slice(0, 5) : [];
  // Treat 0 (or negative) eval-loss as "no real loss to show" for
  // visibility purposes - rendering an empty bar is more confusing
  // than just hiding it.
  const evalLoss = Number.isFinite(card.eval_loss_cp) && card.eval_loss_cp > 0
    ? card.eval_loss_cp
    : null;
  const hasAny = card.rating || card.opening || card.played_san || card.best_san
    || themes.length > 0 || evalLoss != null || card.source_url || card.source;
  if (!hasAny) return null;

  // Eval-loss bar shown for AI-detected mistake cards. Mapped onto
  // a 0..600 cp scale (a "blunder" is ~300+ cp, so 600 is the
  // visual saturation point).
  const lossPct = evalLoss != null ? Math.min(100, Math.round((evalLoss / 600) * 100)) : null;
  const lossTone = evalLoss == null ? "" : evalLoss >= 300 ? "bg-error" : evalLoss >= 100 ? "bg-amber-400" : "bg-on-surface-variant/40";

  return (
    <div className="p-4 bg-surface-low border border-white/[0.04] space-y-3">
      <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">
        Card details
      </h3>

      {(card.played_san || card.best_san) && (
        <div className={`grid gap-2 ${card.played_san && card.best_san ? "grid-cols-2" : "grid-cols-1"}`}>
          {card.played_san && (
            <div>
              <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/30 block mb-0.5">You played</span>
              <span className="font-mono text-sm text-error/80">{card.played_san}</span>
            </div>
          )}
          {card.best_san && (
            <div>
              <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/30 block mb-0.5">Engine line</span>
              <span className="font-mono text-sm text-emerald-400">{card.best_san}</span>
            </div>
          )}
        </div>
      )}

      {evalLoss != null && evalLoss > 0 && (
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

      {themes.length > 0 && (
        <div>
          <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/30 block mb-1.5">Themes</span>
          <div className="flex flex-wrap gap-1">
            {themes.map((t) => (
              <span key={t} className="px-1.5 py-0.5 bg-surface-container border border-white/[0.04] text-[10px] text-on-surface-variant/60">
                {t.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        </div>
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
 * Analysis, ...), then user-created drill sets, then the catch-all
 * "All cards" deck at the bottom for the "actually I want to see
 * everything" use case.
 *
 * Drill sets show a delete button. Built-ins don't (they're
 * type-derived, they auto-disappear when the type has zero cards).
 * Coach-tagged drill sets get a subtle "AI" pill.
 */
function DeckBrowser({ decks, onOpen, onDelete, onOpenPlan }) {
  const builtins = decks.filter((d) => d.kind === "builtin" && d.id !== "builtin:all");
  const drills = decks.filter((d) => d.kind === "drill");
  const allDeck = decks.find((d) => d.id === "builtin:all");

  if (decks.length === 0) {
    return (
      <div className="text-center py-10 anim-fade-up">
        <h2 className="font-headline text-2xl font-extrabold tracking-tighter text-primary mb-3">No decks yet</h2>
        <p className="text-sm text-on-surface-variant/40 max-w-md mx-auto leading-relaxed mb-5">
          Save positions from the analysis board, fail a puzzle, or open the Plan tab to import games and auto-extract mistakes.
        </p>
        <button onClick={onOpenPlan} className="btn btn-primary px-5 py-2 text-xs">
          Open Plan
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 anim-fade-up">
      {builtins.length > 0 && (
        <DeckSection title="Built-in" subtitle="Type-based decks pulled from your card collection">
          {builtins.map((d) => (
            <DeckCard key={d.id} deck={d} onClick={() => onOpen(d.id)} />
          ))}
        </DeckSection>
      )}

      <DeckSection
        title="My decks"
        subtitle={drills.length > 0
          ? "Saved drills - click to study, or open the Plan tab to add more"
          : "No saved drills yet. Open the Plan tab to generate decks from your weakness profile"}
        action={(
          <button onClick={onOpenPlan}
            className="text-[10px] font-headline font-bold uppercase tracking-widest text-primary/70 hover:text-primary transition-colors">
            + New deck (Plan)
          </button>
        )}
      >
        {drills.map((d) => (
          <DeckCard key={d.id} deck={d} onClick={() => onOpen(d.id)} onDelete={() => onDelete(d)} />
        ))}
      </DeckSection>

      {allDeck && (
        <DeckSection title="Everything" subtitle="Fall back to the full collection if you want one big queue">
          <DeckCard deck={allDeck} onClick={() => onOpen(allDeck.id)} muted />
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
