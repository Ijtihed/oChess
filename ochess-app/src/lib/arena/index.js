/**
 * Public surface of the AI Arena engine.
 *
 * Consumers (the /arena route, the arena-rules Edge Function,
 * tests) should import from here rather than reaching into
 * individual modules - it lets us reorganize internals
 * without breaking call sites.
 *
 * The engine is FULLY data-driven: a single Rules object
 * decides everything about move generation, capture handling,
 * and win conditions. There is no code execution involved -
 * all rule semantics live in the interpreter functions, so
 * AI-produced JSON cannot escape the sandbox.
 */

export { Position, squareToFR, frToSquare, allSquares } from "./position";
export { vanillaRules, resolveRules, pieceSpecFor } from "./rules";
export { generateLegalMoves, generatePseudoMoves, isSquareAttacked } from "./move-gen";
export { applyMove, applyMoveRaw } from "./apply-move";
export { checkGameStatus } from "./win-check";
export {
  VANILLA_FEN,
  PIECE_TYPES,
  DEFAULT_MAX_PLIES,
  DIR,
  KNIGHT_OFFSETS,
  KING_OFFSETS,
} from "./schema";
