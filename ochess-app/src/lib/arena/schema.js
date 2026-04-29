/**
 * AI Arena rule schema.
 *
 * Every variant on the AI Arena route is described by a JSON
 * "rules object" that the engine in this folder reads to drive
 * move generation, capture handling, and win checking. There is
 * NO code execution involved - the rules object is data, not
 * code, so an AI-produced rules JSON can never escape the
 * sandbox.
 *
 * Two ways to author a rules object:
 *
 *   1. Full-spec: every field is set explicitly. The engine
 *      consumes this directly.
 *
 *   2. Extends: a small "diff" object with `extends: 'vanilla'`
 *      plus override fields. `resolveRules()` (in `rules.js`)
 *      expands it into a full-spec object before runtime ever
 *      sees it. The AI normally produces the diff form so the
 *      payload stays small + cheap to validate.
 *
 * The engine always works with the FULL form. Only the resolver
 * + validator know about extends.
 *
 * Board: 8x8, FEN-compatible (`a1` is bottom-left from White's
 * POV). Six piece types: 'p', 'n', 'b', 'r', 'q', 'k' (FEN
 * letters, lowercased). Color is tracked separately on the
 * piece, not encoded in the letter.
 *
 * @typedef {"w"|"b"} Color
 * @typedef {"p"|"n"|"b"|"r"|"q"|"k"} PieceType
 *
 * @typedef {Object} Piece
 * @property {PieceType} type
 * @property {Color}     color
 *
 * Move primitives describe HOW a piece moves. Every piece move
 * spec is a list of primitives; the move generator unions their
 * outputs. Coordinates use (file, rank) where file 0 = a, rank
 * 0 = 1 from White's POV. White-relative directions are flipped
 * automatically for Black.
 *
 * Three primitive shapes are supported:
 *
 *   { kind: "slide", dirs: [[df,dr], ...], maxRange?: number }
 *      - Slide in one or more directions until blocked. Like a
 *        rook (orthogonal) or bishop (diagonal). `maxRange`
 *        caps the slide; omit for unlimited.
 *
 *   { kind: "leap", offsets: [[df,dr], ...] }
 *      - Single jump to (file+df, rank+dr). Like a knight or
 *        king. Multiple offsets = multiple legal targets.
 *
 *   { kind: "step", dirs: [[df,dr], ...], conditions?: StepConditions }
 *      - Single-square step in given directions. Used for
 *        pawn-like moves where the move depends on context
 *        (only on first move, only for capture, etc.).
 *
 * @typedef {Object} StepConditions
 * @property {boolean} [onlyFirstMove]   Only legal if the piece hasn't moved (rank-based heuristic for pawns).
 * @property {boolean} [onlyCapture]     Only legal if the destination has an enemy piece.
 * @property {boolean} [onlyNonCapture]  Only legal if the destination is empty.
 * @property {boolean} [enPassant]       Pawn-style en passant: destination is empty but the just-moved enemy pawn occupies an adjacent square.
 *
 * @typedef {{kind: "slide", dirs: number[][], maxRange?: number}} SlidePrim
 * @typedef {{kind: "leap",  offsets: number[][]}}                LeapPrim
 * @typedef {{kind: "step",  dirs: number[][], conditions?: StepConditions}} StepPrim
 * @typedef {SlidePrim|LeapPrim|StepPrim} MovePrimitive
 *
 * @typedef {Object} PieceMoveSpec
 * @property {MovePrimitive[]} moves     What this piece can do.
 * @property {Object}          [castling] Castling spec (king only). { kingside: boolean, queenside: boolean, requireUnmoved: boolean, requireEmpty: number[][], requireSafe: number[][] }
 * @property {{type: PieceType[]}} [promotion] Promotion options on reaching the back rank (pawn-like). `type` is the list of piece types the player can promote to.
 *
 * @typedef {Object} CaptureEffects
 * @property {number} [explosionRadius]      0 = no AOE. 1 = also remove non-pawn pieces in 8 surrounding squares (atomic-style).
 * @property {boolean} [convert]             true = the captured piece changes to the capturer's color rather than being removed (anti-chess-like, off by default).
 *
 * @typedef {Object} WinConditionCheckmate
 * @property {"checkmate"} type
 *
 * @typedef {Object} WinConditionCaptureKing
 * @property {"capture_king"} type
 *
 * @typedef {Object} WinConditionFirstToCaptures
 * @property {"first_to_n_captures"} type
 * @property {number} target
 *
 * @typedef {Object} WinConditionRaceToSquares
 * @property {"race_to_squares"} type
 * @property {PieceType} piece              Which piece must reach the goal.
 * @property {string[]} squaresWhite        Algebraic squares the white piece must reach (any one).
 * @property {string[]} squaresBlack        Algebraic squares the black piece must reach.
 *
 * @typedef {Object} WinConditionLastStanding
 * @property {"last_standing"} type         The player whose color still has any non-king piece wins; if a player has only their king left they lose.
 *
 * @typedef {WinConditionCheckmate|WinConditionCaptureKing|WinConditionFirstToCaptures|WinConditionRaceToSquares|WinConditionLastStanding} WinCondition
 *
 * @typedef {Object} Rules
 * @property {string}                          startingFen      Standard FEN string. Vanilla = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".
 * @property {Record<PieceType, PieceMoveSpec>}        pieces           Per-piece-type move specs, applied to both colors unless overridden in `byColor`.
 * @property {{w?: Partial<Record<PieceType, PieceMoveSpec>>, b?: Partial<Record<PieceType, PieceMoveSpec>>}} [byColor] Per-color piece overrides (optional, lets the rules be asymmetric).
 * @property {CaptureEffects}                  [capture]        Capture mechanic overrides; defaults to standard (just remove the captured piece).
 * @property {WinCondition[]}                  winConditions    Ordered list - first to fire ends the game. Defaults to [{ type: "checkmate" }].
 * @property {number}                          [maxPlies]       Hard ply cap. The game is declared a draw if reached. Default 400 (200 full moves) - prevents infinite games on weird rule sets.
 * @property {string}                          [name]           Human-readable rules name (for the UI). Optional.
 * @property {string}                          [description]    1-2 sentence summary of what the rules do. Optional.
 *
 * @typedef {Object} RulesDiff
 * @property {"vanilla"} extends                                      Currently only "vanilla" - other base sets may follow.
 * @property {Partial<Rules>} [overrides]                             Shallow-merged on top of the base rules.
 * @property {Partial<Record<PieceType, Partial<PieceMoveSpec>>>} [pieces] Per-piece overrides (deep-merged).
 * @property {{w?: Partial<Record<PieceType, Partial<PieceMoveSpec>>>, b?: Partial<Record<PieceType, Partial<PieceMoveSpec>>>}} [byColor] Per-color overrides.
 * @property {CaptureEffects}                  [capture]
 * @property {WinCondition[]}                  [winConditions]
 * @property {string}                          [startingFen]
 * @property {number}                          [maxPlies]
 * @property {string}                          [name]
 * @property {string}                          [description]
 *
 * Move objects passed in/out of the engine:
 *
 * @typedef {Object} Move
 * @property {string} from              Algebraic ("e2", "h7"). Lowercase.
 * @property {string} to                Algebraic.
 * @property {PieceType} [promotion]    For pawn promotion, which type to promote to.
 * @property {boolean} [enPassant]      Whether this is an en-passant capture.
 * @property {boolean} [castling]       Whether this is a castling move.
 * @property {("kingside"|"queenside")} [castlingSide]
 * @property {Piece}   [captured]       Filled by the engine after `applyMove`.
 * @property {string}  [san]            SAN notation, filled by `applyMove`.
 *
 * @typedef {Object} GameStatus
 * @property {boolean} ended
 * @property {Color | null} winner      null = draw or game still ongoing (check `ended`).
 * @property {string} [reason]          Human-readable reason ("checkmate", "first to 3 captures", "ply cap", etc.).
 */

// ── Constants ──

/** Vanilla starting FEN, exposed so the resolver and validator can use it. */
export const VANILLA_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** All 6 standard piece types - the FEN alphabet. */
export const PIECE_TYPES = Object.freeze(["p", "n", "b", "r", "q", "k"]);

/** Default ply cap when the rules don't set one. 200 full moves. */
export const DEFAULT_MAX_PLIES = 400;

/** Slide / step direction constants in (file, rank) space. White-relative. */
export const DIR = Object.freeze({
  N:  [0,  1],
  S:  [0, -1],
  E:  [1,  0],
  W:  [-1, 0],
  NE: [1,  1],
  NW: [-1, 1],
  SE: [1, -1],
  SW: [-1,-1],
});

/** Standard knight offsets. */
export const KNIGHT_OFFSETS = Object.freeze([
  [1, 2], [2, 1], [2, -1], [1, -2],
  [-1, -2], [-2, -1], [-2, 1], [-1, 2],
]);

/** Standard king-leap offsets (8 surrounding squares). */
export const KING_OFFSETS = Object.freeze([
  [0, 1], [1, 1], [1, 0], [1, -1],
  [0, -1], [-1, -1], [-1, 0], [-1, 1],
]);
