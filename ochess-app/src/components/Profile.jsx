import { useMemo } from "react";
import { loadPuzzleRating } from "../lib/puzzles";

const HISTORY_KEY = "ochess_puzzle_history";
const STREAK_KEY = "ochess_puzzle_streak";

function getPuzzleStats() {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}");
    let solved = 0, failed = 0;
    for (const v of Object.values(h)) {
      if (v.result === "solved") solved++;
      else if (v.result === "failed") failed++;
    }
    return { solved, failed, total: Object.keys(h).length };
  } catch { return { solved: 0, failed: 0, total: 0 }; }
}

function getStreak() {
  try { const d = JSON.parse(localStorage.getItem(STREAK_KEY) || "{}"); return { current: d.current || 0, best: d.best || 0 }; } catch { return { current: 0, best: 0 }; }
}

export default function Profile({ user, onNavigate, onLogout }) {
  const puzzleRating = useMemo(() => loadPuzzleRating(), []);
  const puzzleStats = useMemo(() => getPuzzleStats(), []);
  const streak = useMemo(() => getStreak(), []);

  return (
    <div className="max-w-3xl mx-auto px-5 sm:px-6 md:px-10 py-6 sm:py-10">
      {/* Header */}
      <div className="anim-fade-up flex items-center gap-4 sm:gap-5 mb-8 sm:mb-12" style={{ "--delay": "0.05s" }}>
        <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-surface-high flex items-center justify-center shrink-0">
          <span className="font-headline text-xl sm:text-2xl font-bold text-on-surface-variant/70 uppercase">
            {user.name?.[0] || "U"}
          </span>
        </div>
        <div>
          <h1 className="font-headline text-xl sm:text-2xl font-extrabold tracking-tighter text-primary">
            {user.name}
          </h1>
          <p className="text-[11px] sm:text-xs text-on-surface-variant/40">
            {user.guest ? "Guest account" : "Member"}
          </p>
        </div>
      </div>

      {/* Puzzle Rating */}
      <div className="anim-fade-up mb-8 sm:mb-10" style={{ "--delay": "0.1s" }}>
        <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">
          Puzzle Rating
        </h2>
        <div className="flex items-end gap-4">
          <span className="font-headline text-5xl font-extrabold text-primary">{puzzleRating.rating}</span>
          <span className="text-[11px] text-on-surface-variant/30 pb-2">{puzzleRating.games} puzzles rated</span>
        </div>
      </div>

      {/* Puzzle Stats */}
      <div className="anim-fade-up mb-8 sm:mb-10" style={{ "--delay": "0.16s" }}>
        <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">
          Puzzle Statistics
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: "Solved", value: puzzleStats.solved, color: "text-emerald-400" },
            { label: "Failed", value: puzzleStats.failed, color: "text-error" },
            { label: "Total", value: puzzleStats.total, color: "text-primary" },
            { label: "Best Streak", value: streak.best, color: "text-primary" },
          ].map((s) => (
            <div key={s.label} className="p-4 bg-surface-low border border-white/[0.04]">
              <span className={`font-headline text-2xl font-extrabold block ${s.color}`}>{s.value}</span>
              <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/35">{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Game Ratings — placeholder with honest label */}
      <div className="anim-fade-up mb-8 sm:mb-10" style={{ "--delay": "0.22s" }}>
        <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">
          Game Ratings
        </h2>
        <div className="p-5 bg-surface-low border border-white/[0.04] text-center">
          <span className="text-sm text-on-surface-variant/25">Play rated games to see your ratings here</span>
          <div className="flex gap-2 justify-center mt-3">
            <button onClick={() => onNavigate("play")} className="px-4 py-2 bg-primary text-on-primary font-headline text-xs font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.96]">
              Play Now
            </button>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="anim-fade-up flex flex-wrap gap-2" style={{ "--delay": "0.28s" }}>
        <button
          onClick={() => onNavigate("home")}
          className="px-6 py-2.5 bg-primary text-on-primary font-headline text-xs font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.96]"
        >
          Dashboard
        </button>
        <button
          onClick={onLogout}
          className="px-6 py-2.5 border border-white/[0.06] bg-surface-low font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-error hover:border-error/20 transition-colors active:scale-[0.96]"
        >
          {user.guest ? "Sign Out" : "Log Out"}
        </button>
      </div>
    </div>
  );
}
