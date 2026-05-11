import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Chess } from "chess.js";
import InteractiveBoard from "./InteractiveBoard";
import LoadingScreen from "./LoadingScreen";
import { loadPuzzles, getAdaptivePuzzle, findPuzzleById, searchPuzzleById, loadPuzzleRating, updatePuzzleRating } from "../lib/puzzles";
import { playMoveSound, playError, playVictory, playDefeat, preloadAll } from "../lib/sounds";
import { explainPuzzle } from "../lib/coach";
import SocialPanel from "./SocialPanel";
import { useAuth } from "./AuthProvider";

const TIMER_OPTIONS = [
  { label: "Off", sec: 0, bonus: null },
  { label: "15s", sec: 15, bonus: "+30%" },
  { label: "30s", sec: 30, bonus: "+20%" },
  { label: "60s", sec: 60, bonus: "+10%" },
  { label: "∞", sec: -1, bonus: null },
];



const HISTORY_KEY = "ochess_puzzle_history";
const STREAK_KEY = "ochess_puzzle_streak";
const SETTINGS_KEY = "ochess_puzzle_settings";

function savePuzzleResult(id, result, puzzleRating, userId) {
  try { const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}"); h[id] = { result, ts: Date.now() }; localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch {}
  // Sync to server
  if (userId) {
    import("../lib/puzzle-sync").then(({ savePuzzleAttempt }) => {
      savePuzzleAttempt(userId, id, puzzleRating || 0, result, 0);
    }).catch(() => {});
  }
}
function getPuzzleHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}"); } catch { return {}; }
}
function wasPuzzleAttempted(id) {
  return !!getPuzzleHistory()[id];
}
function getPuzzleResult(id) {
  const h = getPuzzleHistory();
  return h[id] || null;
}
function getPuzzleStats() {
  try { const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}"); let s = 0, f = 0; for (const v of Object.values(h)) { if (v.result === "solved") s++; else if (v.result === "failed") f++; } return { solved: s, failed: f, total: Object.keys(h).length }; } catch { return { solved: 0, failed: 0, total: 0 }; }
}
function loadStreak() {
  try { const d = JSON.parse(localStorage.getItem(STREAK_KEY) || "{}"); return { current: d.current || 0, best: d.best || 0 }; } catch { return { current: 0, best: 0 }; }
}
function saveStreak(current, best) {
  try { localStorage.setItem(STREAK_KEY, JSON.stringify({ current, best })); } catch {}
}
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); } catch { return null; }
}
function saveSettings(diffIdx, autoAdvance, timerSec, skipSetup) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ diffIdx, autoAdvance, timerSec, skipSetup })); } catch {}
}

function uciToMove(uci) { return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined }; }
function computeSolutionSAN(fen, moves) {
  const g = new Chess(fen); const result = [];
  for (const uci of moves) { try { const r = g.move(uciToMove(uci)); if (r) result.push(r.san); else break; } catch { break; } }
  return result;
}

export default function PuzzlesPage() {
  const { puzzleId: urlPuzzleId } = useParams();
  const navigate = useNavigate();
  const [puzzles, setPuzzles] = useState(null);
  const [phase, setPhase] = useState("loading");
  const [directPuzzle, setDirectPuzzle] = useState(null);
  const savedStreak = useMemo(() => loadStreak(), []);
  const savedSettings = useMemo(() => loadSettings(), []);
  const allTimeStats = useMemo(() => getPuzzleStats(), [phase]);
  const puzzleRating = useMemo(() => loadPuzzleRating(), [phase]);
  const [autoAdvance, setAutoAdvance] = useState(savedSettings?.autoAdvance ?? false);
  const [timerSec, setTimerSec] = useState(savedSettings?.timerSec ?? 0);
  const [loadError, setLoadError] = useState(null);
  const [retryKey, setRetryKey] = useState(0);

  // Discover puzzles + handle the initial route (direct-link vs setup
  // vs continue). Re-runs when `urlPuzzleId` changes so a user
  // sharing /puzzles/:id mid-session navigates to the new puzzle
  // instead of staying stuck on the previous one. `retryKey` lets the
  // error-state Retry button trigger the same effect again.
  useEffect(() => {
    preloadAll();
    let cancelled = false;
    setPhase("loading");
    setLoadError(null);
    loadPuzzles(3000)
      .then(async (p) => {
        if (cancelled) return;
        if (!p || p.length === 0) {
          setLoadError("Puzzles are unavailable right now. Try again later.");
          setPhase("error");
          return;
        }
        setPuzzles(p);

        if (urlPuzzleId) {
          let found = findPuzzleById(p, urlPuzzleId);
          if (!found) found = await searchPuzzleById(urlPuzzleId);
          if (cancelled) return;
          if (found) { setDirectPuzzle(found); setPhase("play-direct"); return; }
        }

        const s = loadSettings();
        if (s?.skipSetup) {
          setPhase(loadStreak().current > 0 ? "play-continue" : "play-fresh");
        } else {
          setPhase("setup");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[puzzles] loadPuzzles failed:", err);
        setLoadError("Couldn't load puzzles. Check your connection and try again.");
        setPhase("error");
      });
    return () => { cancelled = true; };
  }, [urlPuzzleId, retryKey]);

  const handleStart = useCallback((continueStreak, skipNext) => {
    saveSettings(0, autoAdvance, timerSec, !!skipNext);
    setPhase(continueStreak ? "play-continue" : "play-fresh");
  }, [autoAdvance, timerSec]);

  if (phase === "loading") return <LoadingScreen message="Loading puzzles..." />;

  if (phase === "error") {
    return (
      <div className="min-h-[calc(100dvh-8rem)] flex items-center justify-center px-6">
        <div className="anim-fade-up text-center max-w-sm">
          <h1 className="font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-3">Puzzles unavailable</h1>
          <p className="text-sm text-on-surface-variant/40 mb-6">{loadError}</p>
          <button onClick={() => { setLoadError(null); setRetryKey((k) => k + 1); }}
            className="btn btn-primary px-5 py-2 text-xs">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (phase === "setup") {
    return (
      <div className="max-w-xl mx-auto px-4 sm:px-6 md:px-10 py-10 sm:py-16">
        <div className="anim-fade-up" style={{ "--delay": "0.05s" }}>
          <h1 className="font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-1">Puzzles</h1>
          <div className="flex items-center gap-4 mb-10">
            <p className="text-sm text-on-surface-variant/40">Configure your session, then start solving.</p>
            <span className="font-headline text-sm font-bold text-on-surface-variant/30">Rating: <span className="text-primary">{puzzleRating.rating}</span></span>
          </div>
        </div>

        <div className="anim-fade-up space-y-6" style={{ "--delay": "0.12s" }}>
          {/* Timer */}
          <div>
            <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-2">Timer</h3>
            <p className="text-[10px] text-on-surface-variant/55 mb-3">Shorter timers give a bigger rating bonus when you solve fast.</p>
            <div className="flex gap-2">
              {TIMER_OPTIONS.map((t) => (
                <button key={t.label} onClick={() => setTimerSec(t.sec)}
                  className={`flex-1 py-3 flex flex-col items-center gap-0.5 font-headline font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${timerSec === t.sec ? "bg-primary text-on-primary" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary"}`}>
                  <span className="text-sm">{t.label}</span>
                  {t.bonus && <span className={`text-[9px] ${timerSec === t.sec ? "text-on-primary/60" : "text-emerald-400/50"}`}>{t.bonus} elo</span>}
                </button>
              ))}
            </div>
          </div>

          {/* Auto-advance */}
          <Toggle label="Auto-advance" sub="Automatically load next puzzle after solving" active={autoAdvance} onToggle={() => setAutoAdvance(!autoAdvance)} />

          {/* Streak info */}
          <div className="p-5 bg-surface-low border border-white/[0.04]">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30">Your streak</h3>
              <span className="font-headline text-2xl font-extrabold text-primary">{savedStreak.current}</span>
            </div>
            <div className="flex items-center justify-between text-[11px] text-on-surface-variant/30 mb-4">
              <span>Best: <span className="text-on-surface-variant/50 font-bold">{savedStreak.best}</span></span>
              <span>All time: <span className="text-on-surface-variant/50 font-bold">{allTimeStats.total}</span> puzzles · <span className="text-emerald-400/60 font-bold">{allTimeStats.solved}</span> solved</span>
            </div>
            <div className="flex gap-2">
              {savedStreak.current > 0 ? (
                <>
                  <button onClick={() => handleStart(true, false)} className="flex-1 py-3.5 bg-primary text-on-primary font-headline text-sm font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.97]">
                    Continue streak ({savedStreak.current})
                  </button>
                  <button onClick={() => handleStart(false, false)} className="py-3.5 px-5 bg-surface-high border border-white/[0.04] font-headline text-sm font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary transition-colors active:scale-[0.96]">
                    Start fresh
                  </button>
                </>
              ) : (
                <button onClick={() => handleStart(false, false)} className="flex-1 py-3.5 bg-primary text-on-primary font-headline text-sm font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.97]">
                  Start Puzzles
                </button>
              )}
            </div>
          </div>

          {/* Skip setup next time */}
          <button
            onClick={() => handleStart(savedStreak.current > 0, true)}
            className="w-full py-3 bg-surface-container border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/30 hover:text-on-surface-variant/50 hover:bg-surface-high transition-colors active:scale-[0.96]"
          >
            Use these settings and skip this screen next time
          </button>
          {savedSettings?.skipSetup && (
            <p className="text-[10px] text-on-surface-variant/20 text-center">
              You can always get back here by clicking "Options" during a session.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <PuzzleSession
      puzzles={puzzles}
      directPuzzle={directPuzzle}
      autoAdvance={autoAdvance}
      setAutoAdvance={setAutoAdvance}
      timerSec={timerSec}
      setTimerSec={setTimerSec}
      initialStreak={phase === "play-continue" || phase === "play-direct" ? savedStreak.current : 0}
      initialBest={savedStreak.best}
      onBack={() => { saveSettings(0, autoAdvance, timerSec, false); setPhase("setup"); }}
    />
  );
}

function PuzzleSession({ puzzles, directPuzzle, autoAdvance, setAutoAdvance, timerSec, setTimerSec, initialStreak, initialBest, onBack }) {
  const navigate = useNavigate();
  const { user: authUser } = useAuth();
  const [puzzle, setPuzzle] = useState(null);
  const [fen, setFen] = useState(null);
  const [playerColor, setPlayerColor] = useState("w");
  const [previousResult, setPreviousResult] = useState(null);
  const [boardFlipped, setBoardFlipped] = useState(false);
  const [moveIndex, setMoveIndex] = useState(0);
  const [status, setStatus] = useState("init");
  const [attempts, setAttempts] = useState(0);
  const [hintLevel, setHintLevel] = useState(0);
  const [sessionSolved, setSessionSolved] = useState(0);
  const [sessionFailed, setSessionFailed] = useState(0);
  const [sessionSkipped, setSessionSkipped] = useState(0);
  const [streak, setStreak] = useState(initialStreak);
  const [bestStreak, setBestStreak] = useState(initialBest);
  const [highlight, setHighlight] = useState({});
  const [solutionSAN, setSolutionSAN] = useState([]);
  const [animating, setAnimating] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [timeLeft, setTimeLeft] = useState(-1);
  const [pendingTimer, setPendingTimer] = useState(null);
  const [timerRunning, setTimerRunning] = useState(false);
  const [puzzleCount, setPuzzleCount] = useState(0);
  const [boardFlash, setBoardFlash] = useState("");
  const [myRating, setMyRating] = useState(() => loadPuzzleRating());
  const [ratingDelta, setRatingDelta] = useState(null);
  const [playedMoves, setPlayedMoves] = useState([]);
  const [directConsumed, setDirectConsumed] = useState(false);
  const gameRef = useRef(null);
  const timerRef = useRef(null);
  const timerSecRef = useRef(timerSec);
  timerSecRef.current = timerSec;

  useEffect(() => { saveStreak(streak, bestStreak); }, [streak, bestStreak]);

  useEffect(() => {
    if (timerRunning && status === "playing") {
      timerRef.current = setInterval(() => {
        setTimeLeft((t) => {
          if (timerSecRef.current === -1) return t + 100;
          if (t <= 100) {
            clearInterval(timerRef.current);
            setTimerRunning(false);
            return 0;
          }
          return t - 100;
        });
      }, 100);
      return () => clearInterval(timerRef.current);
    }
  }, [timerRunning, status]);

  const startPuzzle = useCallback((pzl) => {
    if (!pzl?.fen || !pzl?.moves || pzl.moves.length < 2) return;
    try { new Chess(pzl.fen); } catch { return; }
    clearInterval(timerRef.current);
    setTimerRunning(false);
    const effectiveTimer = pendingTimer !== null ? pendingTimer : timerSecRef.current;
    if (pendingTimer !== null) { setTimerSec(pendingTimer); setPendingTimer(null); }
    setSolutionSAN(computeSolutionSAN(pzl.fen, pzl.moves));
    setAttempts(0); setHintLevel(0); setHighlight({}); setAnimating(true); setRatingDelta(null); setBoardFlash(""); setPlayedMoves([]); setCopied(false); setSaved(false); setPosEval(null); setPreviousResult(getPuzzleResult(pzl.id));
    const g = new Chess(pzl.fen);
    gameRef.current = g; setPuzzle(pzl); setFen(g.fen()); setStatus("setup"); setTimeLeft(-1); setPuzzleCount((c) => c + 1);
    navigate(`/puzzles/${pzl.id}`, { replace: true });
    const sm = uciToMove(pzl.moves[0]);
    const san = computeSolutionSAN(pzl.fen, pzl.moves);
    setTimeout(() => {
      try { const r = g.move(sm); if (r) playMoveSound(r); } catch {}
      setPlayedMoves([{ san: san[0] || sm.from + sm.to, color: g.turn() === "w" ? "b" : "w", setup: true }]);
      setFen(g.fen()); setPlayerColor(g.turn()); setMoveIndex(1); setStatus("playing");
      setHighlight({ [sm.from]: { backgroundColor: "rgba(255,255,255,0.06)" }, [sm.to]: { backgroundColor: "rgba(255,255,255,0.1)" } });
      setAnimating(false);
      if (effectiveTimer > 0) { setTimeLeft(effectiveTimer * 1000); setTimerRunning(true); }
      else if (effectiveTimer === -1) { setTimeLeft(0); setTimerRunning(true); }
    }, 600);
  }, [pendingTimer]);

  const pickAndStart = useCallback(() => {
    const currentRating = loadPuzzleRating().rating;
    const p = getAdaptivePuzzle(puzzles, currentRating);
    if (p) startPuzzle(p);
  }, [puzzles, startPuzzle]);

  useEffect(() => {
    if (puzzles && !puzzle) {
      if (directPuzzle && !directConsumed) { setDirectConsumed(true); startPuzzle(directPuzzle); }
      else pickAndStart();
    }
  }, [puzzles, puzzle, pickAndStart, directPuzzle, directConsumed]);

  const doReveal = useCallback(() => {
    if (!puzzle || !gameRef.current) return;
    clearInterval(timerRef.current); setTimerRunning(false);
    const g = gameRef.current; const uci = puzzle.moves[moveIndex]; if (!uci) return;
    const m = uciToMove(uci);
    try {
      const r = g.move(m);
      if (r) { playMoveSound(r); setPlayedMoves((prev) => [...prev, { san: r.san, color: g.turn() === "w" ? "b" : "w", revealed: true }]); }
    } catch {}
    setFen(g.fen());
    setHighlight({ [m.from]: { backgroundColor: "rgba(239,68,68,0.25)" }, [m.to]: { backgroundColor: "rgba(239,68,68,0.35)" } });
    // Failure plays the defeat cue - the chess-draw sound (used
    // previously) implied a neutral result, but the user just lost
    // this puzzle, so the louder "you lost" sound is more accurate.
    setStatus("failed"); setSessionFailed((f) => f + 1); setStreak(0); playDefeat();
    const isRetry = wasPuzzleAttempted(puzzle.id);
    savePuzzleResult(puzzle.id, "failed", puzzle.rating, authUser?.id);
    if (!isRetry) {
      const updated = updatePuzzleRating(puzzle.rating, false, { timerSec: timerSecRef.current });
      setRatingDelta(updated.rating - myRating.rating); setMyRating(updated);
    } else {
      setRatingDelta(null);
    }
    setBoardFlash("board-flash-incorrect"); setTimeout(() => setBoardFlash(""), 600);
  }, [puzzle, moveIndex]);

  useEffect(() => {
    if (timeLeft === 0 && status === "playing" && timerSecRef.current > 0) {
      doReveal();
    }
  }, [timeLeft, status, doReveal]);

  const handleMove = useCallback((move) => {
    if (status !== "playing" || !puzzle || !gameRef.current || animating) return false;
    const g = gameRef.current; if (g.turn() !== playerColor) return false;
    const eu = puzzle.moves[moveIndex]; if (!eu) return false;
    const exp = uciToMove(eu);

    if (move.from === exp.from && move.to === exp.to) {
      const result = g.move({ from: move.from, to: move.to, promotion: exp.promotion || move.promotion });
      if (!result) return false;
      setFen(g.fen()); setAttempts(0); setHintLevel(0);
      setPlayedMoves((prev) => [...prev, { san: result.san, color: playerColor }]);
      setHighlight({ [move.from]: { backgroundColor: "rgba(76,175,80,0.25)" }, [move.to]: { backgroundColor: "rgba(76,175,80,0.35)" } });
      const ni = moveIndex + 1;
      if (ni >= puzzle.moves.length) {
        clearInterval(timerRef.current); setTimerRunning(false); setMoveIndex(ni); setStatus("solved"); setSessionSolved((s) => s + 1);
        setStreak((s) => { const n = s + 1; setBestStreak((b) => Math.max(b, n)); return n; });
        const isRetry = wasPuzzleAttempted(puzzle.id);
        savePuzzleResult(puzzle.id, "solved", puzzle.rating, authUser?.id); playVictory();
        if (authUser?.id && directPuzzle && directPuzzle.id === puzzle.id) {
          import("../lib/puzzle-sync").then(({ markDailyPuzzleSolved }) => {
            markDailyPuzzleSolved(authUser.id, new Date().toISOString().slice(0, 10));
          }).catch(() => {});
        }
        if (!isRetry) {
          const tlPct = timerSecRef.current > 0 && timeLeft > 0 ? timeLeft / (timerSecRef.current * 1000) : 0;
          const updated = updatePuzzleRating(puzzle.rating, true, { timerSec: timerSecRef.current, timeLeftPct: tlPct, usedHints: hintLevel > 0 });
          setRatingDelta(updated.rating - myRating.rating); setMyRating(updated);
        } else {
          setRatingDelta(null);
        }
        setBoardFlash("board-flash-correct"); setTimeout(() => setBoardFlash(""), 600);
        return true;
      }
      setAnimating(true);
      const resp = uciToMove(puzzle.moves[ni]);
      setTimeout(() => {
        try {
          const rr = g.move(resp);
          if (rr) { playMoveSound(rr); setPlayedMoves((prev) => [...prev, { san: rr.san, color: playerColor === "w" ? "b" : "w" }]); }
        } catch {}
        setFen(g.fen()); setMoveIndex(ni + 1);
        setHighlight({ [resp.from]: { backgroundColor: "rgba(255,255,255,0.06)" }, [resp.to]: { backgroundColor: "rgba(255,255,255,0.1)" } });
        setAnimating(false);
      }, 450);
      return true;
    } else {
      playError(); const na = attempts + 1; setAttempts(na);
      if (na >= 2) { setTimeout(() => doReveal(), 500); }
      else { setHighlight({ [move.from]: { backgroundColor: "rgba(239,68,68,0.2)" }, [move.to]: { backgroundColor: "rgba(239,68,68,0.25)" } }); setTimeout(() => setHighlight({}), 900); }
      return false;
    }
  }, [status, puzzle, moveIndex, playerColor, attempts, animating, doReveal]);

  const handleHint = useCallback(() => {
    if (!puzzle || status !== "playing") return;
    const uci = puzzle.moves[moveIndex]; if (!uci) return;
    const m = uciToMove(uci); const next = hintLevel + 1; setHintLevel(next);
    if (next === 1) setHighlight({ [m.from]: { backgroundColor: "rgba(59,130,246,0.3)" } });
    else setHighlight({ [m.from]: { backgroundColor: "rgba(59,130,246,0.3)" }, [m.to]: { backgroundColor: "rgba(59,130,246,0.25)" } });
  }, [puzzle, moveIndex, hintLevel, status]);

  const nextPuzzle = useCallback(() => {
    clearInterval(timerRef.current); setTimerRunning(false); setPuzzle(null); setFen(null);
    setTimeout(() => pickAndStart(), 60);
  }, [pickAndStart]);
  const skipPuzzle = useCallback(() => { setSessionSkipped((s) => s + 1); nextPuzzle(); }, [nextPuzzle]);
  const retryPuzzle = useCallback(() => { if (puzzle) startPuzzle(puzzle); }, [puzzle, startPuzzle]);

  const [coachText, setCoachText] = useState("");
  const [posEval, setPosEval] = useState(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const solutionPairs = useMemo(() => { const p = []; const m = solutionSAN.slice(1); for (let i = 0; i < m.length; i += 2) p.push({ player: m[i], opponent: m[i + 1] || null }); return p; }, [solutionSAN]);
  const totalPlayerMoves = puzzle ? Math.ceil((puzzle.moves.length - 1) / 2) : 0;
  const isDone = status === "solved" || status === "failed";
  const showLoader = !fen || status === "setup" || status === "init";
  const ready = fen && puzzle && (status === "playing" || isDone);
  const hasTimer = timerSec !== 0;
  const isInfinite = timerSec === -1;
  const timerDisplay = hasTimer && status === "playing" ? Math.ceil(timeLeft / 1000) : null;
  const timerPct = timerSec > 0 ? (timeLeft / (timerSec * 1000)) * 100 : 0;
  const currentPlayerMove = Math.max(0, Math.floor((moveIndex - 1) / 2));
  const progressPct = totalPlayerMoves > 0 ? Math.min(100, (currentPlayerMove / totalPlayerMoves) * 100) : 0;

  useEffect(() => {
    if (isDone && puzzle && solutionSAN.length > 0) {
      explainPuzzle(puzzle.fen, solutionSAN, puzzle.themes).then((result) => {
        if (typeof result === "string") { setCoachText(result); setPosEval(null); }
        else { setCoachText(result.text); setPosEval(result); }
      });
    } else {
      setCoachText(""); setPosEval(null);
    }
  }, [isDone, puzzle, solutionSAN]);

  useEffect(() => {
    if (!ready) return;
    const handler = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (isDone && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); nextPuzzle(); }
      else if (isDone && e.key === "r") retryPuzzle();
      else if (status === "playing" && e.key === "h") handleHint();
      else if (status === "playing" && e.key === "s") skipPuzzle();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [ready, isDone, status, nextPuzzle, retryPuzzle, handleHint, skipPuzzle]);

  const autoAdvRef = useRef(autoAdvance);
  autoAdvRef.current = autoAdvance;
  useEffect(() => {
    if (!isDone) return;
    if (!autoAdvRef.current) return;
    const t = setTimeout(() => {
      if (autoAdvRef.current) nextPuzzle();
    }, status === "solved" ? 1200 : 2500);
    return () => clearTimeout(t);
  }, [isDone, status, nextPuzzle]);

  return (
    <>
    {showLoader && <LoadingScreen message="Setting up..." />}
    {!ready ? <div className="min-h-[60vh]" /> :
    <div className="flex min-h-[calc(100dvh-4rem)]">
      {/* Main content area */}
      <div className="flex-1 min-w-0 px-4 sm:px-6 md:px-10 xl:px-6 py-5 sm:py-8 w-full mx-auto max-w-[1400px] xl:max-w-[1500px] 2xl:max-w-[1600px]">
        <div className="flex flex-col xl:flex-row gap-5">

        {/* ══ Left: Board - scales with viewport breakpoint. ══ */}
        <div className="flex-1 flex flex-col items-center xl:items-start max-w-[760px] xl:max-w-[920px] 2xl:max-w-[1040px]">
          {/* Header */}
          <div className="w-full flex items-center justify-between mb-2">
            <div>
              <h1 className={`font-headline text-xl sm:text-2xl font-extrabold tracking-tighter ${status === "solved" ? "text-emerald-400" : status === "failed" ? "text-error" : "text-primary"}`}>
                {status === "solved" ? "Correct!" : status === "failed" ? "Incorrect" : "Find the best move"}
              </h1>
              {previousResult && status === "playing" && (
                <span className={`text-[10px] font-bold uppercase tracking-wide ${previousResult.result === "solved" ? "text-emerald-400/50" : "text-error/50"}`}>
                  Previously {previousResult.result} · Rating won't change
                </span>
              )}
              <p className="text-[11px] text-on-surface-variant/40">
                {playerColor === "w" ? "White" : "Black"} to move · Puzzle {puzzle.rating}
                {isDone && ratingDelta !== null && (
                  <span> · You: <span className="text-primary font-bold">{myRating.rating}</span> <span className={ratingDelta >= 0 ? "text-emerald-400" : "text-error"}>({ratingDelta >= 0 ? "+" : ""}{ratingDelta})</span></span>
                )}
                {totalPlayerMoves > 1 && status === "playing" && ` · Move ${Math.min(Math.floor((moveIndex - 1) / 2) + 1, totalPlayerMoves)}/${totalPlayerMoves}`}
                {attempts > 0 && status === "playing" && ` · Attempt ${attempts}/2`}
              </p>
            </div>
            <div className="text-right shrink-0 ml-3">
              <span className="text-[10px] text-on-surface-variant/20 font-mono block">#{puzzle.id}</span>
              <span className="text-[9px] text-on-surface-variant/15">Puzzle {puzzleCount}</span>
            </div>
          </div>

          {/* Timer bar above board - finite timers only */}
          {timerSec > 0 && !isInfinite && (status === "playing" || isDone) && (
            <div className="w-full h-[3px] bg-surface-low overflow-hidden mb-0.5">
              <div className={`h-full transition-all duration-100 ${timerPct < 20 ? "bg-error" : timerPct < 50 ? "bg-yellow-500" : "bg-primary"}`} style={{ width: `${timerPct}%` }} />
            </div>
          )}
          {/* Move progress for multi-move puzzles */}
          {status === "playing" && totalPlayerMoves > 1 && (
            <div className="w-full h-[2px] bg-surface-low overflow-hidden mb-0.5">
              <div className="h-full bg-primary/50 transition-all duration-500" style={{ width: `${progressPct}%` }} />
            </div>
          )}

          {/* Board + rating bar - viewport-clamped so the board
              doesn't overflow on short widescreens. */}
          <div
            className="w-full flex gap-2 mx-auto"
            style={{ maxWidth: "min(100%, calc(100dvh - 11rem))" }}
          >
            {/* Rating bar (left of board, shows after puzzle) */}
            {isDone && posEval && (
              <div className="hidden sm:flex flex-col items-center justify-between w-10 shrink-0 mt-3">
                <span className="font-headline text-[10px] font-bold text-on-surface-variant/50 mb-1.5">{posEval.evalBefore || "?"}</span>
                <div className="w-[6px] flex-1 bg-on-surface-variant/10 overflow-hidden rounded-full relative">
                  <div className="absolute bottom-0 w-full bg-white rounded-full transition-all duration-700" style={{ height: `${posEval.barPct}%` }} />
                </div>
                <span className="text-[7px] uppercase tracking-widest text-on-surface-variant/20 mt-1.5">Eval</span>
              </div>
            )}
            <div className={`flex-1 ${boardFlash}`}>
              <InteractiveBoard fen={fen} onMove={handleMove} orientation={boardFlipped ? (playerColor === "w" ? "black" : "white") : (playerColor === "w" ? "white" : "black")} interactive={status === "playing" && !animating} highlightSquares={highlight} playerColor={playerColor} />
            </div>
          </div>

          {/* Controls below board */}
          <div className="w-full mt-3 space-y-2">
            {status === "playing" && (
              <div className="flex gap-2">
                <button onClick={handleHint} disabled={hintLevel >= 2}
                  className={`flex-1 py-3 font-headline text-sm font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${hintLevel >= 2 ? "bg-emerald-900/20 border border-emerald-800/20 text-emerald-600/30" : "bg-emerald-900/30 border border-emerald-700/25 text-emerald-400 hover:bg-emerald-900/50 hover:text-emerald-300"}`}>
                  {hintLevel === 0 ? "Hint" : hintLevel === 1 ? "Show destination" : "Hinted"}
                </button>
                <button onClick={skipPuzzle} className="flex-1 py-3 bg-surface-high/60 border border-white/[0.06] font-headline text-sm font-bold uppercase tracking-wide text-on-surface-variant/60 hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.96]">Skip</button>
                <button onClick={doReveal} className="flex-1 py-3 bg-red-950/40 border border-red-800/25 font-headline text-sm font-bold uppercase tracking-wide text-red-400/80 hover:bg-red-950/60 hover:text-red-300 transition-colors active:scale-[0.96]">Give up</button>
                <button onClick={() => setBoardFlipped((f) => !f)} className="py-3 px-4 bg-surface-high/60 border border-white/[0.06] font-headline text-sm font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-primary transition-colors active:scale-[0.96]" title="Flip board">Flip</button>
              </div>
            )}
            {isDone && (
              <>
                {/* Time + bonus */}
                <div className="flex items-center justify-between px-1">
                  <div />
                  {hasTimer && (
                    <span className="text-[11px] text-on-surface-variant/30 tabular-nums font-mono">
                      {isInfinite
                        ? `${Math.floor(timeLeft / 1000)}s`
                        : timerSec > 0
                          ? `${Math.ceil((timerSec * 1000 - timeLeft) / 1000)}s / ${timerSec}s`
                          : ""}
                      {timerSec > 0 && status === "solved" && (
                        <span className="text-emerald-400/60 ml-1.5">
                          ({timerSec <= 15 ? "30%" : timerSec <= 30 ? "20%" : timerSec <= 60 ? "10%" : "5%"} bonus)
                        </span>
                      )}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button onClick={nextPuzzle} className="flex-1 py-3.5 bg-primary text-on-primary font-headline text-sm font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.97]">Next Puzzle</button>
                  <button onClick={retryPuzzle} className="py-3.5 px-4 bg-surface-low border border-white/[0.04] font-headline text-sm font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.96]">Retry</button>
                  <button
                    onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/puzzles/${puzzle.id}`); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                    className={`py-3.5 px-4 font-headline text-sm font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${copied ? "bg-emerald-500/20 border border-emerald-500/20 text-emerald-400" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary hover:bg-surface-high"}`}
                    title="Copy puzzle link"
                  >
                    {copied ? "Copied!" : "Share"}
                  </button>
                </div>
                {status === "failed" && (
                  <button
                    onClick={() => {
                      try {
                        const cards = JSON.parse(localStorage.getItem("ochess_review_cards") || "[]");
                        // Save EVERYTHING the review flow needs to
                        // replay this puzzle as a real chess line:
                        //   - fen: position the player failed on.
                        //   - answerMove: the immediate next correct
                        //       move (back-compat with single-move
                        //       review for older clients).
                        //   - lineMoves: the full remaining UCI
                        //       sequence from this position. Even
                        //       indices are the player's moves, odd
                        //       indices are the opponent's auto-
                        //       responses. Review plays this out
                        //       move by move.
                        const remainingUci = (puzzle.moves || []).slice(moveIndex);
                        const nextUci = remainingUci[0];
                        const answerMove = nextUci && nextUci.length >= 4
                          ? { from: nextUci.slice(0, 2), to: nextUci.slice(2, 4), promotion: nextUci.length > 4 ? nextUci[4] : undefined }
                          : null;
                        // Stable id keyed on puzzleId + position so
                        // re-clicking "Save to Anki" on the same
                        // failure doesn't create duplicates and
                        // double the review burden. The previous
                        // version used Date.now() in the id which
                        // produced a fresh card every click.
                        const stableId = `puzzle:${puzzle.id}:${fen}`;
                        if (!cards.some((c) => c.id === stableId)) {
                          cards.push({
                            id: stableId,
                            puzzleId: puzzle.id,
                            fen,
                            type: "puzzle",
                            rating: puzzle.rating,
                            themes: puzzle.themes,
                            answerMove: answerMove || undefined,
                            lineMoves: remainingUci.length > 0 ? remainingUci : undefined,
                            ts: Date.now(),
                          });
                          localStorage.setItem("ochess_review_cards", JSON.stringify(cards));
                        }
                        setSaved(true); setTimeout(() => setSaved(false), 1500);
                      } catch {}
                    }}
                    className={`w-full py-2.5 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${saved ? "bg-emerald-500/20 border border-emerald-500/20 text-emerald-400" : "bg-surface-low border border-primary/15 text-primary/70 hover:text-primary hover:border-primary/25 hover:bg-surface-high"}`}
                  >
                    {saved ? "Saved to Anki!" : "Save to Anki"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* ══ Middle: Info ══ */}
        <div className="w-full xl:w-[280px] shrink-0 flex flex-col gap-5">
          {/* Session */}
          <div>
            <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Session</h3>
            <div className="grid grid-cols-2 gap-1.5">
              {[{ l: "Solved", v: sessionSolved, c: "text-emerald-400" }, { l: "Failed", v: sessionFailed, c: "text-error" }].map((s) => (
                <div key={s.l} className="p-2.5 bg-surface-low border border-white/[0.03] text-center">
                  <span className={`font-headline text-xl font-extrabold block ${s.c}`}>{s.v}</span>
                  <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25">{s.l}</span>
                </div>
              ))}
            </div>
            <span className="text-[10px] text-on-surface-variant/20 mt-1.5 block px-0.5">Rating: <span className="text-primary font-bold">{myRating.rating}</span></span>
          </div>

          {/* Move list */}
          {playedMoves.length > 0 && (
            <div>
              <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-2">Moves</h3>
              <div className="bg-surface-low p-2.5 flex flex-wrap gap-x-1.5 gap-y-1 items-baseline">
                {playedMoves.map((m, i) => {
                  const isWhite = m.color === "w";
                  const moveNum = isWhite ? Math.floor(i / 2) + 1 : null;
                  const isRecent = i >= playedMoves.length - 3;
                  const isLast = i === playedMoves.length - 1;
                  return (
                    <span key={i} className="inline-flex items-baseline gap-0.5">
                      {isWhite && <span className="text-[10px] text-on-surface-variant/20">{moveNum}.</span>}
                      {m.setup && <span className="text-[9px] text-on-surface-variant/20 mr-0.5">▸</span>}
                      <span className={`font-mono text-[13px] ${
                        m.setup ? "text-on-surface-variant/30 italic"
                        : m.revealed ? "text-error/70"
                        : isLast ? "text-primary font-bold"
                        : isRecent ? "text-on-surface-variant/80"
                        : "text-on-surface-variant/40"
                      }`}>
                        {m.san}
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Settings */}
          <div className="space-y-2">
            <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30">Settings</h3>
            <Toggle label="Auto-advance" active={autoAdvance} onToggle={() => setAutoAdvance(!autoAdvance)} />
            <Toggle label="Timer" active={(pendingTimer !== null ? pendingTimer : timerSec) !== 0} onToggle={() => {
              const target = (pendingTimer !== null ? pendingTimer : timerSec) !== 0 ? 0 : 30;
              if (status === "playing") setPendingTimer(target); else setTimerSec(target);
            }} />
            {((pendingTimer !== null ? pendingTimer : timerSec) !== 0) && (
              <div className="flex gap-1 pl-1">
                {[15, 30, 60, -1].map((s) => {
                  const effective = pendingTimer !== null ? pendingTimer : timerSec;
                  const isActive = effective === s;
                  return (
                    <button key={s} onClick={() => { if (status === "playing") setPendingTimer(s); else setTimerSec(s); }}
                      className={`flex-1 py-1.5 text-[10px] font-headline font-bold transition-colors active:scale-[0.96] ${isActive ? "bg-primary text-on-primary" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/40 hover:text-primary"}`}>{s === -1 ? "∞" : `${s}s`}</button>
                  );
                })}
              </div>
            )}
            {pendingTimer !== null && (
              <span className="text-[10px] text-primary/50 px-1">
                Timer changes to {pendingTimer === 0 ? "off" : `${pendingTimer}s`} next puzzle
              </span>
            )}
          </div>

          {/* Tags */}
          {puzzle.themes.length > 0 && (
            <div>
              <button onClick={() => setTagsOpen(!tagsOpen)} className="flex items-center justify-between w-full">
                <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30">Tags</h3>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`text-on-surface-variant/20 transition-transform duration-200 ${tagsOpen ? "rotate-180" : ""}`}><path d="M6 9l6 6 6-6" /></svg>
              </button>
              {tagsOpen && <div className="flex flex-wrap gap-1.5 mt-2">{puzzle.themes.map((t) => <span key={t} className="px-2.5 py-1 text-[11px] bg-surface-low border border-white/[0.04] text-on-surface-variant/50">{t}</span>)}</div>}
            </div>
          )}

          {/* Streak */}
          <div>
            <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-2">Streak</h3>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="p-2.5 bg-surface-low border border-white/[0.03] text-center">
                <span className="font-headline text-xl font-extrabold text-primary block">{streak}</span>
                <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25">Current</span>
              </div>
              <div className="p-2.5 bg-surface-low border border-white/[0.03] text-center">
                <span className="font-headline text-xl font-extrabold text-on-surface-variant/40 block">{bestStreak}</span>
                <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25">Best</span>
              </div>
            </div>
          </div>

          {/* Solution + Coach */}
          {isDone && solutionPairs.length > 0 && (
            <div>
              <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-2">Solution</h3>
              <div className="bg-surface-low p-3 flex flex-wrap gap-x-2 gap-y-1.5">
                {solutionPairs.map((pair, i) => (
                  <span key={i} className="inline-flex items-baseline gap-1 text-[13px]">
                    <span className="text-[10px] text-on-surface-variant/20">{i + 1}.</span>
                    <span className="font-mono text-primary font-bold">{pair.player}</span>
                    {pair.opponent && <span className="font-mono text-on-surface-variant/40">{pair.opponent}</span>}
                  </span>
                ))}
              </div>
            </div>
          )}
          {isDone && (
            <div className="bg-surface-container p-4 border border-white/[0.04] relative overflow-hidden">
              <div className="absolute top-0 right-0 w-20 h-20 bg-primary/5 rounded-full -mr-10 -mt-10 blur-2xl" />
              <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-primary/70 mb-2">Coach</h3>
              <p className="text-[12px] text-on-surface-variant/50 leading-relaxed relative z-10">{coachText}</p>
            </div>
          )}

          {/* Meta */}
          <div className="text-[10px] text-on-surface-variant/15 space-y-0.5 px-1 mt-auto">
            <div>#{puzzle.id} · {puzzle.rating} · Pop {puzzle.popularity}</div>
            <div>{totalPlayerMoves} moves to find</div>
            {puzzle.gameUrl && <a href={puzzle.gameUrl} target="_blank" rel="noopener noreferrer" className="text-on-surface-variant/20 hover:text-primary/50 transition-colors underline">Source game</a>}
          </div>
        </div>

      </div>
    </div>

      <SocialPanel />
    </div>
    }
    </>
  );
}

function Toggle({ label, sub, active, onToggle }) {
  return (
    <button onClick={onToggle} className="w-full flex items-center justify-between py-2.5 px-3 bg-surface-low border border-white/[0.04] hover:bg-surface-high transition-colors active:scale-[0.98] text-left">
      <div className="flex-1 min-w-0">
        <span className="font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/50 block text-left">{label}</span>
        {sub && <span className="text-[9px] text-on-surface-variant/20 block text-left">{sub}</span>}
      </div>
      <div className={`w-9 h-[20px] rounded-full transition-colors relative shrink-0 ml-4 ${active ? "bg-emerald-500/40" : "bg-surface-high"}`}>
        <div className={`absolute top-[3px] w-[14px] h-[14px] rounded-full transition-all ${active ? "left-[18px] bg-emerald-400" : "left-[3px] bg-on-surface-variant/30"}`} />
      </div>
    </button>
  );
}
