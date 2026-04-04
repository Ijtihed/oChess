import { useState, useCallback, useRef, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { Chess } from "chess.js";
import InteractiveBoard from "./InteractiveBoard";

export default function AnalysisPage() {
  const location = useLocation();
  const initialPgn = location.state?.pgn || "";

  const [pgnInput, setPgnInput] = useState(initialPgn);
  const [loaded, setLoaded] = useState(!!initialPgn);
  const [history, setHistory] = useState([]);
  const [currentPly, setCurrentPly] = useState(0);
  const [fen, setFen] = useState("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  const [orientation, setOrientation] = useState("white");
  const baseRef = useRef(new Chess());
  const moveListRef = useRef(null);

  const loadGame = useCallback((pgn) => {
    const g = new Chess();
    if (pgn && pgn.trim()) {
      try { g.loadPgn(pgn); } catch { return; }
    }
    const hist = g.history({ verbose: true });
    baseRef.current = g;
    setHistory(hist);
    setCurrentPly(hist.length);
    setFen(g.fen());
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (initialPgn) loadGame(initialPgn);
  }, [initialPgn, loadGame]);

  const goToPly = useCallback((ply) => {
    const clamped = Math.max(0, Math.min(ply, history.length));
    const temp = new Chess();
    for (let i = 0; i < clamped; i++) {
      temp.move(history[i].san);
    }
    setFen(temp.fen());
    setCurrentPly(clamped);
  }, [history]);

  const handleFreeMove = useCallback((move) => {
    const temp = new Chess(fen);
    try {
      const result = temp.move(move);
      if (!result) return false;
      const newHist = history.slice(0, currentPly);
      newHist.push(result);
      setHistory(newHist);
      setCurrentPly(newHist.length);
      setFen(temp.fen());
      return true;
    } catch {
      return false;
    }
  }, [fen, history, currentPly]);

  useEffect(() => {
    if (moveListRef.current) {
      const active = moveListRef.current.querySelector("[data-active]");
      if (active) active.scrollIntoView({ block: "nearest" });
    }
  }, [currentPly]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); goToPly(currentPly - 1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); goToPly(currentPly + 1); }
      else if (e.key === "Home") { e.preventDefault(); goToPly(0); }
      else if (e.key === "End") { e.preventDefault(); goToPly(history.length); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goToPly, currentPly, history.length]);

  const movePairs = [];
  for (let i = 0; i < history.length; i += 2) {
    movePairs.push({ num: Math.floor(i / 2) + 1, white: history[i], black: history[i + 1] || null, wPly: i + 1, bPly: i + 2 });
  }

  if (!loaded) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
        <div className="anim-fade-up" style={{ "--delay": "0.05s" }}>
          <h1 className="font-headline text-3xl sm:text-4xl font-extrabold tracking-tighter text-primary mb-2">Analysis</h1>
          <p className="text-sm text-on-surface-variant/40 mb-6">Paste a PGN or start from the initial position.</p>

          <textarea
            value={pgnInput}
            onChange={(e) => setPgnInput(e.target.value)}
            placeholder="Paste PGN here..."
            rows={8}
            className="w-full bg-surface-low border border-white/[0.06] p-4 text-sm font-mono text-on-surface placeholder:text-on-surface-variant/20 outline-none focus:border-primary/40 transition-colors resize-none"
          />
          <div className="flex gap-2 mt-4">
            <button
              onClick={() => loadGame(pgnInput)}
              className="flex-1 py-3 bg-primary text-on-primary font-headline text-xs font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.96]"
            >
              Load PGN
            </button>
            <button
              onClick={() => loadGame("")}
              className="flex-1 py-3 bg-surface-low border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.96]"
            >
              Empty Board
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1440px] mx-auto px-4 sm:px-6 md:px-10 py-4 sm:py-6">
      <div className="flex flex-col xl:flex-row gap-4 xl:gap-6">
        {/* Board */}
        <div className="flex-1 flex flex-col items-center xl:items-start max-w-[700px]">
          <div className="w-full flex items-center justify-between mb-2">
            <h1 className="font-headline text-xl font-extrabold tracking-tighter text-primary">Analysis</h1>
            <div className="flex gap-1.5">
              <button
                onClick={() => setOrientation(orientation === "white" ? "black" : "white")}
                className="px-3 py-1.5 bg-surface-low border border-white/[0.04] text-[10px] font-headline font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary transition-colors active:scale-[0.96]"
              >
                Flip
              </button>
              <button
                onClick={() => { setLoaded(false); setPgnInput(baseRef.current.pgn()); }}
                className="px-3 py-1.5 bg-surface-low border border-white/[0.04] text-[10px] font-headline font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary transition-colors active:scale-[0.96]"
              >
                Load PGN
              </button>
            </div>
          </div>

          <InteractiveBoard
            fen={fen}
            onMove={handleFreeMove}
            orientation={orientation}
            interactive={true}
          />

          {/* Navigation buttons */}
          <div className="flex gap-1 mt-3 w-full">
            {[
              { label: "⏮", action: () => goToPly(0) },
              { label: "◀", action: () => goToPly(currentPly - 1) },
              { label: "▶", action: () => goToPly(currentPly + 1) },
              { label: "⏭", action: () => goToPly(history.length) },
            ].map((btn, i) => (
              <button
                key={i}
                onClick={btn.action}
                className="flex-1 py-3 bg-surface-low border border-white/[0.03] flex items-center justify-center text-on-surface-variant/40 hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.96] font-headline text-sm"
              >
                {btn.label}
              </button>
            ))}
          </div>

          <div className="w-full mt-2 px-1">
            <span className="text-[10px] text-on-surface-variant/20 font-mono">
              FEN: {fen}
            </span>
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-full xl:w-[320px] shrink-0 space-y-4">
          <div className="bg-surface-low flex flex-col">
            <div className="p-3 flex justify-between items-center border-b border-white/[0.03]">
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/40">Moves</h2>
              <span className="text-[10px] text-on-surface-variant/20">Ply {currentPly}/{history.length}</span>
            </div>
            <div ref={moveListRef} className="max-h-[400px] overflow-y-auto">
              {movePairs.length === 0 && (
                <div className="p-4 text-center text-[11px] text-on-surface-variant/20">
                  Make a move or load a PGN
                </div>
              )}
              {movePairs.map((m, i) => (
                <div
                  key={m.num}
                  className={`grid grid-cols-[2rem_1fr_1fr] text-sm ${i % 2 === 0 ? "bg-surface-lowest/50" : ""}`}
                >
                  <span className="text-[10px] text-on-surface-variant/25 self-center px-2 py-2">{m.num}.</span>
                  <button
                    onClick={() => goToPly(m.wPly)}
                    data-active={currentPly === m.wPly ? "" : undefined}
                    className={`text-left font-mono py-2 px-1 transition-colors hover:bg-primary/10 ${
                      currentPly === m.wPly ? "bg-primary/10 text-primary font-bold" : "text-on-surface-variant/70"
                    }`}
                  >
                    {m.white?.san}
                  </button>
                  {m.black ? (
                    <button
                      onClick={() => goToPly(m.bPly)}
                      data-active={currentPly === m.bPly ? "" : undefined}
                      className={`text-left font-mono py-2 px-1 transition-colors hover:bg-primary/10 ${
                        currentPly === m.bPly ? "bg-primary/10 text-primary font-bold" : "text-on-surface-variant/50"
                      }`}
                    >
                      {m.black.san}
                    </button>
                  ) : <span />}
                </div>
              ))}
            </div>
          </div>

          {/* Add to Review */}
          {currentPly > 0 && (
            <button
              onClick={() => {
                try {
                  const cards = JSON.parse(localStorage.getItem("ochess_review_cards") || "[]");
                  cards.push({ fen, type: "analysis", ply: currentPly, ts: Date.now() });
                  localStorage.setItem("ochess_review_cards", JSON.stringify(cards));
                } catch {}
              }}
              className="w-full py-3 bg-surface-low border border-primary/15 font-headline text-xs font-bold uppercase tracking-wide text-primary/70 hover:text-primary hover:border-primary/25 hover:bg-surface-high transition-colors active:scale-[0.96]"
            >
              Save position to Review
            </button>
          )}

          <div className="p-4 bg-surface-container border border-white/[0.04]">
            <p className="text-[10px] text-on-surface-variant/25 leading-relaxed">
              Use arrow keys to navigate. Click any move to jump. Make moves on the board to explore variations. Save any position to your Review deck for spaced repetition.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
