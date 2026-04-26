import { useMemo, useState, useEffect, useCallback } from "react";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import LivePulse from "./LivePulse";
import SocialPanel from "./SocialPanel";
import { loadPuzzleRating, loadPuzzles, getAdaptivePuzzle } from "../lib/puzzles";
import { load as loadPrefs, getTheme } from "../lib/board-prefs";

const HISTORY_KEY = "ochess_puzzle_history";
const STREAK_KEY = "ochess_puzzle_streak";
const DAILY_KEY = "ochess_daily_puzzle";

function getPuzzleStats() {
  try { const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}"); let s = 0; for (const v of Object.values(h)) { if (v.result === "solved") s++; } return { solved: s, total: Object.keys(h).length }; } catch { return { solved: 0, total: 0 }; }
}
function getStreak() {
  try { return JSON.parse(localStorage.getItem(STREAK_KEY) || "{}"); } catch { return {}; }
}

function getDailyPuzzle(puzzles) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const saved = JSON.parse(localStorage.getItem(DAILY_KEY) || "{}");
    if (saved.date === today && saved.puzzle) return saved.puzzle;
    const pool = puzzles.filter((p) => p.rating >= 2000).sort((a, b) => (a.id || "").localeCompare(b.id || ""));
    if (pool.length === 0) return null;
    let seed = 0;
    for (const ch of today) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const puzzle = pool[seed % pool.length];
    localStorage.setItem(DAILY_KEY, JSON.stringify({ date: today, puzzle }));
    return puzzle;
  } catch { return null; }
}

const QUICK_ACTIONS = [
  { id: "play", label: "Play Online", sub: "Find a rated match", primary: true },
  { id: "review", label: "Anki", sub: "Cards due today", accent: true },
  { id: "bots", label: "Play Bot", sub: "Practice against AI" },
  { id: "puzzles", label: "Puzzles", sub: "Sharpen your tactics" },
  { id: "analysis", label: "Analysis", sub: "Review a game" },
];

const TIME_CONTROLS = [
  { label: "1+0", name: "Bullet" },
  { label: "3+0", name: "Blitz" },
  { label: "5+3", name: "Blitz" },
  { label: "10+0", name: "Rapid" },
  { label: "15+10", name: "Rapid" },
  { label: "30+0", name: "Classical" },
];

function DailyBoard({ puzzle }) {
  const prefs = loadPrefs();
  const theme = getTheme(prefs.boardTheme);
  const isImage = theme.type === "image";

  const fen = useMemo(() => {
    if (!puzzle?.fen) return "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    try {
      const g = new Chess(puzzle.fen);
      const setupMoves = puzzle.moves?.slice(0, 1) || [];
      for (const uci of setupMoves) {
        g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
      }
      return g.fen();
    } catch { return puzzle.fen; }
  }, [puzzle]);

  const orientation = useMemo(() => {
    if (!puzzle?.fen) return "white";
    const parts = puzzle.fen.split(" ");
    return parts[1] === "b" ? "white" : "black";
  }, [puzzle]);

  return (
    <div className="w-full pointer-events-none">
      <Chessboard options={{
        position: fen,
        boardOrientation: orientation,
        boardStyle: isImage ? { borderRadius: "0px", backgroundImage: `url(${theme.src})`, backgroundSize: "100% 100%" } : { borderRadius: "0px" },
        darkSquareStyle: isImage ? { backgroundColor: "transparent" } : { backgroundColor: theme.dark },
        lightSquareStyle: isImage ? { backgroundColor: "transparent" } : { backgroundColor: theme.light },
        allowDragging: false,
        showNotation: true,
        animationDurationInMs: 0,
      }} />
    </div>
  );
}

export default function Dashboard({ user, onNavigate }) {
  const pr = useMemo(() => loadPuzzleRating(), []);
  const ps = useMemo(() => getPuzzleStats(), []);
  const streak = useMemo(() => getStreak(), []);
  const [dailyPuzzle, setDailyPuzzle] = useState(null);
  const [dailySolved, setDailySolved] = useState(false);

  const firstName = useMemo(() => {
    if (!user?.name) return "there";
    return user.name.split(" ")[0];
  }, [user]);

  const checkDailySolved = useCallback((puzzle) => {
    if (!puzzle) return;
    // Check localStorage first (instant, always up-to-date)
    try {
      const h = JSON.parse(localStorage.getItem("ochess_puzzle_history") || "{}");
      if (h[puzzle.id]?.result === "solved") { setDailySolved(true); return; }
    } catch {}
    // Check server
    if (user?.id) {
      import("../lib/puzzle-sync").then(({ isDailyPuzzleSolved }) => {
        isDailyPuzzleSolved(user.id).then((v) => { if (v) setDailySolved(true); });
      }).catch(() => {});
    }
  }, [user]);

  useEffect(() => {
    loadPuzzles().then((puzzles) => {
      if (puzzles?.length) {
        const dp = getDailyPuzzle(puzzles);
        setDailyPuzzle(dp);
        checkDailySolved(dp);
      }
    }).catch(() => {});
  }, [user, checkDailySolved]);

  // Re-check when tab regains focus (user solved puzzle in another tab/page)
  useEffect(() => {
    const handler = () => { if (dailyPuzzle) checkDailySolved(dailyPuzzle); };
    window.addEventListener("focus", handler);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) handler(); });
    return () => { window.removeEventListener("focus", handler); };
  }, [dailyPuzzle, checkDailySolved]);

  return (
    <div className="flex min-h-[calc(100vh-4rem)]">
      <div className="flex-1 min-w-0 px-5 sm:px-6 xl:pl-16 xl:pr-6 py-8 sm:py-12">
      {/* Greeting */}
      <div className="anim-fade-up mb-10 sm:mb-14" style={{ "--delay": "0.05s" }}>
        <h1 className="font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-4">
          {user.guest ? "Welcome" : `Hey, ${firstName}`}
        </h1>
        <LivePulse />
      </div>

      <div className="flex flex-col lg:flex-row gap-8 lg:gap-12">
        {/* ── Left column ── */}
        <div className="flex-1 space-y-8">
          {/* Review nudge */}
          <button
            onClick={() => onNavigate("review")}
            className="anim-fade-up w-full flex items-center justify-between p-5 sm:p-6 bg-surface-low border border-primary/15 hover:border-primary/25 hover:bg-surface-high/40 transition-all duration-200 active:scale-[0.98]"
            style={{ "--delay": "0.08s" }}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
              </div>
              <div className="text-left">
                <span className="font-headline text-sm font-bold text-primary block">Review your chess memory</span>
                <span className="text-[11px] text-on-surface-variant/40">Spaced repetition for positions, tactics, and openings</span>
              </div>
            </div>
            <span className="font-headline text-[11px] font-bold uppercase tracking-widest text-primary/50 shrink-0 ml-4">Start →</span>
          </button>

          {/* Quick play */}
          <div className="anim-fade-up" style={{ "--delay": "0.12s" }}>
            <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Quick Play</h2>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
              {TIME_CONTROLS.map((tc) => (
                <button key={tc.label} onClick={() => onNavigate("play")}
                  className="flex flex-col items-center justify-center py-4 bg-surface-low border border-white/[0.04] hover:bg-surface-high transition-colors active:scale-[0.96]">
                  <span className="font-headline text-base font-bold text-primary">{tc.label}</span>
                  <span className="text-[9px] text-on-surface-variant/35 uppercase tracking-wide mt-0.5">{tc.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Action grid */}
          <div className="anim-fade-up" style={{ "--delay": "0.18s" }}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {QUICK_ACTIONS.map((a) => (
                <button key={a.id} onClick={() => onNavigate(a.id)}
                  className={`flex flex-col p-5 text-left transition-all duration-200 active:scale-[0.96] ${
                    a.primary ? "bg-primary text-on-primary hover:bg-primary-dim"
                    : a.accent ? "bg-surface-low border border-primary/15 hover:bg-surface-high hover:border-primary/25"
                    : "bg-surface-low border border-white/[0.04] hover:bg-surface-high"
                  }`}>
                  <span className={`font-headline text-sm font-bold tracking-tight mb-1 ${a.accent ? "text-primary" : ""}`}>{a.label}</span>
                  <span className={`text-[11px] ${a.primary ? "text-on-primary/50" : a.accent ? "text-on-surface-variant/50" : "text-on-surface-variant/35"}`}>{a.sub}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Puzzle stats */}
          {ps.total > 0 && (
            <div className="anim-fade-up" style={{ "--delay": "0.24s" }}>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Your Puzzles</h2>
              <div className="flex items-center gap-5 p-5 bg-surface-low border border-white/[0.04]">
                <div>
                  <span className="font-headline text-3xl font-extrabold text-primary block">{pr.rating}</span>
                  <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25">Puzzle rating</span>
                </div>
                <div className="w-px h-10 bg-white/[0.04]" />
                <div>
                  <span className="font-headline text-xl font-extrabold text-emerald-400 block">{ps.solved}</span>
                  <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25">Solved</span>
                </div>
                <div className="w-px h-10 bg-white/[0.04]" />
                <div>
                  <span className="font-headline text-xl font-extrabold text-on-surface-variant/50 block">{streak.best || 0}</span>
                  <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25">Best streak</span>
                </div>
                <button onClick={() => onNavigate("puzzles")} className="ml-auto text-[11px] font-headline font-bold uppercase tracking-wide text-primary/50 hover:text-primary transition-colors">
                  Puzzles →
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Right column: daily puzzle ── */}
        <div className="hidden lg:block w-[380px] xl:w-[420px] shrink-0">
          <div className="anim-scale-in sticky top-20" style={{ "--delay": "0.2s", "--dur": "0.6s" }}>
            <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">
              Daily Puzzle
            </h2>
            {dailyPuzzle ? (
              <>
                <div className="cursor-pointer" onClick={() => onNavigate(`puzzles/${dailyPuzzle.id || ""}`)}>
                  <DailyBoard puzzle={dailyPuzzle} />
                </div>
                <div className="mt-2 flex items-center justify-between px-1">
                  <span className="text-[10px] text-on-surface-variant/25 font-mono">
                    {(Array.isArray(dailyPuzzle.themes) ? dailyPuzzle.themes : (dailyPuzzle.themes || "").split?.(" ") || []).filter(Boolean).slice(0, 2).join(" · ") || "Tactics"}
                  </span>
                  <span className="text-[10px] text-on-surface-variant/20 font-mono">Rating: {dailyPuzzle.rating || "?"}</span>
                </div>
              </>
            ) : (
              <div className="aspect-square bg-surface-low border border-white/[0.04] flex items-center justify-center">
                <span className="text-on-surface-variant/20 text-sm">Loading puzzle...</span>
              </div>
            )}
            <button
              onClick={() => {
                if (dailySolved && dailyPuzzle?.fen) {
                  const { Chess } = require("chess.js");
                  const g = new Chess(dailyPuzzle.fen);
                  if (dailyPuzzle.moves) { for (const uci of dailyPuzzle.moves) { try { g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined }); } catch { break; } } }
                  onNavigate("analysis");
                  setTimeout(() => { window.location.href = `/analysis?fen=${encodeURIComponent(dailyPuzzle.fen)}`; }, 0);
                } else {
                  onNavigate(dailyPuzzle ? `puzzles/${dailyPuzzle.id || ""}` : "puzzles");
                }
              }}
              className={`w-full mt-3 py-3 font-headline text-[12px] font-bold uppercase tracking-wide transition-colors active:scale-[0.97] ${
                dailySolved ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/60 hover:text-primary hover:bg-surface-high"
              }`}
            >
              {dailySolved ? "Solved — View Analysis" : "Solve Puzzle"}
            </button>
          </div>
        </div>
      </div>
      </div>
      <SocialPanel />
    </div>
  );
}
