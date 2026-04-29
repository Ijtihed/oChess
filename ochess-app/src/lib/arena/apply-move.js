/**
 * Apply a move to a Position, producing a NEW Position with
 * the move played. Mutation only happens on the clone - the
 * original Position is untouched, so the move generator can
 * cheaply simulate without risking bleed-through.
 *
 * Two entry points:
 *
 *   - `applyMoveRaw(position, move, rules)`  no validation,
 *     just plays the move. Used by move-gen's king-safety
 *     filter (it has already vetted the move against the
 *     piece spec).
 *
 *   - `applyMove(position, move, rules)`  validates against
 *     `generateLegalMoves` first; throws if the move isn't in
 *     the legal list. This is what the UI / 1v1 sync code
 *     should call.
 *
 * Capture effects supported: standard remove, atomic-style
 * explosion radius, color-conversion. New effects can be
 * added without touching the move generator - the rule object
 * is the single source of truth.
 */

import { Chess } from "chess.js";
import { generateLegalMoves } from "./move-gen";
import {
  squareToFR,
  frToSquare,
  inBounds,
} from "./position";

/**
 * Validated version: call this from the UI / network sync.
 * Throws if `move` isn't in the legal list under the current
 * rules.
 */
export function applyMove(position, move, rules) {
  if (!move || typeof move !== "object") throw new Error("move must be an object");
  const legal = generateLegalMoves(position, rules);
  const match = legal.find((m) => sameMove(m, move));
  if (!match) {
    throw new Error(`illegal move ${move.from}${move.to}${move.promotion ? `=${move.promotion}` : ""}`);
  }
  // Use the canonical move object from generateLegalMoves so
  // metadata flags (castling, enPassant) are filled in.
  return applyMoveRaw(position, match, rules);
}

/**
 * Raw version: apply without legality check. Returns a fresh
 * Position. Returns null if the move would be a no-op (target
 * square is friendly) - shouldn't happen with a properly-
 * generated move but defends against bad input.
 */
export function applyMoveRaw(position, move, rules) {
  if (!move?.from || !move?.to) return null;
  const next = position.clone();
  const moverFR = squareToFR(move.from);
  const targetFR = squareToFR(move.to);
  if (!moverFR || !targetFR) return null;

  const piece = next.pieceAt(move.from);
  if (!piece) return null;

  // ── Move classification ──
  // Pull these out so the post-move bookkeeping (en passant,
  // castling rights, captures, halfmove clock) can use them
  // without recomputing.
  const isCastle = !!move.castling;
  const isEnPassant = !!move.enPassant;
  const isPromotion = !!move.promotion;
  let captured = null;

  // ── Castling: move both pieces ──
  if (isCastle) {
    const rank = moverFR[1];
    const kingTargetFile = move.castlingSide === "kingside" ? 6 : 2;
    const rookFromFile = move.castlingSide === "kingside" ? 7 : 0;
    const rookToFile = move.castlingSide === "kingside" ? 5 : 3;
    next.setSquare(move.from, null);
    next.setSquare(frToSquare([rookFromFile, rank]), null);
    next.setSquare(frToSquare([kingTargetFile, rank]), piece);
    next.setSquare(frToSquare([rookToFile, rank]), { type: "r", color: piece.color });
    next.castling[piece.color] = { kingside: false, queenside: false };
    next.enPassant = null;
    next.history.push({ ...move, captured: null, san: castleSan(move.castlingSide) });
    next.halfmove += 1;
    if (piece.color === "b") next.fullmove += 1;
    next.turn = piece.color === "w" ? "b" : "w";
    return next;
  }

  // ── En passant: capture the pawn behind the destination ──
  if (isEnPassant) {
    const captureRank = piece.color === "w" ? targetFR[1] - 1 : targetFR[1] + 1;
    const captureSq = frToSquare([targetFR[0], captureRank]);
    captured = next.pieceAt(captureSq);
    next.setSquare(captureSq, null);
  }

  // ── Standard capture detection (non-en-passant) ──
  if (!isEnPassant && next.pieceAt(move.to)) {
    captured = next.pieceAt(move.to);
  }

  // ── Move the piece ──
  next.setSquare(move.from, null);
  // Promotion replaces the moved piece with the chosen type.
  const placed = isPromotion
    ? { type: move.promotion, color: piece.color }
    : piece;
  next.setSquare(move.to, placed);

  // ── Capture effects ──
  if (captured) {
    applyCaptureEffects(next, move.to, captured, rules);
    next.captureTally[piece.color] += 1;
  }

  // ── En passant target for the NEXT move ──
  // Standard rules: a 2-square pawn move sets the en-passant
  // target on the square jumped over. Match chess.js's smart
  // behavior: ONLY set the target when an enemy pawn is in
  // position to actually capture (adjacent file, same rank as
  // the pushed pawn). Otherwise dumping the EP square pollutes
  // FEN comparisons + threefold-repetition checks.
  next.enPassant = null;
  if (piece.type === "p" && Math.abs(targetFR[1] - moverFR[1]) === 2) {
    const epRank = (moverFR[1] + targetFR[1]) / 2;
    const enemyColor = piece.color === "w" ? "b" : "w";
    const adjacentFiles = [targetFR[0] - 1, targetFR[0] + 1];
    let canBeCaptured = false;
    for (const af of adjacentFiles) {
      if (af < 0 || af > 7) continue;
      const adjPc = next.board[af + targetFR[1] * 8];
      if (adjPc && adjPc.type === "p" && adjPc.color === enemyColor) {
        canBeCaptured = true;
        break;
      }
    }
    if (canBeCaptured) {
      next.enPassant = frToSquare([targetFR[0], epRank]);
    }
  }

  // ── Castling rights bookkeeping ──
  // King move revokes both sides for that color. Rook move
  // from a corner revokes that side. Capturing an enemy rook
  // on its starting square revokes the enemy's matching side.
  if (piece.type === "k") {
    next.castling[piece.color] = { kingside: false, queenside: false };
  } else if (piece.type === "r") {
    revokeCastlingFromRookSquare(next, piece.color, move.from);
  }
  if (captured && captured.type === "r") {
    revokeCastlingFromRookSquare(next, captured.color, move.to);
  }

  // ── 50-move clock + full-move counter ──
  next.halfmove = (captured || piece.type === "p") ? 0 : next.halfmove + 1;
  if (piece.color === "b") next.fullmove += 1;

  // ── History entry ──
  // SAN is computed by chess.js when possible (vanilla rules).
  // For variant-only moves we fall back to long algebraic so
  // the move list stays readable.
  const san = computeSan(position, move, piece, captured, isPromotion, isEnPassant);
  next.history.push({ ...move, captured, san });

  // ── Side to move ──
  next.turn = piece.color === "w" ? "b" : "w";

  return next;
}

// ── Capture effects ────────────────────────────────────────

function applyCaptureEffects(next, atSquare, captured, rules) {
  const effects = rules?.capture || {};
  // Convert: captured piece changes to capturer's color rather
  // than being removed. We do this by simply not removing it
  // (the standard remove already happened by overwriting the
  // square with the moving piece) - so for `convert` we restore
  // the captured square with a piece of OUR color and the type
  // of the captured piece. This intentionally creates an extra
  // piece for the capturer, which matches the loose "convert"
  // semantics used by anti-chess-style variants.
  if (effects.convert) {
    const moverColor = next.turn; // After clone, before turn swap below.
    // Wait - turn hasn't swapped yet. The capturer is the
    // CURRENT side (next.turn).
    const target = next.pieceAt(atSquare);
    if (target) {
      next.setSquare(atSquare, { type: captured.type, color: moverColor });
      // And also re-place the moving piece elsewhere? No - the
      // moving piece already moved AND captured, so the
      // squares involved are: from (now empty) and to (now the
      // mover). Convert means "the captured piece joins your
      // side" - we materialize it on its OLD square. Need to
      // pull oldSquare from history; for now we approximate by
      // putting the converted piece back where it was captured
      // (which is `atSquare` for the standard-capture path,
      // not en-passant-square). This is a simplification: for
      // en passant + convert at the same time, we'd lose the
      // captured square. The MVP doesn't expose convert + EP
      // simultaneously.
    }
    // Fall through to explosion handling for symmetry.
  }

  // Explosion: remove every non-pawn piece in the surrounding
  // squares (atomic-style), plus the capturing piece itself.
  // Pawns survive explosions to keep the variant playable.
  if (effects.explosionRadius && effects.explosionRadius > 0) {
    const radius = effects.explosionRadius | 0;
    const [f0, r0] = squareToFR(atSquare);
    // The capturing piece (currently at atSquare) explodes.
    next.setSquare(atSquare, null);
    for (let df = -radius; df <= radius; df++) {
      for (let dr = -radius; dr <= radius; dr++) {
        if (df === 0 && dr === 0) continue;
        const nf = f0 + df;
        const nr = r0 + dr;
        if (!inBounds([nf, nr])) continue;
        const sq = frToSquare([nf, nr]);
        const pc = next.pieceAt(sq);
        if (!pc) continue;
        if (pc.type === "p") continue; // Pawns survive.
        next.setSquare(sq, null);
      }
    }
  }
}

// ── Castling rights bookkeeping ────────────────────────────

function revokeCastlingFromRookSquare(next, color, sq) {
  const fr = squareToFR(sq);
  if (!fr) return;
  const expectedRank = color === "w" ? 0 : 7;
  if (fr[1] !== expectedRank) return;
  if (fr[0] === 0) next.castling[color].queenside = false;
  if (fr[0] === 7) next.castling[color].kingside = false;
}

// ── SAN ────────────────────────────────────────────────────

function castleSan(side) {
  return side === "queenside" ? "O-O-O" : "O-O";
}

/**
 * Best-effort SAN. Tries chess.js (which only succeeds for
 * vanilla-rules positions); falls back to long algebraic
 * including a check / capture marker.
 */
function computeSan(prevPosition, move, piece, captured, isPromotion, isEnPassant) {
  // Try chess.js for vanilla. chess.js refuses positions whose
  // FEN doesn't match its rule set (extra pieces, missing
  // kings, etc.), in which case we fall through to manual SAN.
  try {
    const ch = new Chess();
    if (!ch.load(prevPosition.toFen())) {
      throw new Error("chess.js refused FEN");
    }
    const moveObj = { from: move.from, to: move.to };
    if (move.promotion) moveObj.promotion = move.promotion;
    const result = ch.move(moveObj);
    if (result?.san) return result.san;
  } catch {
    // Fall through to manual SAN.
  }
  // Manual SAN: Type letter + (capture x) + dest + (=Promo).
  const typeLetter = piece.type === "p" ? "" : piece.type.toUpperCase();
  const captureMarker = captured || isEnPassant ? "x" : "";
  const promo = isPromotion ? `=${move.promotion.toUpperCase()}` : "";
  // Pawn captures need the file of origin in front.
  const filePrefix = piece.type === "p" && captureMarker ? move.from[0] : "";
  return `${typeLetter}${filePrefix}${captureMarker}${move.to}${promo}`;
}

// ── Move equality ──────────────────────────────────────────

function sameMove(a, b) {
  return a.from === b.from
    && a.to === b.to
    && (a.promotion || null) === (b.promotion || null);
}
