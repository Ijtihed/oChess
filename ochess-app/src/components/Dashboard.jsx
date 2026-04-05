import { useMemo } from "react";
import ChessBoard from "./ChessBoard";
import LivePulse from "./LivePulse";
import SocialPanel from "./SocialPanel";
import { loadPuzzleRating } from "../lib/puzzles";

const HISTORY_KEY = "ochess_puzzle_history";
const STREAK_KEY = "ochess_puzzle_streak";

function getPuzzleStats() {
  try { const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}"); let s = 0; for (const v of Object.values(h)) { if (v.result === "solved") s++; } return { solved: s, total: Object.keys(h).length }; } catch { return { solved: 0, total: 0 }; }
}
function getStreak() {
  try { return JSON.parse(localStorage.getItem(STREAK_KEY) || "{}"); } catch { return {}; }
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

export default function Dashboard({ user, onNavigate }) {
  const pr = useMemo(() => loadPuzzleRating(), []);
  const ps = useMemo(() => getPuzzleStats(), []);
  const streak = useMemo(() => getStreak(), []);

  return (
    <div className="flex">
      <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-5 sm:px-6 md:px-10 py-6 sm:py-10">
      {/* Greeting */}
      <div className="anim-fade-up mb-6 sm:mb-10" style={{ "--delay": "0.05s" }}>
        <h1 className="font-headline text-2xl sm:text-3xl md:text-4xl font-extrabold tracking-tighter text-primary mb-1">
          {user.guest ? "Welcome" : `Hey, ${user.name}`}
        </h1>
        <LivePulse />
      </div>

      <div className="flex flex-col lg:flex-row gap-6 lg:gap-10">
        {/* ── Left column ── */}
        <div className="flex-1 space-y-6">
          {/* Review nudge */}
          <button
            onClick={() => onNavigate("review")}
            className="anim-fade-up w-full flex items-center justify-between p-4 sm:p-5 bg-surface-low border border-primary/15 hover:border-primary/25 hover:bg-surface-high/40 transition-all duration-200 active:scale-[0.98]"
            style={{ "--delay": "0.08s" }}
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
              </div>
              <div className="text-left">
                <span className="font-headline text-sm font-bold text-primary block">Review your chess memory</span>
                <span className="text-[10px] text-on-surface-variant/40">Spaced repetition for positions, tactics, and openings</span>
              </div>
            </div>
            <span className="font-headline text-[10px] font-bold uppercase tracking-widest text-primary/50 shrink-0 ml-4">
              Start →
            </span>
          </button>

          {/* Quick play */}
          <div className="anim-fade-up" style={{ "--delay": "0.12s" }}>
            <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">
              Quick Play
            </h2>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
              {TIME_CONTROLS.map((tc) => (
                <button
                  key={tc.label}
                  onClick={() => onNavigate("play")}
                  className="flex flex-col items-center justify-center py-3 sm:py-4 bg-surface-low border border-white/[0.04] hover:bg-surface-high transition-colors active:scale-[0.96]"
                >
                  <span className="font-headline text-sm sm:text-base font-bold text-primary">{tc.label}</span>
                  <span className="text-[9px] text-on-surface-variant/35 uppercase tracking-wide mt-0.5">{tc.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Action grid */}
          <div className="anim-fade-up" style={{ "--delay": "0.18s" }}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-2.5">
              {QUICK_ACTIONS.map((a) => (
                <button
                  key={a.id}
                  onClick={() => onNavigate(a.id)}
                  className={`flex flex-col p-4 sm:p-5 text-left transition-all duration-200 active:scale-[0.96] ${
                    a.primary
                      ? "bg-primary text-on-primary hover:bg-primary-dim"
                      : a.accent
                      ? "bg-surface-low border border-primary/15 hover:bg-surface-high hover:border-primary/25"
                      : "bg-surface-low border border-white/[0.04] hover:bg-surface-high"
                  }`}
                >
                  <span className={`font-headline text-[13px] sm:text-sm font-bold tracking-tight mb-1 ${
                    a.accent ? "text-primary" : ""
                  }`}>{a.label}</span>
                  <span className={`text-[10px] sm:text-[11px] ${
                    a.primary ? "text-on-primary/50" : a.accent ? "text-on-surface-variant/50" : "text-on-surface-variant/35"
                  }`}>{a.sub}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Puzzle stats */}
          {ps.total > 0 && (
            <div className="anim-fade-up" style={{ "--delay": "0.24s" }}>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">
                Your Puzzles
              </h2>
              <div className="flex items-center gap-4 p-4 bg-surface-low border border-white/[0.04]">
                <div>
                  <span className="font-headline text-2xl font-extrabold text-primary block">{pr.rating}</span>
                  <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25">Puzzle rating</span>
                </div>
                <div className="w-px h-8 bg-white/[0.04]" />
                <div>
                  <span className="font-headline text-lg font-extrabold text-emerald-400 block">{ps.solved}</span>
                  <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25">Solved</span>
                </div>
                <div className="w-px h-8 bg-white/[0.04]" />
                <div>
                  <span className="font-headline text-lg font-extrabold text-on-surface-variant/50 block">{streak.best || 0}</span>
                  <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25">Best streak</span>
                </div>
                <button onClick={() => onNavigate("puzzles")} className="ml-auto text-[10px] font-headline font-bold uppercase tracking-wide text-primary/50 hover:text-primary transition-colors">
                  Puzzles →
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Right column: board (desktop) ── */}
        <div className="hidden lg:block w-[380px] xl:w-[420px] shrink-0">
          <div className="anim-scale-in sticky top-20" style={{ "--delay": "0.2s", "--dur": "0.6s" }}>
            <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">
              Daily Puzzle
            </h2>
            <ChessBoard cycling cycleInterval={4000} />
            <button
              onClick={() => onNavigate("puzzles")}
              className="w-full mt-3 py-2.5 bg-surface-low border border-white/[0.04] font-headline text-[11px] font-bold uppercase tracking-wide text-on-surface-variant/60 hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.97]"
            >
              Solve Puzzle
            </button>
          </div>
        </div>
      </div>
      </div>
      <SocialPanel />
    </div>
  );
}
