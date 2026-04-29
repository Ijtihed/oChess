/**
 * Win-condition evaluation for AI Arena.
 *
 * The rules object lists win conditions in order; the first
 * one whose predicate fires ends the game. We additionally
 * check the `maxPlies` cap and a basic stalemate fallback so
 * variants without explicit "checkmate" can still terminate.
 *
 * Win conditions evaluated:
 *
 *   { type: "checkmate" }
 *     - Side to move has no legal moves AND is in check =
 *       previous mover wins.
 *     - Side to move has no legal moves AND is NOT in check =
 *       stalemate, draw.
 *
 *   { type: "capture_king" }
 *     - A color is missing its king = the other side wins.
 *       Doesn't care whether the king was captured by a legal
 *       move (the rules either let you capture kings or they
 *       don't).
 *
 *   { type: "first_to_n_captures", target }
 *     - First color to reach `target` total captures wins.
 *
 *   { type: "race_to_squares", piece, squaresWhite, squaresBlack }
 *     - First color to land their `piece` on any of their goal
 *       squares wins. Useful for "get a king to e8" variants.
 *
 *   { type: "last_standing" }
 *     - A color with no non-king pieces remaining loses (the
 *       OTHER color wins).
 *
 * Plus implicit safety nets:
 *
 *   - `position.history.length >= rules.maxPlies` = draw.
 *   - Side to move has zero legal moves AND none of the
 *     explicit win conditions fire = draw (stalemate).
 *
 * Returns a `GameStatus`:
 *   { ended: boolean, winner: "w" | "b" | null, reason?: string }
 *
 * No mutation of inputs; safe to call repeatedly between
 * moves.
 */

import { generateLegalMoves } from "./move-gen";

/**
 * @param {import("./position").Position} position
 * @param {import("./schema").Rules}     rules
 * @returns {import("./schema").GameStatus}
 */
export function checkGameStatus(position, rules) {
  // Hard cap on game length (draw). Checked first so weird
  // rule sets can't loop forever even if no terminal condition
  // ever fires.
  if (position.history.length >= rules.maxPlies) {
    return { ended: true, winner: null, reason: "ply cap" };
  }

  // Run the explicit win conditions in declared order.
  for (const wc of rules.winConditions || []) {
    const result = evaluateWinCondition(wc, position, rules);
    if (result?.ended) return result;
  }

  // Implicit stalemate: side to move has no legal moves and
  // neither checkmate nor capture-king has fired. Draw.
  // (Checkmate-as-loss is covered by `evaluateWinCondition`
  // for { type: "checkmate" } entries.)
  const legal = generateLegalMoves(position, rules);
  if (legal.length === 0) {
    return { ended: true, winner: null, reason: "stalemate" };
  }

  return { ended: false, winner: null };
}

/**
 * Evaluate a single win condition. Returns null if the
 * condition hasn't fired, or a `GameStatus` with `ended: true`
 * if it has.
 */
function evaluateWinCondition(wc, position, rules) {
  if (!wc || typeof wc !== "object") return null;

  switch (wc.type) {
    case "checkmate":
      return evaluateCheckmate(position, rules);
    case "capture_king":
      return evaluateCaptureKing(position);
    case "first_to_n_captures":
      return evaluateFirstToNCaptures(position, wc);
    case "race_to_squares":
      return evaluateRaceToSquares(position, wc);
    case "last_standing":
      return evaluateLastStanding(position);
    default:
      return null; // Unknown win condition - silently skip.
  }
}

// ── Per-condition evaluators ───────────────────────────────

function evaluateCheckmate(position, rules) {
  const legal = generateLegalMoves(position, rules);
  if (legal.length > 0) return null;

  // Zero legal moves. Distinguish checkmate (king in check) vs
  // stalemate (king not in check). Stalemate is handled by the
  // outer fallback in `checkGameStatus`, so we only return a
  // result here for checkmate.
  const us = position.turn;
  const ourKing = position.findKing(us);
  if (!ourKing) {
    // No king present (variant removed it or it was captured).
    // Don't treat as checkmate; let other win conditions fire.
    return null;
  }
  const enemy = us === "w" ? "b" : "w";
  // Lazy import to avoid circular ref at module top.
  const inCheck = isAttackedByPseudoMoves(position, ourKing, enemy, rules);
  if (inCheck) {
    return { ended: true, winner: enemy, reason: "checkmate" };
  }
  return null;
}

function evaluateCaptureKing(position) {
  const wKing = position.findKing("w");
  const bKing = position.findKing("b");
  if (!wKing && !bKing) {
    // Both kings gone - unlikely but treat as draw.
    return { ended: true, winner: null, reason: "both kings captured" };
  }
  if (!wKing) return { ended: true, winner: "b", reason: "captured white king" };
  if (!bKing) return { ended: true, winner: "w", reason: "captured black king" };
  return null;
}

function evaluateFirstToNCaptures(position, wc) {
  const target = Number.isFinite(wc.target) ? wc.target : 3;
  if (position.captureTally.w >= target) {
    return { ended: true, winner: "w", reason: `first to ${target} captures` };
  }
  if (position.captureTally.b >= target) {
    return { ended: true, winner: "b", reason: `first to ${target} captures` };
  }
  return null;
}

function evaluateRaceToSquares(position, wc) {
  const piece = wc.piece || "k";
  for (const sq of wc.squaresWhite || []) {
    const pc = position.pieceAt(sq);
    if (pc && pc.color === "w" && pc.type === piece) {
      return { ended: true, winner: "w", reason: `${piece} reached ${sq}` };
    }
  }
  for (const sq of wc.squaresBlack || []) {
    const pc = position.pieceAt(sq);
    if (pc && pc.color === "b" && pc.type === piece) {
      return { ended: true, winner: "b", reason: `${piece} reached ${sq}` };
    }
  }
  return null;
}

function evaluateLastStanding(position) {
  const wPieces = position.findPieces("w").filter((sq) => position.pieceAt(sq).type !== "k");
  const bPieces = position.findPieces("b").filter((sq) => position.pieceAt(sq).type !== "k");
  if (wPieces.length === 0 && bPieces.length === 0) {
    return { ended: true, winner: null, reason: "both sides reduced to king" };
  }
  if (wPieces.length === 0) return { ended: true, winner: "b", reason: "white has only king" };
  if (bPieces.length === 0) return { ended: true, winner: "w", reason: "black has only king" };
  return null;
}

// ── Helper ─────────────────────────────────────────────────

/**
 * "Is this square attacked by `byColor`?" using PSEUDO-legal
 * moves. We use this for checkmate detection: an attack on the
 * king square is what defines check. We don't care if the
 * attacking move would itself be illegal because of a pin -
 * standard chess rules say a pinned piece still gives check.
 */
function isAttackedByPseudoMoves(position, square, byColor, rules) {
  // We can't import generatePseudoMoves up top because it
  // would create a cycle with this module via win-check ->
  // move-gen -> apply-move -> win-check (unlikely chain but
  // future-proof). Inline a minimal "any pseudo move targets
  // this square" check by flipping side-to-move.
  if (position.turn === byColor) {
    const moves = generateLegalMoves(position, withoutCheckmateRule(rules));
    return moves.some((m) => m.to === square);
  }
  const sim = position.clone();
  sim.turn = byColor;
  const moves = generateLegalMoves(sim, withoutCheckmateRule(rules));
  return moves.some((m) => m.to === square);
}

/**
 * For check detection, we want PSEUDO-legal moves (a pinned
 * piece still gives check). The simplest way to get them out
 * of `generateLegalMoves` is to temporarily remove the
 * "checkmate" win condition so the king-safety filter
 * doesn't run. Returns a shallow-cloned rules object.
 */
function withoutCheckmateRule(rules) {
  const filtered = (rules.winConditions || []).filter((wc) => wc?.type !== "checkmate");
  return { ...rules, winConditions: filtered };
}
