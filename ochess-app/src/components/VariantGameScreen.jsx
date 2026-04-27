import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Chess } from "chess.js";
import InteractiveBoard from "./InteractiveBoard";
import SocialPanel from "./SocialPanel";
import { createVariantGame } from "../lib/variants";
import { getBotMove, getThinkDelay } from "../lib/bot-engine";
import { playMoveSound, playGameStart, playVictory, playDefeat, playDraw, preloadAll } from "../lib/sounds";
import { getBotChatMessage } from "../lib/bot-chat";

export default function VariantGameScreen({ variantId, opponent, playerColor = "w" }) {
  const navigate = useNavigate();

  const gameRef = useRef(null);
  if (!gameRef.current) gameRef.current = createVariantGame(variantId);
  const vg = gameRef.current;

  const [fen, setFen] = useState(vg.fen());
  const [history, setHistory] = useState([]);
  const [gameOver, setGameOver] = useState(null);
  const [botThinking, setBotThinking] = useState(false);
  const [lastMove, setLastMove] = useState(null);
  const [botChat, setBotChat] = useState([]);
  const botChatRef = useRef([]);
  const gameOverRef = useRef(null);
  const botMovingRef = useRef(false);
  const [pgnCopied, setPgnCopied] = useState(false);
  const [selectedPly, setSelectedPly] = useState(null);

  const endGame = useCallback((result, reason, won) => {
    const go = { result, reason, won };
    setGameOver(go);
    gameOverRef.current = go;
    if (won) playVictory();
    else if (result === "1/2-1/2") playDraw();
    else playDefeat();
  }, []);

  const checkEnd = useCallback(() => {
    const end = vg.checkEnd();
    if (!end) return false;
    const won = (end.result === "1-0" && playerColor === "w") || (end.result === "0-1" && playerColor === "b");
    endGame(end.result, end.reason, end.result === "1/2-1/2" ? null : won);
    return true;
  }, [vg, playerColor, endGame]);

  const syncState = useCallback(() => {
    setFen(vg.fen());
    setHistory([...vg.history({ verbose: true })]);
  }, [vg]);

  useEffect(() => { preloadAll(); playGameStart(); }, []);

  const [playerMovesLeft, setPlayerMovesLeft] = useState(0);

  const doBotMove = useCallback(async () => {
    if (gameOverRef.current || botMovingRef.current) return;
    if (vg.turn() === playerColor) return;
    botMovingRef.current = true;
    setBotThinking(true);

    const movesToMake = vg.isMultiMove() ? vg.onTurnStart() : 1;

    for (let i = 0; i < movesToMake; i++) {
      if (gameOverRef.current) break;
      const delay = i === 0 ? getThinkDelay(opponent.level) : Math.min(400, getThinkDelay(opponent.level));
      await new Promise((r) => setTimeout(r, delay));

      if (gameOverRef.current || vg.turn() === playerColor) break;

      let move;
      try { move = await getBotMove(vg.fen(), opponent.level); } catch { break; }
      if (!move) break;

      let result;
      try { result = vg.move(move); } catch { break; }
      if (!result) break;

      vg.onSubMoveComplete();
      playMoveSound(result);
      setLastMove({ from: result.from, to: result.to });
      syncState();

      if (checkEnd()) { botMovingRef.current = false; setBotThinking(false); return; }
      if (vg.shouldEndSequence()) break;
    }

    vg.onTurnEnd();
    setBotThinking(false);
    botMovingRef.current = false;

    if (!gameOverRef.current) {
      const playerMoves = vg.isMultiMove() ? vg.onTurnStart() : 1;
      setPlayerMovesLeft(playerMoves);
    }
  }, [opponent.level, vg, playerColor, syncState, checkEnd]);

  useEffect(() => {
    if (vg.turn() !== playerColor && !gameOverRef.current) {
      doBotMove();
    } else {
      const n = vg.isMultiMove() ? vg.onTurnStart() : 1;
      setPlayerMovesLeft(n);
    }
  }, []);

  const handleMove = useCallback((move) => {
    if (gameOver || vg.turn() !== playerColor) return false;
    let result;
    try { result = vg.move(move); } catch { return false; }
    if (!result) return false;
    vg.onSubMoveComplete();
    playMoveSound(result);
    setLastMove({ from: result.from, to: result.to });
    syncState();
    if (checkEnd()) return true;

    const left = playerMovesLeft - 1;
    if (left > 0 && !vg.shouldEndSequence()) {
      setPlayerMovesLeft(left);
      return true;
    }

    vg.onTurnEnd();
    setPlayerMovesLeft(0);
    setTimeout(() => doBotMove(), 50);
    return true;
  }, [gameOver, vg, playerColor, syncState, checkEnd, doBotMove, playerMovesLeft]);

  const handleResign = useCallback(() => {
    const result = playerColor === "w" ? "0-1" : "1-0";
    endGame(result, "resignation", false);
  }, [playerColor, endGame]);

  const pgn = useMemo(() => {
    const moves = vg.pgn();
    const result = gameOver?.result || "*";
    return `[Event "oChess ${vg.def.name}"]\n[Variant "${vg.def.name}"]\n[Result "${result}"]\n\n${moves} ${result}`;
  }, [history.length, gameOver, vg]);

  const downloadPgn = useCallback(() => {
    const blob = new Blob([pgn], { type: "application/x-chess-pgn" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `ochess-${vg.def.name.toLowerCase().replace(/\s+/g, "-")}.pgn`;
    a.click(); URL.revokeObjectURL(url);
  }, [pgn, vg]);

  const highlightSquares = useMemo(() => {
    const sq = {};
    if (selectedPly && history[selectedPly - 1]) {
      const m = history[selectedPly - 1];
      sq[m.from] = { backgroundColor: "rgba(59,130,246,0.2)" };
      sq[m.to] = { backgroundColor: "rgba(59,130,246,0.3)" };
    } else if (lastMove) {
      sq[lastMove.from] = { backgroundColor: "rgba(255,255,255,0.07)" };
      sq[lastMove.to] = { backgroundColor: "rgba(255,255,255,0.11)" };
    }
    if (variantId === "kingOfTheHill") {
      for (const s of vg.getHillSquares()) {
        sq[s] = { ...(sq[s] || {}), boxShadow: "inset 0 0 0 2px rgba(255,215,0,0.25)" };
      }
    }
    return sq;
  }, [selectedPly, history, lastMove, variantId, vg]);

  const displayFen = useMemo(() => {
    if (selectedPly && selectedPly <= history.length) {
      const temp = new Chess(vg.startFen);
      for (let i = 0; i < selectedPly; i++) temp.move(history[i].san);
      return temp.fen();
    }
    if (vg.isFogOfWar() && !gameOver) return vg.getMaskedFen(playerColor);
    return fen;
  }, [selectedPly, history, fen, vg, playerColor, gameOver]);

  const checks = variantId === "threeCheck" ? vg.getCheckCounts() : null;

  const movePairs = [];
  for (let i = 0; i < history.length; i += 2) {
    movePairs.push({ num: Math.floor(i / 2) + 1, white: history[i], black: history[i + 1] || null });
  }

  return (
    <div className="flex min-h-[calc(100dvh-4rem)]">
      <div className="flex-1 min-w-0 px-4 sm:px-6 md:px-10 xl:px-6 py-3 sm:py-4 w-full mx-auto max-w-[1400px] xl:max-w-[1500px] 2xl:max-w-[1600px]">
        <div className="flex flex-col xl:flex-row gap-4 xl:gap-6">

          {/* Board column - scales with viewport breakpoint. */}
          <div className="flex-1 flex flex-col items-center xl:items-start max-w-[760px] xl:max-w-[920px] 2xl:max-w-[1040px]">
            {/* Opponent bar */}
            <div className="w-full flex items-center gap-3 mb-1 px-1">
              <div className="w-8 h-8 rounded-full bg-surface-high flex items-center justify-center">
                <span className="font-headline text-[10px] font-bold text-on-surface-variant/50 uppercase">{opponent.name[0]}</span>
              </div>
              <span className="font-headline text-sm font-bold text-on-surface-variant/60">{opponent.name}</span>
              <span className="text-[11px] text-on-surface-variant/30">{opponent.rating}</span>
              {checks && (
                <span className="text-[11px] font-mono font-bold text-error/60 ml-auto">
                  Checks: {playerColor === "w" ? checks.black : checks.white}/3
                </span>
              )}
            </div>

            <div className="w-full mx-auto" style={{ maxWidth: "min(100%, calc(100dvh - 11rem))" }}>
              <InteractiveBoard
                fen={displayFen}
                onMove={handleMove}
                orientation={playerColor === "w" ? "white" : "black"}
                interactive={!gameOver && !selectedPly}
                highlightSquares={highlightSquares}
                playerColor={playerColor}
              />
            </div>

            {/* Player bar */}
            <div className="w-full flex items-center gap-3 mt-1 px-1">
              <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                <span className="font-headline text-[10px] font-bold text-primary uppercase">Y</span>
              </div>
              <span className="font-headline text-sm font-bold text-on-surface-variant/70">You</span>
              {checks && (
                <span className="text-[11px] font-mono font-bold text-error/60 ml-auto">
                  Checks: {playerColor === "w" ? checks.white : checks.black}/3
                </span>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div className="w-full xl:w-[320px] shrink-0 flex flex-col gap-3">
            {/* Variant badge + status */}
            <div className="bg-surface-container border border-white/[0.04] px-3 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-headline text-xs font-bold uppercase tracking-widest text-primary/70">{vg.def.name}</span>
                {vg.isMultiMove() && !gameOver && !botThinking && playerMovesLeft > 1 && (
                  <span className="text-[10px] font-mono font-bold text-emerald-400 tabular-nums">{playerMovesLeft} moves left</span>
                )}
                {vg.isFogOfWar() && !gameOver && (
                  <span className="text-[9px] text-on-surface-variant/25">Hidden board</span>
                )}
              </div>
              {botThinking && (
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 border border-primary/30 border-t-primary rounded-full animate-spin" />
                  <span className="text-[10px] text-on-surface-variant/30">Thinking...</span>
                </div>
              )}
            </div>

            {/* Game over */}
            {gameOver && (
              <div className="bg-surface-container border border-white/[0.04] p-4">
                <h2 className="font-headline text-xl font-extrabold tracking-tight text-on-surface mb-1">
                  {gameOver.won === true ? "You win!" : gameOver.won === false ? "You lost" : "Draw"}
                </h2>
                <p className="text-[12px] text-on-surface-variant/40 capitalize mb-3">{gameOver.reason}</p>
                <div className="flex gap-2">
                  <button onClick={() => navigate("/variants")} className="flex-1 py-2 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary transition-colors">
                    Back
                  </button>
                  <button onClick={() => { navigator.clipboard.writeText(pgn); setPgnCopied(true); setTimeout(() => setPgnCopied(false), 2000); }}
                    className={`flex-1 py-2 font-headline text-[10px] font-bold uppercase tracking-wide transition-colors ${pgnCopied ? "bg-emerald-500/20 text-emerald-400" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary"}`}>
                    {pgnCopied ? "Copied!" : "Copy PGN"}
                  </button>
                  <button onClick={downloadPgn} className="flex-1 py-2 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary transition-colors">
                    Download
                  </button>
                </div>
              </div>
            )}

            {/* Bot chat */}
            {botChat.length > 0 && (
              <div className="bg-surface-container border border-white/[0.04] p-3">
                <span className="text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/30 block mb-1">{opponent.name}</span>
                {botChat.slice(-3).map((msg, i) => (
                  <p key={i} className="text-[12px] text-on-surface-variant/50 leading-relaxed">{msg.text}</p>
                ))}
              </div>
            )}

            {/* Controls */}
            {!gameOver && (
              <button onClick={handleResign}
                className="py-2.5 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-error hover:border-error/20 transition-colors">
                Resign
              </button>
            )}

            {/* Move list */}
            <div className="bg-surface-low flex flex-col flex-1 min-h-0">
              <div className="p-3 flex justify-between items-center border-b border-white/[0.03] shrink-0">
                <h2 className="font-headline text-[11px] font-bold uppercase tracking-widest text-on-surface-variant/40">Moves</h2>
                <span className="text-[11px] text-on-surface-variant/20 tabular-nums">{history.length}</span>
              </div>
              <div className="overflow-y-auto flex-1 max-h-[300px]">
                {movePairs.map((m, i) => {
                  const wPly = i * 2 + 1;
                  const bPly = i * 2 + 2;
                  return (
                    <div key={m.num} className={`grid text-[12px] ${i % 2 === 0 ? "bg-surface-lowest/40" : ""}`} style={{ gridTemplateColumns: "1.6rem 1fr 1fr" }}>
                      <span className="text-[10px] text-on-surface-variant/20 self-center px-1 py-1.5">{m.num}.</span>
                      <button onClick={() => { setSelectedPly(selectedPly === wPly ? null : wPly); }}
                        className={`font-mono text-left py-1 px-1 transition-colors hover:bg-primary/10 ${selectedPly === wPly ? "bg-primary/15 text-primary font-bold" : "text-on-surface-variant/70"}`}>
                        {m.white?.san}
                      </button>
                      {m.black ? (
                        <button onClick={() => { setSelectedPly(selectedPly === bPly ? null : bPly); }}
                          className={`font-mono text-left py-1 px-1 transition-colors hover:bg-primary/10 ${selectedPly === bPly ? "bg-primary/15 text-primary font-bold" : "text-on-surface-variant/45"}`}>
                          {m.black.san}
                        </button>
                      ) : <span />}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Back to live */}
            {selectedPly && (
              <button onClick={() => { setSelectedPly(null); setFen(vg.fen()); }}
                className="py-1.5 bg-primary/10 border border-primary/20 font-headline text-[10px] font-bold uppercase tracking-wide text-primary hover:bg-primary/20 transition-colors">
                Back to live
              </button>
            )}
          </div>
        </div>
      </div>
      <SocialPanel />
    </div>
  );
}
