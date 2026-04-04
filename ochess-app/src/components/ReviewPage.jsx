import { useState, useCallback, useRef } from "react";
import { Chess } from "chess.js";
import InteractiveBoard from "./InteractiveBoard";
import { playVictory, playError } from "../lib/sounds";

const SAMPLE_CARDS = [
  {
    id: "1",
    deckName: "Missed Tactics",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4",
    prompt: "White to move. What's the best move?",
    answerMove: { from: "h5", to: "f7" },
    answerText: "Qxf7# — Scholar's Mate. The queen takes on f7 with checkmate, supported by the bishop on c4.",
    type: "tactic",
  },
  {
    id: "2",
    deckName: "Opening Lines",
    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
    prompt: "Black to move in the Sicilian Defense. What's the correct first move?",
    answerMove: { from: "c7", to: "c5" },
    answerText: "1...c5 — The Sicilian Defense. Black immediately fights for central control and avoids symmetrical positions.",
    type: "opening",
  },
  {
    id: "3",
    deckName: "Endgame Patterns",
    fen: "8/8/8/8/8/5K2/4P3/5k2 w - - 0 1",
    prompt: "White to move. How do you promote the pawn?",
    answerMove: { from: "f3", to: "e3" },
    answerText: "Ke3! — Opposition. White takes the opposition, ensuring the pawn can advance and promote. Ke4? would be a mistake due to Ke2.",
    type: "endgame",
  },
  {
    id: "4",
    deckName: "My Mistakes",
    fen: "r1b1k2r/ppppqppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 4 5",
    prompt: "You played Bg5 here and got punished. What should White play instead?",
    answerMove: { from: "b1", to: "c3" },
    answerText: "Nc3 — Develop the knight to a natural square. Bg5 was premature and allowed ...Nd4 with tempo.",
    type: "mistake",
  },
];

const RATINGS = [
  { label: "Again", value: 1, color: "bg-error/20 text-error hover:bg-error/30 border border-error/10" },
  { label: "Hard", value: 2, color: "bg-surface-low border border-white/[0.04] text-on-surface-variant/60 hover:text-primary hover:bg-surface-high" },
  { label: "Good", value: 3, color: "bg-surface-low border border-white/[0.04] text-on-surface-variant/60 hover:text-primary hover:bg-surface-high" },
  { label: "Easy", value: 4, color: "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/10" },
];

export default function ReviewPage() {
  const [cardIndex, setCardIndex] = useState(0);
  const [phase, setPhase] = useState("prompt");
  const [reviewed, setReviewed] = useState(0);
  const [highlight, setHighlight] = useState({});
  const gameRef = useRef(null);

  const card = SAMPLE_CARDS[cardIndex % SAMPLE_CARDS.length];

  const handleMove = useCallback((move) => {
    if (phase !== "prompt") return false;
    const answer = card.answerMove;
    if (move.from === answer.from && move.to === answer.to) {
      const g = new Chess(card.fen);
      try {
        const result = g.move(move);
        if (result) {
          gameRef.current = g;
          setHighlight({
            [move.from]: { backgroundColor: "rgba(76,175,80,0.25)" },
            [move.to]: { backgroundColor: "rgba(76,175,80,0.35)" },
          });
          setPhase("correct");
          return true;
        }
      } catch {}
    }
    playError();
    setHighlight({
      [answer.from]: { backgroundColor: "rgba(76,175,80,0.3)" },
      [answer.to]: { backgroundColor: "rgba(76,175,80,0.4)" },
    });
    setPhase("incorrect");
    return false;
  }, [card, phase]);

  const showAnswer = useCallback(() => {
    setHighlight({
      [card.answerMove.from]: { backgroundColor: "rgba(76,175,80,0.3)" },
      [card.answerMove.to]: { backgroundColor: "rgba(76,175,80,0.4)" },
    });
    setPhase("revealed");
  }, [card]);

  const rateAndNext = useCallback(() => {
    setReviewed((r) => r + 1);
    setCardIndex((i) => i + 1);
    setPhase("prompt");
    setHighlight({});
    gameRef.current = null;
  }, []);

  const displayFen = phase === "correct" && gameRef.current ? gameRef.current.fen() : card.fen;
  const playerColor = card.fen.includes(" w ") ? "w" : "b";

  return (
    <div className="max-w-[1440px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
      <div className="flex flex-col xl:flex-row gap-6 xl:gap-8">
        {/* Board area */}
        <div className="flex-1 flex flex-col items-center xl:items-start max-w-[700px]">
          <div className="w-full mb-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[9px] font-label uppercase tracking-widest text-on-surface-variant/30 block mb-1">
                  {card.deckName} · Card {(cardIndex % SAMPLE_CARDS.length) + 1}
                </span>
                <h1 className="font-headline text-lg sm:text-xl font-extrabold tracking-tighter text-primary">
                  {card.prompt}
                </h1>
              </div>
            </div>
          </div>

          <InteractiveBoard
            fen={displayFen}
            onMove={handleMove}
            orientation={playerColor === "w" ? "white" : "black"}
            interactive={phase === "prompt"}
            highlightSquares={highlight}
          />

          {/* Controls below board */}
          <div className="w-full mt-4">
            {phase === "prompt" && (
              <div className="flex gap-2">
                <button
                  onClick={showAnswer}
                  className="flex-1 py-3.5 bg-surface-low border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.96]"
                >
                  Show Answer
                </button>
                <span className="flex-[2] py-3.5 bg-primary/5 border border-primary/10 text-center font-headline text-xs font-bold uppercase tracking-wide text-primary/60">
                  Make your move on the board
                </span>
              </div>
            )}

            {(phase === "correct" || phase === "incorrect" || phase === "revealed") && (
              <>
                <div className={`p-4 mb-3 border ${
                  phase === "correct" ? "bg-emerald-500/5 border-emerald-500/10" : "bg-surface-container border-white/[0.04]"
                }`}>
                  <span className={`text-xs font-headline font-bold uppercase tracking-wide block mb-2 ${
                    phase === "correct" ? "text-emerald-400" : phase === "incorrect" ? "text-error" : "text-on-surface-variant/50"
                  }`}>
                    {phase === "correct" ? "Correct!" : phase === "incorrect" ? "Incorrect" : "Answer"}
                  </span>
                  <p className="text-sm text-on-surface-variant/60 leading-relaxed">{card.answerText}</p>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {RATINGS.map((r) => (
                    <button
                      key={r.value}
                      onClick={rateAndNext}
                      className={`py-3 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${r.color}`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-full xl:w-[280px] shrink-0 space-y-6">
          <div>
            <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">
              Review
            </h3>
            <h2 className="font-headline text-3xl font-extrabold text-primary mb-1">
              {SAMPLE_CARDS.length - reviewed}
            </h2>
            <span className="text-[10px] text-on-surface-variant/25 uppercase tracking-widest">cards remaining</span>
          </div>

          <div>
            <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">
              Session
            </h3>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="p-3 bg-surface-low border border-white/[0.03] text-center">
                <span className="font-headline text-xl font-extrabold text-primary block">{reviewed}</span>
                <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25">Reviewed</span>
              </div>
              <div className="p-3 bg-surface-low border border-white/[0.03] text-center">
                <span className="font-headline text-xl font-extrabold text-on-surface-variant/40 block">{SAMPLE_CARDS.length}</span>
                <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25">Total</span>
              </div>
            </div>
          </div>

          <div className="p-4 bg-surface-container border border-white/[0.04]">
            <p className="text-[10px] text-on-surface-variant/25 leading-relaxed">
              Try to find the best move on the board. If you're stuck, click "Show Answer" to reveal it. Rate how well you remembered to schedule the next review.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
