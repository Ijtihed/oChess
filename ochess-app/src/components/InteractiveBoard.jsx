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
// Crazy Arena Ship #2.5: ability targets render as a distinct red
// crosshair so players can tell "cast ability" from "move piece" at
// a glance. The crosshair is a layered radial-gradient: outer ring
// + small inner dot in the same brand-red tone.
const ABILITY_TARGET_BG =
  "radial-gradient(circle, transparent 40%, rgba(239,68,68,0.55) 41%, rgba(239,68,68,0.55) 47%, transparent 48%)," +
  "radial-gradient(circle, rgba(239,68,68,0.85) 18%, transparent 19%)";
const ABILITY_TARGET_BG_CAPTURE =
  "radial-gradient(circle, transparent 40%, rgba(239,68,68,0.7) 41%, rgba(239,68,68,0.7) 47%, transparent 48%)," +
  "radial-gradient(circle, rgba(239,68,68,0.95) 22%, transparent 23%)";

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
  arrows: externalArrows = [],
  rightClickSquares: externalRightClickSquares,
  onRightClickSquaresChange,
  allowDrawingArrows = true,
  onBoardClick,
  squareAnnotation,
  // Optional override for legal-move hints. When provided, the
  // board uses this to compute the dot-hint targets instead of
  // chess.js's `moves({ square, verbose: true })`. The override
  // receives the source square and must return an array of
  // { to, captured? } objects (matching the shape chess.js
  // produces). Used by AI Arena to honor variant rules - chess.js
  // doesn't know about "no castling" / "reverse pawns" / etc., so
  // its hints would be wildly wrong without this hook.
  legalMovesProvider,
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
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const [localRightClickSq, setLocalRightClickSq] = useState({});

  const rightClickSq = externalRightClickSquares ?? localRightClickSq;
  const setRightClickSq = onRightClickSquaresChange ?? setLocalRightClickSq;

  useEffect(() => {
    setSelectedSq(null);
    setLegalTargets([]);
  }, [fen]);

  const RC_COLORS = useMemo(() => ["rgba(235,97,80,0.8)", "rgba(82,176,220,0.8)", "rgba(172,206,89,0.8)", "rgba(218,174,74,0.8)"], []);

  const handleRightClick = useCallback(({ square }) => {
    setRightClickSq((prev) => {
      const copy = { ...prev };
      if (copy[square]) { delete copy[square]; return copy; }
      const usedColors = new Set(Object.values(copy));
      const color = RC_COLORS.find((c) => !usedColors.has(c)) || RC_COLORS[0];
      copy[square] = color;
      return copy;
    });
  }, [setRightClickSq, RC_COLORS]);

  const rightClickSqRef = useRef(rightClickSq);
  rightClickSqRef.current = rightClickSq;

  const clearAnnotations = useCallback(() => {
    if (Object.keys(rightClickSqRef.current).length > 0) setRightClickSq({});
  }, [setRightClickSq]);

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
        // Variant rules go through the provider when supplied;
        // otherwise fall back to chess.js's standard-rules
        // move enumerator. The provider must return objects
        // matching `{ to, captured? }` so the hint-rendering
        // code below can stay agnostic about the source.
        const moves = typeof legalMovesProvider === "function"
          ? legalMovesProvider(square) || []
          : chess.moves({ square, verbose: true });
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
  }, [chess, interactive, flashIllegal, isPlayerTurn, playerColor, legalMovesProvider]);

  const onBoardClickRef = useRef(onBoardClick);
  onBoardClickRef.current = onBoardClick;

  const handleSquareClick = useCallback(({ square }) => {
    clearAnnotations();
    if (onBoardClickRef.current) onBoardClickRef.current(square);
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
          // Crazy Arena Ship #2.5: forward `kind` and `abilityId`
          // so the engine routes the cast through applyAbilityMove
          // rather than treating it as a regular move from
          // selectedSq -> square.
          const movePayload = {
            from: selectedSq,
            to: square,
            promotion: promo,
            ...(target.kind ? { kind: target.kind } : {}),
            ...(target.abilityId ? { abilityId: target.abilityId } : {}),
          };
          const ok = onMove(movePayload);
          // For ability casts the chess.js sound preview won't
          // recognize the move (chess.js doesn't know our
          // primitives), so skip that preview - the engine plays
          // the right sound through the normal flow.
          if (ok && !target.kind) soundForMove(selectedSq, square, promo);
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
  }, [interactive, onMove, selectedSq, legalTargets, selectSquare, chess, flashIllegal, soundForMove, isPlayerTurn, playerColor, clearAnnotations]);

  const handleDrag = useCallback(({ square }) => {
    selectSquare(square);
  }, [selectSquare]);

  const canDrag = useCallback(({ piece }) => {
    if (!interactive) return false;
    const pt = typeof piece === "string" ? piece : (piece?.pieceType || piece?.type || "");
    const color = pt[0]?.toLowerCase() === "b" ? "b" : "w";
    return color === playerColor;
  }, [interactive, playerColor]);

  const handleDrop = useCallback(({ sourceSquare, targetSquare, piece }) => {
    if (!interactive || !onMove) return false;
    setSelectedSq(null);
    setLegalTargets([]);

    // User picked a piece up and dropped it back where it was
    // (or never actually moved it). That's a "I changed my mind"
    // gesture, NOT an attempted move - never flash red, never
    // call onMove, never play the error sound. The previous
    // version sent a from===to move to handleMove, which compared
    // unequal to the expected move and tripped the wrong-attempt
    // banner on Anki cards.
    if (sourceSquare === targetSquare) return false;

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

    for (const [sq, color] of Object.entries(rightClickSq)) {
      styles[sq] = { ...(styles[sq] || {}), backgroundColor: color };
    }

    if (premoveSquares) {
      styles[premoveSquares.from] = { ...(styles[premoveSquares.from] || {}), backgroundColor: PREMOVE_SQ };
      styles[premoveSquares.to] = { ...(styles[premoveSquares.to] || {}), backgroundColor: PREMOVE_SQ };
    }

    if (selectedSq) {
      const isSqPremove = !isPlayerTurn;
      const bg = isSqPremove ? PREMOVE_SQ : "rgba(255,255,255,0.35)";
      styles[selectedSq] = { ...(styles[selectedSq] || {}), backgroundColor: bg };
      for (const m of legalTargets) {
        if (m.kind === "ability") {
          // Ship #2.5: ability targets get the red crosshair, not
          // the standard dot. Captures inside an ability still get
          // the slightly punchier capture variant.
          styles[m.to] = {
            ...(styles[m.to] || {}),
            backgroundImage: m.captured ? ABILITY_TARGET_BG_CAPTURE : ABILITY_TARGET_BG,
          };
        } else if (m.captured) {
          styles[m.to] = { ...(styles[m.to] || {}), backgroundColor: CAPTURE_BG };
        } else {
          styles[m.to] = { ...(styles[m.to] || {}), backgroundImage: DOT };
        }
      }
    }
    if (illegalFlash) {
      styles[illegalFlash] = { ...(styles[illegalFlash] || {}), backgroundColor: "rgba(239,68,68,0.45)" };
    }
    return styles;
  }, [highlightSquares, selectedSq, legalTargets, illegalFlash, premoveSquares, isPlayerTurn, rightClickSq]);

  const notationStyle = { fontSize: "clamp(7px, 1.4vw, 11px)", fontWeight: 600, color: "#666666", opacity: 1 };

  const allArrows = externalArrows;

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
    canDragPiece: canDrag,
    allowDrawingArrows,
    arrows: allArrows,
    onSquareRightClick: handleRightClick,
    clearArrowsOnClick: true,
    clearArrowsOnPositionChange: true,
    showNotation: true,
    alphaNotationStyle: notationStyle,
    numericNotationStyle: notationStyle,
    onPieceDrop: handleDrop,
    onSquareClick: handleSquareClick,
    onPieceDrag: handleDrag,
  }), [fen, orientation, pieces, sqStyles, interactive, handleDrop, handleSquareClick, handleDrag, canDrag, boardTheme, isImageBoard, allArrows, handleRightClick, allowDrawingArrows]);

  const badge = useMemo(() => {
    if (!squareAnnotation) return null;
    const { square, glyph, bg, text } = squareAnnotation;
    if (!square || !glyph || !/^[a-h][1-8]$/.test(square)) return null;
    const file = square.charCodeAt(0) - 97;
    const rank = parseInt(square[1]) - 1;
    const col = orientation === "white" ? file : 7 - file;
    const row = orientation === "white" ? 7 - rank : rank;
    const left = (col + 1) * 12.5;
    const top = row * 12.5;
    return { left: `${left}%`, top: `${top}%`, glyph, bg, text };
  }, [squareAnnotation, orientation]);

  return (
    <div className={`w-full relative ${className}`}>
      <Chessboard options={boardOptions} />
      {badge && (
        <div
          style={{
            position: "absolute",
            left: badge.left,
            top: badge.top,
            backgroundColor: badge.bg,
            color: badge.text,
            fontSize: "clamp(9px, 1.5vw, 13px)",
            fontWeight: 800,
            lineHeight: 1,
            padding: "2px 4px",
            borderRadius: "3px",
            pointerEvents: "none",
            zIndex: 50,
            transform: "translate(-50%, -50%)",
            boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
            whiteSpace: "nowrap",
            fontFamily: "monospace",
          }}
        >
          {badge.glyph}
        </div>
      )}
    </div>
  );
}
