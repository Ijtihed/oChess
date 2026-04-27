import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Chess } from "chess.js";
import InteractiveBoard from "./InteractiveBoard";
import SocialPanel from "./SocialPanel";
import { playVictory, playError } from "../lib/sounds";
import {
  cardId,
  loadCards,
  saveCards,
  removeCard,
  loadSchedules,
  saveSchedules,
  rateCard,
  isCardDue,
  RATING,
} from "../lib/review-cards";

const RATING_BUTTONS = [
  { label: "Again", value: RATING.AGAIN, color: "bg-error/20 text-error hover:bg-error/30 border border-error/10" },
  { label: "Hard",  value: RATING.HARD,  color: "bg-surface-low border border-white/[0.04] text-on-surface-variant/60 hover:text-primary hover:bg-surface-high" },
  { label: "Good",  value: RATING.GOOD,  color: "bg-surface-low border border-white/[0.04] text-on-surface-variant/60 hover:text-primary hover:bg-surface-high" },
  { label: "Easy",  value: RATING.EASY,  color: "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/10" },
];

function deckLabel(card) {
  switch (card?.type) {
    case "puzzle":   return "Puzzle";
    case "analysis": return "Analysis position";
    case "game":     return "From a game";
    case "tactic":   return "Tactic";
    case "opening":  return "Opening";
    case "endgame":  return "Endgame";
    case "mistake":  return "My Mistakes";
    default:         return "Saved position";
  }
}

function promptText(card) {
  const fen = card?.fen || "";
  const turn = fen.includes(" b ") ? "Black" : "White";
  if (card?.type === "puzzle") return `${turn} to move. Find the best move.`;
  if (card?.type === "analysis") return `${turn} to move. Recall the position.`;
  if (card?.type === "game") return `${turn} to move. What did you play here?`;
  return `${turn} to move.`;
}

function orientationFor(card) {
  return (card?.fen || "").includes(" b ") ? "black" : "white";
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
  const [phase, setPhase] = useState("prompt");
  const [highlight, setHighlight] = useState({});
  const [reviewed, setReviewed] = useState(0);
  const [deckFilter, setDeckFilter] = useState("all");
  const gameRef = useRef(null);

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

  // Recompute the due queue on every render — cheap, ~tens of cards.
  const dueIds = useMemo(
    () => cards.filter((c) => activeFilter.match(c) && isCardDue(schedules, cardId(c))).map(cardId),
    [cards, schedules, activeFilter]
  );
  const card = useMemo(
    () => cards.find((c) => cardId(c) === dueIds[0]) || null,
    [cards, dueIds]
  );

  // If localStorage is mutated by another page (e.g. user adds a card
  // from the analysis board in another tab), refresh on focus or
  // visibilitychange. Both listeners are removed on unmount.
  useEffect(() => {
    const refresh = () => {
      setCards(loadCards());
      setSchedules(loadSchedules());
    };
    const onVis = () => { if (!document.hidden) refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const resetCard = useCallback(() => {
    setPhase("prompt");
    setHighlight({});
    gameRef.current = null;
  }, []);

  const handleMove = useCallback((move) => {
    if (!card || phase !== "prompt") return false;
    const answer = card.answerMove;
    // Cards that store an explicit answer move (e.g. from puzzles) get
    // automatic right/wrong feedback. Others fall through to manual
    // "show answer" mode.
    if (answer && move.from === answer.from && move.to === answer.to) {
      try {
        const g = new Chess(card.fen);
        const result = g.move(move);
        if (result) {
          gameRef.current = g;
          setHighlight({
            [move.from]: { backgroundColor: "rgba(76,175,80,0.25)" },
            [move.to]:   { backgroundColor: "rgba(76,175,80,0.35)" },
          });
          setPhase("correct");
          playVictory();
          return true;
        }
      } catch {}
    }
    if (answer) {
      playError();
      setHighlight({
        [answer.from]: { backgroundColor: "rgba(76,175,80,0.3)" },
        [answer.to]:   { backgroundColor: "rgba(76,175,80,0.4)" },
      });
      setPhase("incorrect");
    }
    return false;
  }, [card, phase]);

  const showAnswer = useCallback(() => {
    if (!card) return;
    if (card.answerMove) {
      setHighlight({
        [card.answerMove.from]: { backgroundColor: "rgba(76,175,80,0.3)" },
        [card.answerMove.to]:   { backgroundColor: "rgba(76,175,80,0.4)" },
      });
    }
    setPhase("revealed");
  }, [card]);

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
    // Treat skip as "Hard" without ratcheting interval up — just reset
    // the prompt and move on without crediting it as a review.
    resetCard();
    setSchedules((prev) => {
      const next = rateCard(prev, cardId(card), RATING.AGAIN);
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

  if (totalCards === 0) {
    return (
      <div className="flex">
        <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-12 text-center">
          <h1 className="font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-3">Review</h1>
          <p className="text-sm text-on-surface-variant/40 max-w-md mx-auto leading-relaxed">
            No cards yet. Save positions from the Analysis board, your bot games, or failed puzzles
            and they will appear here for spaced-repetition review.
          </p>
        </div>
        <SocialPanel />
      </div>
    );
  }

  if (!card) {
    // The active filter has no due cards. If the user is on a narrow
    // filter (Puzzles / Games / Analysis), offer to switch back to
    // "All" so they can see whatever else might be due first. Avoids
    // the dead-end where someone sees "All caught up" while another
    // deck still has work waiting.
    const otherDecksWithDue = DECK_FILTERS
      .filter((f) => f.id !== deckFilter && f.id !== "all")
      .filter((f) => cards.some((c) => f.match(c) && isCardDue(schedules, cardId(c))));
    return (
      <div className="flex">
        <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-12 text-center">
          <h1 className="font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-3">
            {deckFilter === "all" ? "All caught up" : `No ${activeFilter.label.toLowerCase()} due`}
          </h1>
          <p className="text-sm text-on-surface-variant/40 max-w-md mx-auto leading-relaxed mb-6">
            {deckFilter === "all"
              ? "You've reviewed every card that's due right now. Come back tomorrow, or save more positions from the Analysis board."
              : `No ${activeFilter.label.toLowerCase()} cards are due in this filter right now.`}
          </p>
          {deckFilter !== "all" && otherDecksWithDue.length > 0 && (
            <button onClick={() => setDeckFilter("all")}
              className="btn btn-primary px-5 py-2 text-xs mb-6">
              See all due cards
            </button>
          )}
          <p className="text-[11px] uppercase tracking-widest text-on-surface-variant/25">
            {totalCards} card{totalCards === 1 ? "" : "s"} in your deck
          </p>
        </div>
        <SocialPanel />
      </div>
    );
  }

  const fen = phase === "correct" && gameRef.current ? gameRef.current.fen() : card.fen;
  const orientation = orientationFor(card);

  return (
    <div className="flex">
      <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
        {/* Deck filter chips. Click cycles the active filter; the
            queue rebuilds on the next render. Counts are pulled from
            `deckCounts` so the user knows what's available before
            switching. The "all" chip never disables; the others gray
            out when their bucket is empty. */}
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

        <div className="flex flex-col xl:flex-row gap-6 xl:gap-8">
          {/* Board column */}
          <div className="flex-1 flex flex-col items-center xl:items-start max-w-[700px]">
            <div className="w-full mb-3">
              <span className="text-[9px] font-label uppercase tracking-widest text-on-surface-variant/30 block mb-1">
                {deckLabel(card)} · {reviewed + 1} of {reviewed + remaining}
                {/* Surface card-source metadata if the writer attached
                    any. Puzzle cards carry a numeric rating + tags;
                    game cards carry the SAN that was played. Showing
                    them gives the user useful context without taking
                    up a whole sidebar block. */}
                {card.rating ? ` · Rating ${card.rating}` : ""}
                {card.san ? ` · ${card.san}` : ""}
                {Array.isArray(card.themes) && card.themes.length > 0 && (
                  ` · ${card.themes.slice(0, 3).join(", ")}`
                )}
              </span>
              <h1 className="font-headline text-lg sm:text-xl font-extrabold tracking-tighter text-primary">
                {promptText(card)}
              </h1>
            </div>

            <InteractiveBoard
              fen={fen}
              onMove={handleMove}
              orientation={orientation}
              interactive={phase === "prompt" && !!card.answerMove}
              highlightSquares={highlight}
            />

            <div className="w-full mt-4">
              {phase === "prompt" && (
                <div className="flex gap-2">
                  <button onClick={showAnswer}
                    className="flex-1 py-3.5 bg-surface-low border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.96]">
                    {card.answerMove ? "Show Answer" : "Reveal & Rate"}
                  </button>
                  <span className="flex-[2] py-3.5 bg-primary/5 border border-primary/10 text-center font-headline text-xs font-bold uppercase tracking-wide text-primary/60">
                    {card.answerMove ? "Make your move on the board" : "Recall — then rate yourself"}
                  </span>
                </div>
              )}

              {(phase === "correct" || phase === "incorrect" || phase === "revealed") && (
                <>
                  {(card.answerText || card.notes) && (
                    <div className={`p-4 mb-3 border ${
                      phase === "correct" ? "bg-emerald-500/5 border-emerald-500/10" : "bg-surface-container border-white/[0.04]"
                    }`}>
                      <span className={`text-xs font-headline font-bold uppercase tracking-wide block mb-2 ${
                        phase === "correct" ? "text-emerald-400" : phase === "incorrect" ? "text-error" : "text-on-surface-variant/50"
                      }`}>
                        {phase === "correct" ? "Correct!" : phase === "incorrect" ? "Incorrect" : "Answer"}
                      </span>
                      <p className="text-sm text-on-surface-variant/60 leading-relaxed">{card.answerText || card.notes}</p>
                    </div>
                  )}
                  <div className="grid grid-cols-4 gap-1.5 mb-2">
                    {RATING_BUTTONS.map((r) => (
                      <button key={r.value} onClick={() => rate(r.value)}
                        className={`py-3 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${r.color}`}>
                        {r.label}
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

          {/* Sidebar */}
          <div className="w-full xl:w-[280px] shrink-0 space-y-6">
            <div>
              <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Review</h3>
              <h2 className="font-headline text-3xl font-extrabold text-primary mb-1">{remaining}</h2>
              <span className="text-[10px] text-on-surface-variant/25 uppercase tracking-widest">cards due</span>
            </div>

            <div>
              <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Session</h3>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="p-3 bg-surface-low border border-white/[0.03] text-center">
                  <span className="font-headline text-xl font-extrabold text-primary block">{reviewed}</span>
                  <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25">Reviewed</span>
                </div>
                <div className="p-3 bg-surface-low border border-white/[0.03] text-center">
                  <span className="font-headline text-xl font-extrabold text-on-surface-variant/40 block">{totalCards}</span>
                  <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25">Total</span>
                </div>
              </div>
            </div>

            <div className="p-4 bg-surface-container border border-white/[0.04]">
              <p className="text-[10px] text-on-surface-variant/25 leading-relaxed">
                Save positions from analysis, games, or failed puzzles to add them here. Rate each
                card to schedule the next review with SM-2 spaced repetition.
              </p>
            </div>
          </div>
        </div>
      </div>
      <SocialPanel />
    </div>
  );
}
