/**
 * Move generation for AI Arena.
 *
 * Drives off the structured rules object: every piece spec is a
 * list of move primitives (slide / leap / step), and the
 * generator produces every legal move by unioning their
 * outputs and then filtering anything that would leave / put
 * the friendly king in check (when checkmate is the active win
 * condition).
 *
 * White-relative direction conventions: every primitive's
 * `[df, dr]` tuple is from White's POV. For Black pieces we
 * negate `dr` so a step `[0, 1]` (forward for white) means
 * `[0, -1]` (forward for black) too.
 *
 * The generator depends only on:
 *   - `Position` for board state + tracking castling rights / en
 *     passant target,
 *   - the resolved Rules object for piece move specs and
 *     win-condition info (we only check king-safety when
 *     "checkmate" is in the win conditions).
 *
 * No mutation of Position - the generator either reads or
 * clones to simulate. apply-move.js is what actually plays
 * moves.
 */

import { pieceSpecFor } from "./rules";
import {
  squareToFR,
  frToSquare,
  inBounds,
  squareToIndex,
} from "./position";
import { applyMoveRaw } from "./apply-move";

// ── Public API ──────────────────────────────────────────────

/**
 * Generate every legal move for the side-to-move.
 *
 * "Legal" means:
 *   - the piece can produce the move per its rule spec, AND
 *   - the move doesn't leave the friendly king in check, when
 *     "checkmate" is in the active win conditions. For
 *     non-checkmate variants (like "capture_king" or
 *     "first_to_n_captures"), pseudo-legal moves are returned -
 *     leaving your king attacked is the LOSS, not illegal.
 *
 * @param {import("./position").Position} position
 * @param {import("./schema").Rules}     rules
 * @returns {import("./schema").Move[]}
 */
export function generateLegalMoves(position, rules) {
  const pseudo = generatePseudoMoves(position, rules);
  if (!hasCheckmateRule(rules)) return pseudo;
  // Filter out self-checks. A move is illegal under classical
  // rules iff playing it leaves your own king attacked.
  return pseudo.filter((mv) => !leavesOwnKingInCheck(position, mv, rules));
}

/**
 * Pseudo-legal move generation: every move the piece spec
 * permits, ignoring king-safety. Useful for the "is this
 * square attacked" check that king-safety filtering needs.
 *
 * `opts.excludeCastling` skips castling generation. Used by
 * `isSquareAttacked` to break the addCastlingMoves ->
 * isSquareAttacked recursion - castling can't capture so it
 * never threatens any square.
 */
export function generatePseudoMoves(position, rules, opts = {}) {
  const out = [];
  const me = position.turn;
  const includeCastling = !opts.excludeCastling;
  for (let i = 0; i < 64; i++) {
    const pc = position.board[i];
    if (!pc || pc.color !== me) continue;
    const file = i % 8;
    const rank = (i - file) / 8;
    const from = frToSquare([file, rank]);
    const spec = pieceSpecFor(rules, pc);
    if (!spec) continue;
    for (const prim of spec.moves || []) {
      addPrimitiveMoves(out, position, rules, pc, [file, rank], from, prim);
    }
    // Castling - only for kings, only when their spec says so,
    // and only when the caller hasn't asked us to skip it.
    if (includeCastling && pc.type === "k" && spec.castling) {
      addCastlingMoves(out, position, rules, pc, [file, rank], from, spec);
    }
  }
  return out;
}

/**
 * Check whether `square` is attacked by any piece of `byColor`
 * in the given position. Used by king-safety filtering.
 *
 * Implementation: generate `byColor`'s pseudo moves on a
 * snapshot where it's their turn, EXCLUDING castling, and see
 * if any move's `to` matches the target square. Castling can't
 * capture so it never threatens; including it would create a
 * cycle between addCastlingMoves -> isSquareAttacked ->
 * generatePseudoMoves -> addCastlingMoves -> ... and stack
 * overflow.
 *
 * Slow but correct - for speed we'd cache attack maps, but we
 * can afford the simpler version given the engine isn't
 * running in a tournament setting.
 */
export function isSquareAttacked(position, square, byColor, rules) {
  const sim = position.turn === byColor ? position : position.clone();
  if (sim !== position) sim.turn = byColor;
  return generatePseudoMoves(sim, rules, { excludeCastling: true })
    .some((mv) => mv.to === square);
}

// ── Primitive expansion ─────────────────────────────────────

function addPrimitiveMoves(out, position, rules, piece, fromFR, fromSq, prim) {
  if (!prim || typeof prim !== "object") return;
  const flip = piece.color === "b" ? -1 : 1;

  if (prim.kind === "slide") {
    if (!Array.isArray(prim.dirs)) return;
    const max = Number.isFinite(prim.maxRange) ? prim.maxRange : 8;
    for (const [df, dr] of prim.dirs) {
      let f = fromFR[0];
      let r = fromFR[1];
      for (let step = 0; step < max; step++) {
        f += df;
        r += dr * flip;
        if (!inBounds([f, r])) break;
        const targetSq = frToSquare([f, r]);
        const targetPc = position.pieceAt(targetSq);
        if (!targetPc) {
          out.push({ from: fromSq, to: targetSq });
          continue;
        }
        if (targetPc.color !== piece.color) {
          out.push({ from: fromSq, to: targetSq });
        }
        break; // friend or enemy, slide is blocked beyond.
      }
    }
    return;
  }

  if (prim.kind === "leap") {
    if (!Array.isArray(prim.offsets)) return;
    for (const [df, dr] of prim.offsets) {
      const f = fromFR[0] + df;
      const r = fromFR[1] + dr * flip;
      if (!inBounds([f, r])) continue;
      const targetSq = frToSquare([f, r]);
      const targetPc = position.pieceAt(targetSq);
      if (targetPc && targetPc.color === piece.color) continue;
      out.push({ from: fromSq, to: targetSq });
    }
    return;
  }

  if (prim.kind === "step") {
    if (!Array.isArray(prim.dirs)) return;
    const cond = prim.conditions || {};
    const promotionTypes = pieceSpecFor(rules, piece)?.promotion?.type || null;
    for (const [df, dr] of prim.dirs) {
      const f = fromFR[0] + df;
      const r = fromFR[1] + dr * flip;
      if (!inBounds([f, r])) continue;
      const targetSq = frToSquare([f, r]);
      const targetPc = position.pieceAt(targetSq);

      if (cond.onlyFirstMove) {
        if (!isOnStartingRank(piece, fromFR)) continue;
        // Multi-square steps need every intermediate empty.
        if (!intermediateClear(position, fromFR, [f, r])) continue;
      }
      if (cond.onlyCapture) {
        if (!targetPc) continue;
        if (targetPc.color === piece.color) continue;
      }
      if (cond.onlyNonCapture) {
        if (targetPc) continue;
      }
      if (cond.enPassant) {
        // En passant is only legal when the position's enPassant
        // target square matches AND the destination is empty.
        // The captured pawn lives one rank back from the
        // destination (on the rank we came from).
        if (!position.enPassant) continue;
        if (targetSq !== position.enPassant) continue;
        if (targetPc) continue;
        out.push({ from: fromSq, to: targetSq, enPassant: true });
        continue;
      }
      // Already filtered by cond.* above. Now decide whether
      // this is a promotion or a plain step.
      if (promotionTypes && isOnPromotionRank(piece, [f, r])) {
        for (const promoType of promotionTypes) {
          out.push({ from: fromSq, to: targetSq, promotion: promoType });
        }
      } else {
        out.push({ from: fromSq, to: targetSq });
      }
    }
    return;
  }
}

// ── Castling ────────────────────────────────────────────────

function addCastlingMoves(out, position, rules, piece, fromFR, fromSq, spec) {
  // Castling only fires on the king's standard rank. We hardwire
  // those (rank 0 for white, rank 7 for black) to keep things
  // tractable - variants that put the king elsewhere can disable
  // castling entirely.
  const expectedRank = piece.color === "w" ? 0 : 7;
  if (fromFR[1] !== expectedRank) return;
  const rights = position.castling[piece.color];
  if (!rights) return;
  const castling = spec.castling;
  if (!castling) return;

  if (spec.castling.requireUnmoved && !(rights.kingside || rights.queenside)) {
    return; // Both sides revoked already.
  }

  const checks = {
    kingside: { allowed: !!castling.kingside && rights.kingside, rookFile: 7, kingTargetFile: 6, betweenFiles: [5, 6], safeFiles: [4, 5, 6] },
    queenside: { allowed: !!castling.queenside && rights.queenside, rookFile: 0, kingTargetFile: 2, betweenFiles: [1, 2, 3], safeFiles: [4, 3, 2] },
  };

  for (const [side, cfg] of Object.entries(checks)) {
    if (!cfg.allowed) continue;
    // Rook present at expected file?
    const rookSq = frToSquare([cfg.rookFile, expectedRank]);
    const rook = position.pieceAt(rookSq);
    if (!rook || rook.type !== "r" || rook.color !== piece.color) continue;
    // Squares between king and rook clear?
    if (!cfg.betweenFiles.every((f) => !position.pieceAt(frToSquare([f, expectedRank])))) continue;
    // King doesn't pass through check - but ONLY if checkmate
    // is the active win condition. Variants that don't care
    // about check (capture-king, etc.) skip this so a king CAN
    // castle through attacked squares.
    if (hasCheckmateRule(rules)) {
      const enemy = piece.color === "w" ? "b" : "w";
      const passes = cfg.safeFiles.every(
        (f) => !isSquareAttacked(position, frToSquare([f, expectedRank]), enemy, rules),
      );
      if (!passes) continue;
    }
    out.push({
      from: fromSq,
      to: frToSquare([cfg.kingTargetFile, expectedRank]),
      castling: true,
      castlingSide: side,
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────

function hasCheckmateRule(rules) {
  return Array.isArray(rules.winConditions) && rules.winConditions.some((wc) => wc?.type === "checkmate");
}

/** True iff the piece is on its color-relative starting rank. Used by `onlyFirstMove`. */
function isOnStartingRank(piece, fromFR) {
  if (piece.type === "p") {
    return piece.color === "w" ? fromFR[1] === 1 : fromFR[1] === 6;
  }
  return false;
}

/** True iff the piece is moving onto its promotion rank (used for pawns). */
function isOnPromotionRank(piece, toFR) {
  if (piece.type === "p") {
    return piece.color === "w" ? toFR[1] === 7 : toFR[1] === 0;
  }
  return false;
}

/**
 * For multi-square steps (e.g. 2-square pawn jump), every
 * intermediate square must be empty for the move to be legal.
 * The single-square case has nothing to check.
 */
function intermediateClear(position, fromFR, toFR) {
  const [f0, r0] = fromFR;
  const [f1, r1] = toFR;
  const stepF = Math.sign(f1 - f0);
  const stepR = Math.sign(r1 - r0);
  let f = f0 + stepF;
  let r = r0 + stepR;
  while (f !== f1 || r !== r1) {
    if (position.pieceAt(frToSquare([f, r]))) return false;
    f += stepF;
    r += stepR;
  }
  return true;
}

/**
 * Apply a move on a clone and check whether the friendly king
 * is now under attack. Used by the legal-move filter.
 */
function leavesOwnKingInCheck(position, move, rules) {
  const us = position.turn;
  const next = applyMoveRaw(position, move, rules);
  if (!next) return true; // Move couldn't be applied = treat as illegal.
  const ourKing = next.findKing(us);
  if (!ourKing) {
    // No king to check - whatever happened, it's not "leaves
    // king in check" (the variant either has no kings or just
    // captured ours). Treat as not-illegal so the apply path
    // can decide game-over via the win-conditions.
    return false;
  }
  const enemy = us === "w" ? "b" : "w";
  return isSquareAttacked(next, ourKing, enemy, rules);
}

// Re-export for tests + external consumers.
export { squareToIndex };
