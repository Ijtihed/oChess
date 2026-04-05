import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Chess } from "chess.js";
import InteractiveBoard from "./InteractiveBoard";
import useClock, { formatTime } from "../hooks/useClock";
import { getBotMove, getThinkDelay } from "../lib/bot-engine";
import { playMoveSound, playGameStart, playVictory, playDefeat, playDraw, playLowTime, preloadAll } from "../lib/sounds";
import { explainMove, evaluatePosition } from "../lib/coach";
import { unlockEval, lockEval } from "../lib/engine";
import { getBotChatMessage } from "../lib/bot-chat";
import { getOpeningName, resetOpeningCache } from "../lib/openings";
import SocialPanel from "./SocialPanel";

const SAVE_KEY = "ochess_active_game";

export function getSavedGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data.pgn || !data.opponent) return null;
    return data;
  } catch { return null; }
}

export function clearSavedGame() {
  localStorage.removeItem(SAVE_KEY);
}

function saveGame(gameRef, opponent, playerColor, botChat, clockState, timeControl) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      pgn: gameRef.current.pgn(),
      opponent,
      playerColor,
      botChat: botChat.slice(-10),
      clockState: clockState || null,
      timeControl: timeControl || null,
      savedAt: Date.now(),
    }));
  } catch {}
}

const STARTING = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const PIECE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const PIECE_ORDER = ["q", "r", "b", "n", "p"];

function getCaptured(fen) {
  const board = fen.split(" ")[0];
  const w = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  const b = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  for (const ch of board) {
    if (ch >= "A" && ch <= "Z") { const k = ch.toLowerCase(); if (k in w) w[k]++; }
    else if (ch >= "a" && ch <= "z") { if (ch in b) b[ch]++; }
  }
  const capturedByWhite = [];
  const capturedByBlack = [];
  let whiteMat = 0;
  let blackMat = 0;
  for (const p of PIECE_ORDER) {
    whiteMat += w[p] * PIECE_VAL[p];
    blackMat += b[p] * PIECE_VAL[p];
    const missingB = Math.max(0, STARTING[p] - b[p]);
    const missingW = Math.max(0, STARTING[p] - w[p]);
    for (let i = 0; i < missingB; i++) capturedByWhite.push(p);
    for (let i = 0; i < missingW; i++) capturedByBlack.push(p);
  }
  const advantage = whiteMat - blackMat;
  return { capturedByWhite, capturedByBlack, advantage };
}

export default function GameScreen({ opponent, playerColor = "w", timeControl, resumeData }) {
  const navigate = useNavigate();


  const gameRef = useRef(() => {
    const g = new Chess();
    if (resumeData?.pgn) {
      try { g.loadPgn(resumeData.pgn); } catch {}
    }
    return g;
  });
  if (typeof gameRef.current === "function") gameRef.current = gameRef.current();

  const [fen, setFen] = useState(gameRef.current.fen());
  const [history, setHistory] = useState([...gameRef.current.history({ verbose: true })]);
  const [gameOver, setGameOver] = useState(null);
  const [botThinking, setBotThinking] = useState(false);
  const [lastMove, setLastMove] = useState(() => {
    const h = gameRef.current.history({ verbose: true });
    const last = h.length > 0 ? h[h.length - 1] : null;
    return last ? { from: last.from, to: last.to } : null;
  });
  const [confirmResign, setConfirmResign] = useState(false);
  const [confirmDraw, setConfirmDraw] = useState(false);
  const [botChat, setBotChat] = useState(resumeData?.botChat || []);
  const [selectedPly, setSelectedPly] = useState(null);
  const [plyCoach, setPlyCoach] = useState(null);
  const [plyLoading, setPlyLoading] = useState(false);
  const [previewPly, setPreviewPly] = useState(null);
  const [openingName, setOpeningName] = useState(null);
  const [premove, setPremove] = useState(null);
  const [evals, setEvals] = useState({});
  const [evalRunning, setEvalRunning] = useState(false);
  const [evalDepth, setEvalDepth] = useState(14);
  const [evalProgress, setEvalProgress] = useState(0);
  const [pgnCopied, setPgnCopied] = useState(false);
  const [fatalError, setFatalError] = useState(null);
  const premoveRef = useRef(null);
  const gameOverRef = useRef(null);
  const moveListRef = useRef(null);
  const chatRef = useRef(null);
  const botChatRef = useRef(botChat);

  const hasTime = timeControl && timeControl.initial > 0;
  const clock = useClock(hasTime ? timeControl.initial : 0, hasTime ? timeControl.increment : 0);

  const lowTimeFired = useRef(false);

  const endGame = useCallback((result, reason, won) => {
    clock.stop();
    setGameOver({ result, reason, won });
    setPremove(null);
    premoveRef.current = null;
    setBotThinking(false);
    gameOverRef.current = { result, reason, won };
    clearSavedGame();
    unlockEval();
    if (won) playVictory();
    else if (result === "1/2-1/2") playDraw();
    else playDefeat();
  }, [clock]);

  const checkGameEnd = useCallback(() => {
    const g = gameRef.current;
    if (!g.isGameOver()) return false;
    let result, reason;
    if (g.isCheckmate()) { result = g.turn() === "w" ? "0-1" : "1-0"; reason = "checkmate"; }
    else if (g.isStalemate()) { result = "1/2-1/2"; reason = "stalemate"; }
    else if (g.isThreefoldRepetition()) { result = "1/2-1/2"; reason = "repetition"; }
    else if (g.isInsufficientMaterial()) { result = "1/2-1/2"; reason = "insufficient"; }
    else if (g.isDraw()) { result = "1/2-1/2"; reason = "50-move rule"; }
    else { result = "1/2-1/2"; reason = "draw"; }
    const won = (result === "1-0" && playerColor === "w") || (result === "0-1" && playerColor === "b");
    endGame(result, reason, result === "1/2-1/2" ? null : won);
    return true;
  }, [playerColor, endGame]);

  useEffect(() => { preloadAll(); resetOpeningCache(); lockEval(); return () => unlockEval(); }, []);

  useEffect(() => {
    if (!hasTime || gameOver) return;
    const playerMs = playerColor === "w" ? clock.display.white : clock.display.black;
    if (playerMs > 0 && playerMs <= 30000 && !lowTimeFired.current) {
      lowTimeFired.current = true;
      playLowTime();
    }
    if (playerMs > 30000) lowTimeFired.current = false;
  }, [clock.display, hasTime, gameOver, playerColor]);

  useEffect(() => {
    if (clock.timedOut && !gameOver) {
      const loser = clock.timedOut;
      const result = loser === "w" ? "0-1" : "1-0";
      const won = (loser === "w") !== (playerColor === "w");
      endGame(result, "timeout", won);
    }
  }, [clock.timedOut, gameOver, playerColor, endGame]);

  const syncState = useCallback(() => {
    setFen(gameRef.current.fen());
    setHistory([...gameRef.current.history({ verbose: true })]);
    const cs = hasTime ? { white: clock.display.white, black: clock.display.black } : null;
    saveGame(gameRef, opponent, playerColor, botChatRef.current, cs, timeControl);
  }, [opponent, playerColor, hasTime, clock, timeControl]);

  const doBotMoveRef = useRef(null);

  const executePremove = useCallback(() => {
    const pm = premoveRef.current;
    if (!pm) return;
    setPremove(null);
    premoveRef.current = null;

    const g = gameRef.current;
    if (g.isGameOver() || g.turn() !== playerColor) return;
    try {
      const result = g.move(pm);
      if (!result) return;
      playMoveSound(result);
      setLastMove({ from: result.from, to: result.to });
      syncState();
      if (hasTime) clock.switchSide();
      if (checkGameEnd()) return;
      setTimeout(() => doBotMoveRef.current?.(), 50);
    } catch {
      // premove was illegal in the new position — silently discard
    }
  }, [playerColor, syncState, clock, hasTime, checkGameEnd]);

  const doBotMove = useCallback(async () => {
    if (gameOver || gameOverRef.current) return;
    setBotThinking(true);
    const delay = getThinkDelay(opponent.level);
    await new Promise((r) => setTimeout(r, delay));

    const g = gameRef.current;
    if (g.isGameOver() || gameOverRef.current) { setBotThinking(false); return; }
    let move;
    try { move = await getBotMove(g.fen(), opponent.level); } catch (err) {
      setBotThinking(false);
      setFatalError({ code: "BOT_ENGINE_CRASH", detail: err?.message || "Unknown", fen: g.fen(), level: opponent.level });
      return;
    }
    if (!move) {
      setBotThinking(false);
      setFatalError({ code: "BOT_NO_MOVE", detail: "Engine returned null", fen: g.fen(), level: opponent.level });
      return;
    }
    let result;
    try { result = g.move(move); } catch { result = null; }
    if (!result) {
      setBotThinking(false);
      setFatalError({ code: "BOT_ILLEGAL_MOVE", detail: `Move: ${JSON.stringify(move)}`, fen: g.fen(), level: opponent.level });
      return;
    }
    playMoveSound(result);
    setLastMove({ from: result.from, to: result.to });
    syncState();
    if (hasTime) clock.switchSide();
    setBotThinking(false);

    if (checkGameEnd()) return;

    const moveCount = g.history().length;
    const isSpecial = result.captured || result.san.includes("+") || result.san.includes("#");
    const shouldChat = isSpecial || moveCount % 5 === 0;
    if (shouldChat) {
      const pn = ({p:"pawn",n:"knight",b:"bishop",r:"rook",q:"queen"})[result.captured] || "";
      const text = getBotChatMessage(opponent.level, {
        san: result.san, captured: pn, check: result.san.includes("+"), mate: result.san.includes("#"), moveCount,
      });
      if (text) setBotChat((prev) => { const n = [...prev.slice(-10), { from: "bot", text }]; botChatRef.current = n; return n; });
    }

    if (premoveRef.current) {
      setTimeout(() => executePremove(), 80);
    }
  }, [opponent.level, gameOver, syncState, clock, hasTime, checkGameEnd, executePremove]);

  useEffect(() => { doBotMoveRef.current = doBotMove; }, [doBotMove]);

  useEffect(() => {
    playGameStart();
    if (hasTime) {
      if (resumeData?.clockState) {
        clock.restore(resumeData.clockState.white, resumeData.clockState.black);
      }
      clock.start(gameRef.current.turn());
    }
    const g = gameRef.current;
    if (g.turn() !== playerColor && !g.isGameOver()) doBotMove();
  }, []);

  const handleMove = useCallback((move) => {
    if (gameOver) return false;
    if (previewPly) { handleBackToLive(); return false; }
    const g = gameRef.current;

    if (g.turn() !== playerColor) {
      setPremove(move);
      premoveRef.current = move;
      return false;
    }

    setPremove(null);
    premoveRef.current = null;
    try {
      const result = g.move(move);
      if (!result) return false;
      setLastMove({ from: result.from, to: result.to });
      syncState();
      if (hasTime) clock.switchSide();
      if (checkGameEnd()) return true;
      setTimeout(() => doBotMove(), 50);
      return true;
    } catch { return false; }
  }, [gameOver, playerColor, syncState, clock, hasTime, checkGameEnd, doBotMove]);

  const handleResign = useCallback(() => {
    if (!confirmResign) { setConfirmResign(true); return; }
    const result = playerColor === "w" ? "0-1" : "1-0";
    endGame(result, "resignation", false);
    setConfirmResign(false);
  }, [playerColor, endGame, confirmResign]);

  const handleDrawOffer = useCallback(() => {
    if (!confirmDraw) { setConfirmDraw(true); return; }
    endGame("1/2-1/2", "agreement", null);
    setConfirmDraw(false);
  }, [endGame, confirmDraw]);

  const handleAbort = useCallback(() => {
    clearSavedGame();
    navigate("/play");
  }, [navigate]);

  useEffect(() => {
    if (confirmDraw) {
      const t = setTimeout(() => setConfirmDraw(false), 3000);
      return () => clearTimeout(t);
    }
  }, [confirmDraw]);

  useEffect(() => {
    if (moveListRef.current) {
      if (gameOver) moveListRef.current.scrollTop = moveListRef.current.scrollHeight;
      else moveListRef.current.scrollTop = 0;
    }
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [history]);

  useEffect(() => {
    if (history.length > 0 && history.length <= 25) {
      getOpeningName(history).then((name) => { if (name) setOpeningName(name); });
    }
  }, [history.length]);

  useEffect(() => {
    if (!gameOver || history.length === 0) return;
    let cancelled = false;
    setEvalRunning(true);
    setEvals({});
    setEvalProgress(0);

    (async () => {
      const positions = [];
      const g = new Chess();
      positions.push({ ply: 0, fen: g.fen() });
      for (let i = 0; i < history.length; i++) {
        g.move(history[i].san);
        positions.push({ ply: i + 1, fen: g.fen() });
      }

      for (let pi = 0; pi < positions.length; pi++) {
        if (cancelled) break;
        const pos = positions[pi];
        const result = await evaluatePosition(pos.fen, evalDepth);
        if (cancelled) break;
        if (result) {
          const sideToMove = pos.fen.split(" ")[1];
          const whiteRelCp = result.cp !== null
            ? (sideToMove === "w" ? result.cp : -result.cp)
            : null;
          const whiteRelMate = result.mate !== null
            ? (sideToMove === "w" ? result.mate : -result.mate)
            : null;
          setEvals((prev) => ({
            ...prev,
            [pos.ply]: { cp: whiteRelCp, mate: whiteRelMate, bestMove: result.bestMove },
          }));
        }
        setEvalProgress(Math.round(((pi + 1) / positions.length) * 100));
      }
      setEvalRunning(false);
    })();

    return () => { cancelled = true; setEvalRunning(false); };
  }, [gameOver, evalDepth]);

  useEffect(() => {
    if (confirmResign) {
      const t = setTimeout(() => setConfirmResign(false), 3000);
      return () => clearTimeout(t);
    }
  }, [confirmResign]);

  const handleMoveClick = useCallback(async (ply) => {
    if (!gameOver) return;
    if (selectedPly === ply) { setSelectedPly(null); setPlyCoach(null); setFen(gameRef.current.fen()); return; }
    setSelectedPly(ply);
    setPlyLoading(true);
    const temp = new Chess();
    for (let i = 0; i < ply && i < history.length; i++) temp.move(history[i].san);
    setFen(temp.fen());
    const moveSan = history[ply - 1]?.san;
    const fenBefore = ply > 1 ? (() => { const t = new Chess(); for (let i = 0; i < ply - 1; i++) t.move(history[i].san); return t.fen(); })() : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    try {
      const text = await explainMove(fenBefore, moveSan);
      setPlyCoach({ text, fen: temp.fen(), san: moveSan, ply });
    } catch { setPlyCoach({ text: "Could not analyze.", fen: temp.fen(), san: moveSan, ply }); }
    setPlyLoading(false);
  }, [gameOver, history, selectedPly]);

  const handleBackToLive = useCallback(() => {
    setSelectedPly(null); setPlyCoach(null); setPreviewPly(null);
    setFen(gameRef.current.fen());
  }, []);

  const handlePreviewMove = useCallback((ply) => {
    if (previewPly === ply || ply === history.length) { handleBackToLive(); return; }
    setPreviewPly(ply);
    const temp = new Chess();
    for (let i = 0; i < ply && i < history.length; i++) temp.move(history[i].san);
    setFen(temp.fen());
  }, [history, previewPly, handleBackToLive]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const total = history.length;
      if (!total) return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (gameOver) {
          const cur = selectedPly ?? total;
          if (cur > 1) handleMoveClick(cur - 1);
        } else {
          const cur = previewPly ?? total;
          if (cur < total) handlePreviewMove(cur + 1);
          else handleBackToLive();
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (gameOver) {
          const cur = selectedPly ?? 0;
          if (cur < total) handleMoveClick(cur + 1);
          else { setSelectedPly(null); setPlyCoach(null); setFen(gameRef.current.fen()); }
        } else {
          const cur = previewPly ?? total;
          if (cur > 1) handlePreviewMove(cur - 1);
        }
      } else if (e.key === "Home") {
        e.preventDefault();
        if (gameOver) handleMoveClick(1);
        else handleBackToLive();
      } else if (e.key === "End") {
        e.preventDefault();
        if (gameOver) { setSelectedPly(null); setPlyCoach(null); setFen(gameRef.current.fen()); }
        else handlePreviewMove(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [history.length, gameOver, selectedPly, previewPly, handleMoveClick, handlePreviewMove, handleBackToLive]);

  const canTakeback = !gameOver && !botThinking && history.length >= 2;

  const handleTakeback = useCallback(() => {
    if (!canTakeback) return;
    const g = gameRef.current;
    g.undo();
    g.undo();
    const h = g.history({ verbose: true });
    const last = h.length > 0 ? h[h.length - 1] : null;
    setLastMove(last ? { from: last.from, to: last.to } : null);
    setPremove(null);
    premoveRef.current = null;
    syncState();
    setFen(g.fen());
    setPreviewPly(null);

    const text = getBotChatMessage(opponent.level, { san: "takeback", captured: "", check: false, mate: false, moveCount: h.length });
    if (text) setBotChat((prev) => { const n = [...prev.slice(-10), { from: "bot", text }]; botChatRef.current = n; return n; });
  }, [canTakeback, syncState, opponent.level]);

  const highlightSquares = {};
  const activePly = selectedPly || previewPly;
  if (activePly && history[activePly - 1]) {
    const m = history[activePly - 1];
    highlightSquares[m.from] = { backgroundColor: "rgba(59,130,246,0.2)" };
    highlightSquares[m.to] = { backgroundColor: "rgba(59,130,246,0.3)" };
  } else if (lastMove) {
    highlightSquares[lastMove.from] = { backgroundColor: "rgba(255,255,255,0.07)" };
    highlightSquares[lastMove.to] = { backgroundColor: "rgba(255,255,255,0.11)" };
  }
  const isPreviewingPast = previewPly !== null || selectedPly !== null;

  const captured = useMemo(() => getCaptured(fen), [fen]);
  const movePairs = [];
  for (let i = 0; i < history.length; i += 2) {
    movePairs.push({ num: Math.floor(i / 2) + 1, white: history[i], black: history[i + 1] || null });
  }

  const opponentColor = playerColor === "w" ? "b" : "w";
  const opponentTime = opponentColor === "w" ? clock.display.white : clock.display.black;
  const playerTime = playerColor === "w" ? clock.display.white : clock.display.black;
  const isPlayerTurn = !gameOver && gameRef.current.turn() === playerColor;

  const pgn = useMemo(() => {
    const g = gameRef.current;
    const moves = g.pgn({ maxWidth: 80, newline: "\n" }).replace(/\[.*?\]\s*\n?/g, "").trim();
    const date = new Date();
    const dateStr = `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
    const white = playerColor === "w" ? "You" : opponent.name;
    const black = playerColor === "b" ? "You" : opponent.name;
    const result = gameOver
      ? gameOver.won === true
        ? playerColor === "w" ? "1-0" : "0-1"
        : gameOver.won === false
          ? playerColor === "w" ? "0-1" : "1-0"
          : "1/2-1/2"
      : "*";
    return `[Event "oChess Bot Game"]\n[Site "oChess"]\n[Date "${dateStr}"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n\n${moves} ${result}`;
  }, [history.length, gameOver]);

  const turnLabel = gameOver
    ? (gameOver.won === true ? "You win" : gameOver.won === false ? "You lost" : "Draw")
    : botThinking ? `${opponent.name} thinking...` : isPlayerTurn ? "Your turn" : "Waiting...";
  const tcLabel = hasTime
    ? `${Math.floor(timeControl.initial / 60000)}+${timeControl.increment / 1000}`
    : "Unlimited";

  const opponentCaptured = playerColor === "w" ? captured.capturedByBlack : captured.capturedByWhite;
  const playerCaptured = playerColor === "w" ? captured.capturedByWhite : captured.capturedByBlack;
  const advForPlayer = playerColor === "w" ? captured.advantage : -captured.advantage;

  return (
    <div className="min-h-screen min-h-[100dvh] bg-surface flex flex-col">
      {fatalError && (
        <div className="fixed inset-0 z-[9998] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-surface-container border border-error/20 max-w-md w-full p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-error/15 flex items-center justify-center shrink-0">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-error">
                  <circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><circle cx="12" cy="16" r="0.5" fill="currentColor" />
                </svg>
              </div>
              <div>
                <h2 className="font-headline text-base font-bold text-error">Game Error</h2>
                <p className="text-[11px] text-on-surface-variant/50 mt-0.5">The game froze due to an internal error.</p>
              </div>
            </div>
            <div className="bg-surface-lowest/60 border border-white/[0.04] p-3 font-mono text-[11px] text-on-surface-variant/60 space-y-1.5 select-all">
              <p><span className="text-error/70">Code:</span> {fatalError.code}</p>
              <p><span className="text-on-surface-variant/40">Detail:</span> {fatalError.detail}</p>
              {fatalError.fen && <p><span className="text-on-surface-variant/40">FEN:</span> {fatalError.fen}</p>}
              {fatalError.level != null && <p><span className="text-on-surface-variant/40">Bot Level:</span> {fatalError.level}</p>}
            </div>
            <p className="text-[10px] text-on-surface-variant/30 leading-relaxed">
              Copy the info above and report it so it can be fixed.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const txt = `Code: ${fatalError.code}\nDetail: ${fatalError.detail}\nFEN: ${fatalError.fen || "N/A"}\nBot Level: ${fatalError.level ?? "N/A"}`;
                  navigator.clipboard.writeText(txt);
                }}
                className="flex-1 py-2 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary transition-colors active:scale-[0.96]"
              >
                Copy Error
              </button>
              <button
                onClick={() => { clearSavedGame(); navigate("/play"); }}
                className="flex-1 py-2 bg-error/15 border border-error/20 font-headline text-[10px] font-bold uppercase tracking-wide text-error hover:bg-error/25 transition-colors active:scale-[0.96]"
              >
                Exit Game
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Top bar ── */}
      <div className="w-full bg-surface-lowest/80 backdrop-blur-xl border-b border-white/[0.04] px-4 sm:px-6 h-12 flex items-center justify-between shrink-0 z-10">
        <button
          onClick={() => navigate("/")}
          className="flex items-center gap-2 text-on-surface-variant/50 hover:text-primary transition-colors py-2 pr-3"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <span className="font-headline text-lg font-extrabold tracking-tighter text-primary">oChess</span>
        </button>

        <div className="flex items-center gap-3">
          <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/30">
            vs {opponent.name} · {tcLabel}
          </span>
          <span className={`text-[10px] font-headline font-bold uppercase tracking-wide px-2 py-0.5 ${
            gameOver
              ? gameOver.won ? "bg-emerald-500/15 text-emerald-400" : gameOver.won === false ? "bg-error/15 text-error" : "bg-surface-high text-on-surface-variant/50"
              : isPlayerTurn ? "bg-primary/10 text-primary" : "bg-surface-high text-on-surface-variant/40"
          }`}>
            {turnLabel}
          </span>
        </div>
      </div>

      {/* ── Main body: game + social ── */}
      <div className="flex-1 flex">
      {/* ── Game content ── */}
      <div className="flex-1 min-w-0 flex flex-col xl:flex-row px-4 sm:px-8 xl:pl-16 xl:pr-6 py-3 sm:py-4 gap-4 xl:gap-6">
        {/* Board column */}
        <div className="flex-1 flex flex-col items-center xl:items-start max-w-[720px]">
          {/* Opponent bar */}
          <PlayerBar
            name={opponent.name}
            rating={opponent.rating}
            captured={opponentCaptured}
            advantage={advForPlayer < 0 ? Math.abs(advForPlayer) : 0}
            pieceColor={opponentColor}
            time={hasTime ? opponentTime : null}
            active={!gameOver && gameRef.current.turn() === opponentColor}
            thinking={botThinking}
            isBot
          />

          <div className="w-full flex gap-0">
            {/* Eval bar — only post-game */}
            {gameOver && (
              <EvalBar
                evals={evals}
                currentPly={selectedPly ?? history.length}
                orientation={playerColor}
              />
            )}

            <div className="flex-1 min-w-0">
              <InteractiveBoard
                fen={fen}
                onMove={handleMove}
                orientation={playerColor === "w" ? "white" : "black"}
                interactive={!gameOver && !isPreviewingPast}
                highlightSquares={highlightSquares}
                premoveSquares={premove}
                playerColor={playerColor}
              />
            </div>
          </div>

          {/* Premove indicator */}
          {premove && (
            <div className="w-full mt-1 flex items-center justify-between px-2 py-1.5 bg-blue-900/20 border border-blue-500/15">
              <span className="text-[10px] font-headline font-bold uppercase tracking-wide text-blue-400/70">
                Premove: {premove.from}{premove.to}
              </span>
              <button
                onClick={() => { setPremove(null); premoveRef.current = null; }}
                className="text-[10px] text-blue-400/50 hover:text-blue-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Preview / back to live bar */}
          {isPreviewingPast && !gameOver && (
            <button onClick={handleBackToLive} className="w-full mt-1 py-2 bg-blue-900/30 border border-blue-500/20 font-headline text-xs font-bold uppercase tracking-wide text-blue-400/80 hover:bg-blue-900/50 transition-colors active:scale-[0.97]">
              Back to live position
            </button>
          )}

          {/* Player bar */}
          <PlayerBar
            name="You"
            captured={playerCaptured}
            advantage={advForPlayer > 0 ? advForPlayer : 0}
            pieceColor={playerColor}
            time={hasTime ? playerTime : null}
            active={isPlayerTurn}
            isPlayer
          />
        </div>

        {/* ── Sidebar (live play) ── */}
        {!gameOver && (
          <div className="w-full xl:w-[340px] shrink-0 flex flex-col gap-3">
            {/* Controls */}
            <div className="flex gap-2 shrink-0 flex-wrap">
              {canTakeback && (
                <button
                  onClick={handleTakeback}
                  className="py-2.5 px-3 bg-surface-low border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/35 hover:text-primary transition-colors active:scale-[0.96]"
                >
                  Takeback
                </button>
              )}
              {history.length <= 2 ? (
                <button
                  onClick={handleAbort}
                  className="flex-1 py-2.5 bg-surface-low border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/35 hover:text-on-surface-variant/60 transition-colors active:scale-[0.96]"
                >
                  Abort
                </button>
              ) : (
                <>
                  <button
                    onClick={handleDrawOffer}
                    className={`py-2.5 px-3 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${
                      confirmDraw
                        ? "bg-amber-500/20 text-amber-400 border border-amber-500/20"
                        : "bg-surface-low border border-white/[0.04] text-on-surface-variant/35 hover:text-amber-400 hover:border-amber-500/15"
                    }`}
                  >
                    {confirmDraw ? "Confirm Draw" : "Draw"}
                  </button>
                  <button
                    onClick={handleResign}
                    className={`flex-1 py-2.5 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${
                      confirmResign
                        ? "bg-error/20 text-error border border-error/20"
                        : "bg-surface-low border border-white/[0.04] text-on-surface-variant/35 hover:text-error hover:border-error/15"
                    }`}
                  >
                    {confirmResign ? "Confirm Resign" : "Resign"}
                  </button>
                </>
              )}
              <button
                onClick={() => navigate("/play")}
                className="py-2.5 px-3 bg-surface-low border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/35 hover:text-primary transition-colors active:scale-[0.96]"
              >
                Menu
              </button>
            </div>

            {/* Bot chat */}
            <div className="bg-surface-container border border-white/[0.04] shrink-0">
              <div className="p-2 border-b border-white/[0.03]">
                <h2 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">{opponent.name}</h2>
              </div>
              <div ref={chatRef} className="max-h-[140px] overflow-y-auto p-2.5 space-y-1.5">
                {botChat.length === 0 && (
                  <p className="text-[11px] text-on-surface-variant/20 italic">...</p>
                )}
                {botChat.map((msg, i) => (
                  <p key={i} className="text-[11px] text-on-surface-variant/50 leading-relaxed break-words">{msg.text}</p>
                ))}
              </div>
            </div>

            {/* Opening name + wiki links */}
            <div className="bg-surface-container border border-white/[0.04] px-3 py-2 shrink-0">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/30 mr-2">Opening</span>
                  <span className="text-[12px] font-headline font-semibold text-on-surface-variant/70">
                    {openingName || "\u2026"}
                  </span>
                </div>
                {openingName && (
                  <div className="flex gap-2 shrink-0 ml-2">
                    <a href={`https://en.wikipedia.org/wiki/${encodeURIComponent(openingName.replace(/:.*/, "").trim())}`} target="_blank" rel="noopener noreferrer" className="text-[9px] text-on-surface-variant/30 hover:text-primary transition-colors">Wiki</a>
                    <a href={`https://lichess.org/opening/${encodeURIComponent(openingName.replace(/:.*/, "").trim())}`} target="_blank" rel="noopener noreferrer" className="text-[9px] text-on-surface-variant/30 hover:text-primary transition-colors">Lichess</a>
                  </div>
                )}
              </div>
            </div>

            {/* Move list (live — reversed, newest on top) */}
            <div className="bg-surface-low flex flex-col flex-1 min-h-0">
              <div className="p-3 flex justify-between items-center border-b border-white/[0.03] shrink-0">
                <h2 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">Moves</h2>
                <span className="text-[10px] text-on-surface-variant/20 tabular-nums">{history.length}</span>
              </div>
              <div ref={moveListRef} className="flex-1 overflow-y-auto max-h-[320px] xl:max-h-none">
                {movePairs.length === 0 && (
                  <div className="p-4 text-center text-[11px] text-on-surface-variant/20">
                    {isPlayerTurn ? "Your move" : "Waiting..."}
                  </div>
                )}
                {[...movePairs].reverse().map((m, ri) => {
                  const origIdx = movePairs.length - 1 - ri;
                  const wPly = origIdx * 2 + 1;
                  const bPly = origIdx * 2 + 2;
                  const isActive = (ply) => previewPly === ply;
                  return (
                    <div key={m.num} className={`grid text-[13px] ${ri % 2 === 0 ? "bg-surface-lowest/40" : ""}`} style={{ gridTemplateColumns: "1.8rem 1fr 1fr" }}>
                      <span className="text-[10px] text-on-surface-variant/20 self-center px-1 py-1.5">{m.num}.</span>
                      <button onClick={() => handlePreviewMove(wPly)} className={`font-mono text-left py-1.5 px-1 transition-colors hover:bg-primary/10 ${isActive(wPly) ? "bg-primary/15 text-primary font-bold" : "text-on-surface-variant/70"}`}>
                        {m.white?.san}
                      </button>
                      {m.black ? (
                        <button onClick={() => handlePreviewMove(bPly)} className={`font-mono text-left py-1.5 px-1 transition-colors hover:bg-primary/10 ${isActive(bPly) ? "bg-primary/15 text-primary font-bold" : "text-on-surface-variant/45"}`}>
                          {m.black.san}
                        </button>
                      ) : <span />}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── Analysis sidebar (post-game) — result + controls column ── */}
        {gameOver && (
          <div className="w-full xl:w-[280px] shrink-0 flex flex-col gap-3">
            {/* Result */}
            <div className="anim-fade-up p-4 bg-surface-container border border-white/[0.06]">
              <span className="font-headline text-2xl font-extrabold text-primary block mb-0.5">
                {gameOver.won === true ? "You win!" : gameOver.won === false ? "You lost" : "Draw"}
              </span>
              <span className="text-[11px] text-on-surface-variant/40 capitalize block mb-3">{gameOver.reason}</span>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const newColor = Math.random() > 0.5 ? "w" : "b";
                    navigate("/game", { state: { opponent, playerColor: newColor, timeControl }, replace: true });
                  }}
                  className="flex-1 py-2 bg-primary text-on-primary font-headline text-[10px] font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.96]"
                >
                  Rematch
                </button>
                <button onClick={() => navigate("/play")} className="flex-1 py-2 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.96]">
                  New Game
                </button>
              </div>
              <div className="flex gap-2 mt-2">
                <button onClick={() => navigate("/analysis", { state: { pgn } })} className="flex-1 py-2 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.96]">
                  Analyze
                </button>
                <button
                  onClick={() => { navigator.clipboard.writeText(pgn); setPgnCopied(true); setTimeout(() => setPgnCopied(false), 2000); }}
                  className={`flex-1 py-2 font-headline text-[10px] font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${
                    pgnCopied ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/20" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary hover:bg-surface-high"
                  }`}
                >
                  {pgnCopied ? "Copied!" : "Copy PGN"}
                </button>
              </div>
            </div>

            {/* Engine depth control */}
            <div className="bg-surface-container border border-white/[0.04] px-3 py-2.5 shrink-0">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40">
                  Engine analysis
                </span>
                {evalRunning && (
                  <span className="text-[9px] font-mono text-primary/60 tabular-nums">{evalProgress}%</span>
                )}
                {!evalRunning && Object.keys(evals).length > 0 && (
                  <span className="text-[9px] text-emerald-500/60">done</span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-on-surface-variant/40 shrink-0">Depth</span>
                <div className="flex gap-1 flex-wrap">
                  {[8, 10, 14, 18, 22, 26].map((d) => (
                    <button
                      key={d}
                      onClick={() => { if (d !== evalDepth) setEvalDepth(d); }}
                      disabled={evalRunning}
                      className={`px-1.5 py-0.5 text-[10px] font-mono font-bold transition-colors ${
                        evalDepth === d
                          ? "bg-primary text-on-primary"
                          : evalRunning
                            ? "bg-surface-low text-on-surface-variant/15"
                            : "bg-surface-low text-on-surface-variant/40 hover:text-primary"
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[9px] text-on-surface-variant/25 mt-1.5 leading-relaxed">
                Runs locally in your browser — nothing is sent to a server.
                {evalDepth >= 18 && " Higher depth is slower on most devices."}
                {evalDepth >= 22 && " 22+ may take minutes for long games."}
                {evalDepth >= 26 && " 26 is very slow — only for short games."}
              </p>
              {evalRunning && (
                <div className="mt-2 h-1 bg-surface-low overflow-hidden">
                  <div className="h-full bg-primary/50 transition-all duration-300" style={{ width: `${evalProgress}%` }} />
                </div>
              )}
            </div>

            {/* Opening wiki */}
            <OpeningWiki openingName={openingName} fen={fen} />

            {/* Bot chat (collapsed in analysis) */}
            <div className="bg-surface-container border border-white/[0.04] shrink-0">
              <div className="p-2 border-b border-white/[0.03]">
                <h2 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">{opponent.name}</h2>
              </div>
              <div ref={chatRef} className="max-h-[100px] overflow-y-auto p-2.5 space-y-1.5">
                {botChat.length === 0 && (
                  <p className="text-[11px] text-on-surface-variant/20 italic">...</p>
                )}
                {botChat.map((msg, i) => (
                  <p key={i} className="text-[11px] text-on-surface-variant/50 leading-relaxed break-words">{msg.text}</p>
                ))}
              </div>
            </div>

            {/* Move analysis panel */}
            {selectedPly && (
              <div className="bg-surface-container p-3 border border-white/[0.04] space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-primary/70">
                      Move {Math.ceil(selectedPly / 2)}{selectedPly % 2 === 1 ? "." : "..."} {plyCoach?.san}
                    </h3>
                    {evals[selectedPly] && (
                      <span className={`text-[10px] font-mono font-bold tabular-nums ${
                        evals[selectedPly].cp > 50 ? "text-on-surface-variant/70" : evals[selectedPly].cp < -50 ? "text-on-surface-variant/40" : "text-on-surface-variant/50"
                      }`}>
                        {evalToLabel(evals[selectedPly])}
                      </span>
                    )}
                  </div>
                  <button onClick={handleBackToLive} className="text-[10px] text-on-surface-variant/30 hover:text-primary transition-colors">
                    Back to end
                  </button>
                </div>
                {plyLoading ? (
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 border border-primary/30 border-t-primary rounded-full animate-spin" />
                    <span className="text-[11px] text-on-surface-variant/30">Analyzing...</span>
                  </div>
                ) : plyCoach && (
                  <p className="text-[11px] text-on-surface-variant/50 leading-relaxed">{plyCoach.text}</p>
                )}
                <button
                  onClick={() => {
                    if (!plyCoach) return;
                    try {
                      const cards = JSON.parse(localStorage.getItem("ochess_review_cards") || "[]");
                      cards.push({ fen: plyCoach.fen, type: "game", san: plyCoach.san, ply: plyCoach.ply, ts: Date.now() });
                      localStorage.setItem("ochess_review_cards", JSON.stringify(cards));
                    } catch {}
                  }}
                  className="w-full py-2 bg-surface-low border border-primary/15 font-headline text-[10px] font-bold uppercase tracking-wide text-primary/60 hover:text-primary hover:border-primary/25 transition-colors active:scale-[0.96]"
                >
                  Save to Anki
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Move list column (post-game, separate from result panel) ── */}
        {gameOver && (
          <div className="w-full xl:w-[280px] shrink-0 flex flex-col gap-3 min-h-0">
            <div className="bg-surface-low flex flex-col flex-1 min-h-0" style={{ maxHeight: "min(65vh, 580px)" }}>
              <div className="p-3 flex justify-between items-center border-b border-white/[0.03] shrink-0">
                <h2 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">Moves</h2>
                <span className="text-[10px] text-on-surface-variant/20 tabular-nums">{history.length}</span>
              </div>
              <div ref={moveListRef} className="flex-1 overflow-y-auto">
                {movePairs.map((m, ri) => {
                  const wPly = ri * 2 + 1;
                  const bPly = ri * 2 + 2;
                  const isActive = (ply) => selectedPly === ply;
                  const hasEvals = Object.keys(evals).length > 0;
                  const wEv = hasEvals ? evals[wPly] : null;
                  const bEv = hasEvals ? evals[bPly] : null;
                  return (
                    <div key={m.num} className={`grid text-[12px] ${ri % 2 === 0 ? "bg-surface-lowest/40" : ""}`} style={{ gridTemplateColumns: hasEvals ? "1.6rem 1fr 2rem 1fr 2rem" : "1.6rem 1fr 1fr" }}>
                      <span className="text-[9px] text-on-surface-variant/20 self-center px-1 py-1">{m.num}.</span>
                      <button onClick={() => handleMoveClick(wPly)} className={`font-mono text-left py-1 px-1 transition-colors hover:bg-primary/10 ${isActive(wPly) ? "bg-primary/15 text-primary font-bold" : "text-on-surface-variant/70"}`}>
                        {m.white?.san}
                      </button>
                      {hasEvals && (
                        <span className="text-[8px] font-mono text-on-surface-variant/25 self-center text-right pr-0.5 tabular-nums">
                          {wEv ? evalToLabel(wEv) : ""}
                        </span>
                      )}
                      {m.black ? (
                        <button onClick={() => handleMoveClick(bPly)} className={`font-mono text-left py-1 px-1 transition-colors hover:bg-primary/10 ${isActive(bPly) ? "bg-primary/15 text-primary font-bold" : "text-on-surface-variant/45"}`}>
                          {m.black.san}
                        </button>
                      ) : <span />}
                      {hasEvals && m.black && (
                        <span className="text-[8px] font-mono text-on-surface-variant/25 self-center text-right pr-0.5 tabular-nums">
                          {bEv ? evalToLabel(bEv) : ""}
                        </span>
                      )}
                      {hasEvals && !m.black && <span />}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

      </div>
      <SocialPanel />
      </div>
    </div>
  );
}

function PlayerBar({ name, rating, captured = [], advantage = 0, pieceColor, time, active, isPlayer, isBot, thinking }) {
  return (
    <div className={`w-full flex items-center justify-between py-2 px-2 rounded ${isPlayer ? "mt-2 bg-surface-low/50" : "mb-2 bg-surface-low/50"}`}>
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 relative ${
          isPlayer ? "bg-primary/25" : "bg-surface-high"
        }`}>
          <span className={`font-headline text-sm font-bold uppercase ${
            isPlayer ? "text-primary" : "text-on-surface-variant/70"
          }`}>
            {name[0]}
          </span>
          {thinking && (
            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 border-2 border-surface bg-surface rounded-full flex items-center justify-center">
              <div className="w-2 h-2 border border-primary/40 border-t-primary rounded-full animate-spin" />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`font-headline text-sm font-bold truncate ${
            isPlayer ? "text-primary" : "text-on-surface-variant/80"
          }`}>
            {name}
          </span>
          {rating && <span className="text-xs text-on-surface-variant/35 tabular-nums shrink-0">{rating}</span>}
        </div>
        {/* Captured pieces */}
        {captured.length > 0 && (
          <div className="flex items-center gap-px ml-1 shrink-0">
            {captured.map((p, i) => {
              const capturedColor = pieceColor === "w" ? "b" : "w";
              const needsBrighten = capturedColor === "b";
              return (
                <img
                  key={i}
                  src={`/piece/cburnett/${capturedColor}${p.toUpperCase()}.svg`}
                  alt={p}
                  className="w-4 h-4"
                  style={needsBrighten ? { filter: "brightness(2.5) grayscale(0.6)", opacity: 0.7 } : { opacity: 0.6 }}
                  draggable={false}
                />
              );
            })}
            {advantage > 0 && (
              <span className="text-[10px] font-bold text-on-surface-variant/30 ml-1 tabular-nums">+{advantage}</span>
            )}
          </div>
        )}
      </div>
      {time != null && (
        <ClockDisplay time={time} active={active} />
      )}
    </div>
  );
}

function ClockDisplay({ time, active }) {
  const low = time < 30000;
  const critical = time < 10000;
  return (
    <div className={`px-3 py-1 font-mono text-base font-bold tabular-nums transition-colors shrink-0 ${
      active
        ? critical ? "bg-error/20 text-error" : low ? "bg-primary/10 text-primary" : "bg-surface-high text-primary"
        : "bg-surface-low/80 text-on-surface-variant/35"
    }`}>
      {formatTime(time)}
    </div>
  );
}

function evalToPct(ev) {
  if (!ev) return 50;
  if (ev.mate !== null) return ev.mate > 0 ? 96 : 4;
  if (ev.cp !== null) {
    const clamped = Math.max(-600, Math.min(600, ev.cp));
    return 50 + (clamped / 600) * 46;
  }
  return 50;
}

function evalToLabel(ev) {
  if (!ev) return "...";
  if (ev.mate !== null) {
    const sign = ev.mate > 0 ? "+" : "-";
    return `${sign}M${Math.abs(ev.mate)}`;
  }
  if (ev.cp !== null) {
    const p = ev.cp / 100;
    if (Math.abs(p) < 0.15) return "0.0";
    return (p > 0 ? "+" : "") + p.toFixed(1);
  }
  return "...";
}

function EvalBar({ evals, currentPly, orientation }) {
  const ev = evals[currentPly] || null;
  const whitePct = evalToPct(ev);
  const label = evalToLabel(ev);
  const hasAny = Object.keys(evals).length > 0;

  const topIsBlack = orientation === "w";
  const blackPct = 100 - whitePct;

  const topPct = topIsBlack ? blackPct : whitePct;
  const botPct = topIsBlack ? whitePct : blackPct;
  const topBg = topIsBlack ? "#1a1a1a" : "#e8e8e8";
  const botBg = topIsBlack ? "#e8e8e8" : "#1a1a1a";

  const showOnTop = topPct >= botPct;

  return (
    <div className="w-7 shrink-0 flex flex-col relative select-none" style={{ minHeight: "100%" }}>
      <div
        className="flex items-start justify-center transition-all duration-300 ease-out"
        style={{ height: `${topPct}%`, backgroundColor: topBg, minHeight: "14px" }}
      >
        {hasAny && showOnTop && (
          <span className="text-[9px] font-mono font-bold leading-none pt-1 tabular-nums"
            style={{ color: topIsBlack ? "#bbb" : "#222" }}>
            {label}
          </span>
        )}
      </div>
      <div
        className="flex-1 flex items-end justify-center transition-all duration-300 ease-out"
        style={{ backgroundColor: botBg, minHeight: "14px" }}
      >
        {hasAny && !showOnTop && (
          <span className="text-[9px] font-mono font-bold leading-none pb-1 tabular-nums"
            style={{ color: topIsBlack ? "#222" : "#bbb" }}>
            {label}
          </span>
        )}
      </div>
      {!hasAny && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-2.5 h-2.5 border border-on-surface-variant/20 border-t-on-surface-variant/50 rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
}

function OpeningWiki({ openingName, fen }) {
  if (!openingName) {
    return (
      <div className="bg-surface-container border border-white/[0.04] px-3 py-2.5 shrink-0">
        <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/30 block mb-1">Opening</span>
        <span className="text-[11px] text-on-surface-variant/30 italic">Unknown opening</span>
      </div>
    );
  }

  const baseName = openingName.replace(/:.*/, "").trim();
  const variation = openingName.includes(":") ? openingName.split(":").slice(1).join(":").trim() : null;
  const wikiSlug = baseName.replace(/\s+/g, "_");
  const lichessSlug = baseName.replace(/\s+/g, "_");
  const explorerUrl = `https://lichess.org/analysis/${fen ? encodeURIComponent(fen) : ""}`;

  return (
    <div className="bg-surface-container border border-white/[0.04] px-3 py-3 shrink-0 space-y-2">
      <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/30 block">Opening</span>
      <div>
        <span className="text-[12px] font-headline font-semibold text-on-surface-variant/80 block leading-snug">
          {baseName}
        </span>
        {variation && (
          <span className="text-[11px] text-on-surface-variant/40 block mt-0.5 leading-snug">
            {variation}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5 pt-1 border-t border-white/[0.04]">
        <a
          href={`https://en.wikipedia.org/wiki/${wikiSlug}_(chess)`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-[10px] text-on-surface-variant/45 hover:text-primary transition-colors group"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 opacity-40 group-hover:opacity-70">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
          Wikipedia article
        </a>
        <a
          href={`https://lichess.org/opening/${lichessSlug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-[10px] text-on-surface-variant/45 hover:text-primary transition-colors group"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 opacity-40 group-hover:opacity-70">
            <circle cx="12" cy="12" r="10" /><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10" /><path d="M12 2a15 15 0 0 0-4 10 15 15 0 0 0 4 10" /><path d="M2 12h20" />
          </svg>
          Lichess opening page
        </a>
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-[10px] text-on-surface-variant/45 hover:text-primary transition-colors group"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 opacity-40 group-hover:opacity-70">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
          Explore position on Lichess
        </a>
      </div>
    </div>
  );
}
