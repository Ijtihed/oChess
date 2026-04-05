import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import { playMoveSound, playError } from "../lib/sounds";
import { load as loadPrefs, getTheme } from "../lib/board-prefs";

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
const PREMOVE_SQ = "rgba(59,130,246,0.30)";

export default function InteractiveBoard({
  fen,
  onMove,
  orientation = "white",
  pieceSet: pieceSetProp,
  interactive = true,
  highlightSquares = {},
  premoveSquares,
  playerColor = "w",
  className = "",
}) {
  const [prefs, setPrefs] = useState(loadPrefs);
  const pieceSet = pieceSetProp || prefs.pieceSet;
  const boardTheme = getTheme(prefs.boardTheme);

  useEffect(() => {
    const handler = () => setPrefs(loadPrefs());
    window.addEventListener("ochess-prefs-changed", handler);
    return () => window.removeEventListener("ochess-prefs-changed", handler);
  }, []);

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

  const chess = useMemo(() => {
    try { return new Chess(fen); } catch { return new Chess(); }
  }, [fen]);

  const isPlayerTurn = chess.turn() === playerColor;

  const selectSquare = useCallback((square) => {
    if (!interactive) return;
    const piece = chess.get(square);

    if (isPlayerTurn) {
      if (piece && piece.color === playerColor) {
        const moves = chess.moves({ square, verbose: true });
        if (moves.length === 0) { playError(); flashIllegal(square); return; }
        setSelectedSq(square);
        setLegalTargets(moves);
        return;
      }
    } else {
      if (piece && piece.color === playerColor) {
        setSelectedSq(square);
        setLegalTargets([]);
        return;
      }
    }
    setSelectedSq(null);
    setLegalTargets([]);
  }, [chess, interactive, flashIllegal, isPlayerTurn, playerColor]);

  const handleSquareClick = useCallback(({ square }) => {
    if (!interactive || !onMove) return;

    if (selectedSq) {
      if (square === selectedSq) {
        setSelectedSq(null);
        setLegalTargets([]);
        return;
      }

      if (isPlayerTurn) {
        const target = legalTargets.find((m) => m.to === square);
        if (target) {
          const promo = target.promotion ? "q" : undefined;
          const ok = onMove({ from: selectedSq, to: square, promotion: promo });
          if (ok) soundForMove(selectedSq, square, promo);
          setSelectedSq(null);
          setLegalTargets([]);
          if (ok) return;
        }
      } else {
        const srcPiece = chess.get(selectedSq);
        if (srcPiece && srcPiece.color === playerColor) {
          const isPromo = srcPiece.type === "p" && (square[1] === "8" || square[1] === "1");
          onMove({ from: selectedSq, to: square, promotion: isPromo ? "q" : undefined });
          setSelectedSq(null);
          setLegalTargets([]);
          return;
        }
      }

      const clickedPiece = chess.get(square);
      if (clickedPiece && clickedPiece.color === (isPlayerTurn ? chess.turn() : playerColor)) {
        selectSquare(square);
        return;
      }

      if (isPlayerTurn) { playError(); flashIllegal(square); }
      setSelectedSq(null);
      setLegalTargets([]);
      return;
    }

    selectSquare(square);
  }, [interactive, onMove, selectedSq, legalTargets, selectSquare, chess, flashIllegal, soundForMove, isPlayerTurn, playerColor]);

  const handleDrag = useCallback(({ square }) => {
    selectSquare(square);
  }, [selectSquare]);

  const handleDrop = useCallback(({ sourceSquare, targetSquare, piece }) => {
    if (!interactive || !onMove) return false;
    setSelectedSq(null);
    setLegalTargets([]);

    const pt = typeof piece === "string" ? piece : (piece?.pieceType || piece?.type || "");
    const pieceColor = pt[0]?.toLowerCase() === "b" ? "b" : "w";
    const pieceType = pt[1]?.toUpperCase() || "";
    const promotion = pieceType === "P" && (targetSquare[1] === "8" || targetSquare[1] === "1") ? "q" : undefined;

    if (isPlayerTurn) {
      const ok = onMove({ from: sourceSquare, to: targetSquare, promotion });
      if (ok) soundForMove(sourceSquare, targetSquare, promotion);
      else playError();
      return ok;
    } else {
      if (pieceColor === playerColor) {
        onMove({ from: sourceSquare, to: targetSquare, promotion });
      }
      return false;
    }
  }, [interactive, onMove, soundForMove, isPlayerTurn, playerColor]);

  const sqStyles = useMemo(() => {
    const styles = { ...highlightSquares };

    if (premoveSquares) {
      styles[premoveSquares.from] = { ...(styles[premoveSquares.from] || {}), backgroundColor: PREMOVE_SQ };
      styles[premoveSquares.to] = { ...(styles[premoveSquares.to] || {}), backgroundColor: PREMOVE_SQ };
    }

    if (selectedSq) {
      const isSqPremove = !isPlayerTurn;
      const bg = isSqPremove ? PREMOVE_SQ : "rgba(255,255,255,0.35)";
      styles[selectedSq] = { ...(styles[selectedSq] || {}), backgroundColor: bg };
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
  }, [highlightSquares, selectedSq, legalTargets, illegalFlash, premoveSquares, isPlayerTurn]);

  const notationStyle = { fontSize: "clamp(7px, 1.4vw, 11px)", fontWeight: 600, color: "#666666", opacity: 1 };

  const isImageBoard = boardTheme.type === "image";
  const boardOptions = useMemo(() => ({
    position: fen,
    boardOrientation: orientation,
    pieces,
    boardStyle: isImageBoard
      ? { borderRadius: "0px", backgroundImage: `url(${boardTheme.src})`, backgroundSize: "100% 100%" }
      : { borderRadius: "0px" },
    darkSquareStyle: isImageBoard ? { backgroundColor: "transparent" } : { backgroundColor: boardTheme.dark },
    lightSquareStyle: isImageBoard ? { backgroundColor: "transparent" } : { backgroundColor: boardTheme.light },
    dropSquareStyle: { boxShadow: "inset 0 0 0 2px rgba(255,255,255,0.15)" },
    squareStyles: sqStyles,
    animationDurationInMs: 200,
    allowDragging: interactive,
    showNotation: true,
    alphaNotationStyle: notationStyle,
    numericNotationStyle: notationStyle,
    onPieceDrop: handleDrop,
    onSquareClick: handleSquareClick,
    onPieceDrag: handleDrag,
  }), [fen, orientation, pieces, sqStyles, interactive, handleDrop, handleSquareClick, handleDrag, boardTheme, isImageBoard]);

  return (
    <div className={`w-full ${className}`}>
      <Chessboard options={boardOptions} />
    </div>
  );
}
