import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import { playMoveSound, playError } from "../lib/sounds";

const DEFAULT_PIECE_SET = "cburnett";

function buildPieces(pieceSet) {
  const pieces = {};
  const names = ["wP", "wN", "wB", "wR", "wQ", "wK", "bP", "bN", "bB", "bR", "bQ", "bK"];
  for (const name of names) {
    pieces[name] = () => (
      <img
        src={`/piece/${pieceSet}/${name}.svg`}
        alt={name}
        style={{ width: "100%", height: "100%", position: "relative", zIndex: 2 }}
        draggable={false}
      />
    );
  }
  return pieces;
}

const DOT = "radial-gradient(circle, rgba(255,255,255,0.22) 24%, transparent 25%)";
const CAPTURE_BG = "rgba(255,255,255,0.18)";

export default function InteractiveBoard({
  fen,
  onMove,
  orientation = "white",
  pieceSet = DEFAULT_PIECE_SET,
  interactive = true,
  highlightSquares = {},
  className = "",
}) {
  const [selectedSq, setSelectedSq] = useState(null);
  const [legalTargets, setLegalTargets] = useState([]);
  const [illegalFlash, setIllegalFlash] = useState(null);
  const flashTimer = useRef(null);

  useEffect(() => {
    setSelectedSq(null);
    setLegalTargets([]);
  }, [fen]);

  const pieces = useMemo(() => buildPieces(pieceSet), [pieceSet]);

  const flashIllegal = useCallback((square) => {
    clearTimeout(flashTimer.current);
    setIllegalFlash(square);
    flashTimer.current = setTimeout(() => setIllegalFlash(null), 400);
  }, []);

  const soundForMove = useCallback((from, to, promotion) => {
    try {
      const chess = new Chess(fen);
      const result = chess.move({ from, to, promotion });
      if (result) playMoveSound(result);
    } catch {}
  }, [fen]);

  const selectSquare = useCallback((square) => {
    if (!interactive) return;
    try {
      const chess = new Chess(fen);
      const piece = chess.get(square);
      if (piece && piece.color === chess.turn()) {
        const moves = chess.moves({ square, verbose: true });
        if (moves.length === 0) {
          playError();
          flashIllegal(square);
          return;
        }
        setSelectedSq(square);
        setLegalTargets(moves);
        return;
      }
    } catch {}
    setSelectedSq(null);
    setLegalTargets([]);
  }, [fen, interactive, flashIllegal]);

  const handleSquareClick = useCallback(({ square }) => {
    if (!interactive || !onMove) return;

    if (selectedSq) {
      if (square === selectedSq) {
        setSelectedSq(null);
        setLegalTargets([]);
        return;
      }

      const target = legalTargets.find((m) => m.to === square);
      if (target) {
        const promo = target.promotion ? "q" : undefined;
        const ok = onMove({ from: selectedSq, to: square, promotion: promo });
        if (ok) soundForMove(selectedSq, square, promo);
        setSelectedSq(null);
        setLegalTargets([]);
        if (ok) return;
      }

      try {
        const chess = new Chess(fen);
        const clickedPiece = chess.get(square);
        if (clickedPiece && clickedPiece.color === chess.turn()) {
          selectSquare(square);
          return;
        }
      } catch {}

      playError();
      flashIllegal(square);
      return;
    }

    selectSquare(square);
  }, [interactive, onMove, selectedSq, legalTargets, selectSquare, fen, flashIllegal, soundForMove]);

  const handleDrag = useCallback(({ square }) => {
    selectSquare(square);
  }, [selectSquare]);

  const handleDrop = useCallback(({ sourceSquare, targetSquare, piece }) => {
    if (!interactive || !onMove) return false;
    setSelectedSq(null);
    setLegalTargets([]);
    const promotion = piece[1] === "P" && (targetSquare[1] === "8" || targetSquare[1] === "1") ? "q" : undefined;
    const ok = onMove({ from: sourceSquare, to: targetSquare, promotion });
    if (ok) soundForMove(sourceSquare, targetSquare, promotion);
    else playError();
    return ok;
  }, [interactive, onMove, soundForMove]);

  const sqStyles = useMemo(() => {
    const styles = { ...highlightSquares };
    if (selectedSq) {
      styles[selectedSq] = { ...(styles[selectedSq] || {}), backgroundColor: "rgba(255,255,255,0.35)" };
      for (const m of legalTargets) {
        styles[m.to] = {
          ...(styles[m.to] || {}),
          background: m.captured ? undefined : DOT,
          backgroundColor: m.captured ? CAPTURE_BG : undefined,
        };
      }
    }
    if (illegalFlash) {
      styles[illegalFlash] = { ...(styles[illegalFlash] || {}), backgroundColor: "rgba(239,68,68,0.45)" };
    }
    return styles;
  }, [highlightSquares, selectedSq, legalTargets, illegalFlash]);

  const boardOptions = useMemo(() => ({
    position: fen,
    boardOrientation: orientation,
    pieces,
    boardStyle: { borderRadius: "0px" },
    darkSquareStyle: { backgroundColor: "#272727" },
    lightSquareStyle: { backgroundColor: "#3e3e3e" },
    squareStyles: sqStyles,
    animationDurationInMs: 200,
    allowDragging: interactive,
    showNotation: true,
    onPieceDrop: handleDrop,
    onSquareClick: handleSquareClick,
    onPieceDrag: handleDrag,
  }), [fen, orientation, pieces, sqStyles, interactive, handleDrop, handleSquareClick, handleDrag]);

  return (
    <div className={`w-full ${className}`}>
      <Chessboard options={boardOptions} />
    </div>
  );
}
