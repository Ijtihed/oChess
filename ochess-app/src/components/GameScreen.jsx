import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Chess } from "chess.js";
import InteractiveBoard from "./InteractiveBoard";
import useClock, { formatTime } from "../hooks/useClock";
import { getBotMove, getThinkDelay } from "../lib/bot-engine";
import { playMoveSound, playGameStart, playVictory, playDefeat, playDraw, preloadAll } from "../lib/sounds";

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
  let whiteAdv = 0;
  let blackAdv = 0;
  for (const p of PIECE_ORDER) {
    const missingB = STARTING[p] - b[p];
    const missingW = STARTING[p] - w[p];
    for (let i = 0; i < missingB; i++) capturedByWhite.push(p);
    for (let i = 0; i < missingW; i++) capturedByBlack.push(p);
    whiteAdv += missingB * PIECE_VAL[p];
    blackAdv += missingW * PIECE_VAL[p];
  }
  const advantage = whiteAdv - blackAdv;
  return { capturedByWhite, capturedByBlack, advantage };
}

export default function GameScreen({ opponent, playerColor = "w", timeControl }) {
  const navigate = useNavigate();
  const gameRef = useRef(new Chess());
  const [fen, setFen] = useState(gameRef.current.fen());
  const [history, setHistory] = useState([]);
  const [gameOver, setGameOver] = useState(null);
  const [botThinking, setBotThinking] = useState(false);
  const [lastMove, setLastMove] = useState(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const moveListRef = useRef(null);

  const hasTime = timeControl && timeControl.initial > 0;
  const clock = useClock(hasTime ? timeControl.initial : 0, hasTime ? timeControl.increment : 0);

  useEffect(() => { preloadAll(); }, []);

  useEffect(() => {
    if (clock.timedOut && !gameOver) {
      const loser = clock.timedOut;
      const result = loser === "w" ? "0-1" : "1-0";
      const won = (loser === "w") !== (playerColor === "w");
      endGame(result, "timeout", won);
    }
  }, [clock.timedOut]);

  const endGame = useCallback((result, reason, won) => {
    clock.stop();
    setGameOver({ result, reason, won });
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

  const syncState = useCallback(() => {
    setFen(gameRef.current.fen());
    setHistory([...gameRef.current.history({ verbose: true })]);
  }, []);

  const doBotMove = useCallback(() => {
    if (gameOver) return;
    setBotThinking(true);
    const delay = getThinkDelay(opponent.level);
    setTimeout(() => {
      const g = gameRef.current;
      if (g.isGameOver()) { setBotThinking(false); return; }
      const move = getBotMove(g.fen(), opponent.level);
      if (!move) { setBotThinking(false); return; }
      const result = g.move(move);
      playMoveSound(result);
      setLastMove({ from: result.from, to: result.to });
      syncState();
      if (hasTime) clock.switchSide();
      setBotThinking(false);
      checkGameEnd();
    }, delay);
  }, [opponent.level, gameOver, syncState, clock, hasTime, checkGameEnd]);

  useEffect(() => {
    playGameStart();
    if (hasTime) clock.start("w");
    if (playerColor === "b") doBotMove();
  }, []);

  const handleMove = useCallback((move) => {
    if (gameOver || botThinking) return false;
    const g = gameRef.current;
    if (g.turn() !== playerColor) return false;
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
  }, [gameOver, botThinking, playerColor, syncState, clock, hasTime, checkGameEnd, doBotMove]);

  const handleResign = useCallback(() => {
    if (!confirmResign) { setConfirmResign(true); return; }
    const result = playerColor === "w" ? "0-1" : "1-0";
    endGame(result, "resignation", false);
    setConfirmResign(false);
  }, [playerColor, endGame, confirmResign]);

  useEffect(() => {
    if (moveListRef.current) moveListRef.current.scrollTop = moveListRef.current.scrollHeight;
  }, [history]);

  useEffect(() => {
    if (confirmResign) {
      const t = setTimeout(() => setConfirmResign(false), 3000);
      return () => clearTimeout(t);
    }
  }, [confirmResign]);

  const highlightSquares = {};
  if (lastMove) {
    highlightSquares[lastMove.from] = { backgroundColor: "rgba(255,255,255,0.07)" };
    highlightSquares[lastMove.to] = { backgroundColor: "rgba(255,255,255,0.11)" };
  }

  const captured = useMemo(() => getCaptured(fen), [fen]);
  const movePairs = [];
  for (let i = 0; i < history.length; i += 2) {
    movePairs.push({ num: Math.floor(i / 2) + 1, white: history[i], black: history[i + 1] || null });
  }

  const opponentColor = playerColor === "w" ? "b" : "w";
  const opponentTime = opponentColor === "w" ? clock.display.white : clock.display.black;
  const playerTime = playerColor === "w" ? clock.display.white : clock.display.black;
  const isPlayerTurn = !gameOver && gameRef.current.turn() === playerColor;
  const pgn = gameRef.current.pgn();
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
      {/* ── Top bar ── */}
      <div className="w-full bg-surface-lowest/80 backdrop-blur-xl border-b border-white/[0.04] px-4 sm:px-6 h-12 flex items-center justify-between shrink-0">
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

      {/* ── Game content ── */}
      <div className="flex-1 flex flex-col xl:flex-row max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-3 sm:py-4 gap-4 xl:gap-5">
        {/* Board column */}
        <div className="flex-1 flex flex-col items-center xl:items-start max-w-[700px]">
          {/* Opponent bar */}
          <PlayerBar
            name={opponent.name}
            rating={opponent.rating}
            captured={opponentCaptured}
            advantage={advForPlayer < 0 ? Math.abs(advForPlayer) : 0}
            pieceColor={opponentColor}
            time={hasTime ? opponentTime : null}
            active={!gameOver && gameRef.current.turn() === opponentColor}
            isBot
          />

          <InteractiveBoard
            fen={fen}
            onMove={handleMove}
            orientation={playerColor === "w" ? "white" : "black"}
            interactive={!gameOver && !botThinking && isPlayerTurn}
            highlightSquares={highlightSquares}
          />

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

        {/* ── Sidebar ── */}
        <div className="w-full xl:w-[300px] shrink-0 flex flex-col gap-3">
          {/* Game over */}
          {gameOver && (
            <div className="anim-fade-up p-5 bg-surface-container border border-white/[0.06]">
              <span className="font-headline text-2xl font-extrabold text-primary block mb-0.5">
                {gameOver.won === true ? "You win!" : gameOver.won === false ? "You lost" : "Draw"}
              </span>
              <span className="text-[11px] text-on-surface-variant/40 capitalize block mb-4">{gameOver.reason}</span>
              <div className="flex gap-2">
                <button onClick={() => navigate("/bots")} className="flex-1 py-2.5 bg-primary text-on-primary font-headline text-xs font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.96]">
                  New Game
                </button>
                <button onClick={() => navigate("/analysis", { state: { pgn } })} className="flex-1 py-2.5 bg-surface-low border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/60 hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.96]">
                  Analyze
                </button>
              </div>
              <button onClick={() => navigate("/review")} className="w-full mt-2 py-2.5 bg-surface-low border border-primary/15 font-headline text-xs font-bold uppercase tracking-wide text-primary/70 hover:text-primary hover:border-primary/25 hover:bg-surface-high transition-colors active:scale-[0.96]">
                Add to Review
              </button>
            </div>
          )}

          {/* Move list */}
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
              {movePairs.map((m, i) => (
                <div
                  key={m.num}
                  className={`grid grid-cols-[1.8rem_1fr_1fr] text-[13px] py-1.5 px-3 ${
                    i % 2 === 0 ? "bg-surface-lowest/40" : ""
                  } ${i === movePairs.length - 1 ? "bg-primary/[0.04] border-l-2 border-primary" : ""}`}
                >
                  <span className="text-[10px] text-on-surface-variant/20 self-center">{m.num}.</span>
                  <span className="font-mono text-on-surface-variant/70">{m.white?.san}</span>
                  <span className="font-mono text-on-surface-variant/45">{m.black?.san || ""}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Controls */}
          {!gameOver && (
            <div className="flex gap-2 shrink-0">
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
              <button
                onClick={() => navigate("/")}
                className="py-2.5 px-4 bg-surface-low border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/35 hover:text-primary transition-colors active:scale-[0.96]"
              >
                Menu
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlayerBar({ name, rating, captured = [], advantage = 0, pieceColor, time, active, isPlayer, isBot }) {
  return (
    <div className={`w-full flex items-center justify-between py-1.5 px-1 ${isPlayer ? "mt-1.5" : "mb-1.5"}`}>
      <div className="flex items-center gap-2.5 min-w-0">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
          isPlayer ? "bg-primary/20" : "bg-surface-high"
        }`}>
          <span className={`font-headline text-[9px] font-bold uppercase ${
            isPlayer ? "text-primary" : "text-on-surface-variant/60"
          }`}>
            {name[0]}
          </span>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <span className={`font-headline text-xs font-bold truncate ${
            isPlayer ? "text-primary" : "text-on-surface-variant/70"
          }`}>
            {name}
          </span>
          {rating && <span className="text-[10px] text-on-surface-variant/25 tabular-nums shrink-0">{rating}</span>}
        </div>
        {/* Captured pieces */}
        {captured.length > 0 && (
          <div className="flex items-center gap-px ml-1 shrink-0">
            {captured.map((p, i) => (
              <img
                key={i}
                src={`/piece/cburnett/${pieceColor === "w" ? "b" : "w"}${p.toUpperCase()}.svg`}
                alt={p}
                className="w-3.5 h-3.5 opacity-50"
                draggable={false}
              />
            ))}
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
