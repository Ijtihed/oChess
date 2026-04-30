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
 * @property {Ability[]}       [abilities] Active-cast abilities. Each ability is a turn-replacing action (the piece casts INSTEAD of moving) that applies an effect at a target square within range. See `Ability` for shape. AI-Arena-only; vanilla never sets this.
 *
 * Active abilities (Ship #1: `ranged` target + `capture` effect). An ability
 * is a turn-replacing action: on a player's turn they can either move a
 * piece OR cast one of that piece's abilities. The ability spends a charge /
 * starts a cooldown, then applies its effect at the chosen target square.
 *
 * @typedef {Object} AbilityTarget
 * @property {"ranged"|"slide"|"leap"} kind                Targeting mode. "ranged" = enumerate offsets like a leap; "slide" = ray-cast in directions; "leap" = same as ranged but allows targeting empty squares (used by `summon`).
 * @property {number[][]} [offsets]                        Used by kind="ranged" or "leap". List of [df, dr] tuples relative to the caster (white-relative; flipped for black).
 * @property {number[][]} [dirs]                           Used by kind="slide". Direction tuples.
 * @property {number} [maxRange]                           For kind="slide", how far the ray reaches. 1..8.
 * @property {boolean} [requireEnemy]                      Default true. Target must hold an enemy piece. False for `summon`/`teleport`.
 * @property {boolean} [requireEmpty]                      Default false. Target must be empty.
 * @property {boolean} [blockedByPieces]                   Default true for slide. If true, intervening pieces block the line.
 *
 * @typedef {Object} AbilityEffectAOE
 * @property {number} [radius]                             0..3. 0 = single-target only.
 * @property {boolean} [hitsPawns]                         Default false. Whether AOE damage removes pawns (atomic-style).
 * @property {boolean} [hitsFriendly]                      Default false. Whether AOE damage hits the caster's own pieces.
 *
 * Effect primitives (Ship #2). The original Ship #1 schema only supported
 * `{ kind: "capture" }`. Ship #2 expands this into seven composable
 * primitives that the AI combines to express any physical mechanic. The
 * engine resolves each deterministically; AI never writes rule logic JS.
 *
 * Backward compatibility: `{ kind: "capture", aoe }` from Ship #1 still
 * works - it's resolved as `{ kind: "destroy", aoe }`.
 *
 * @typedef {Object} EffectDestroy
 * @property {"destroy"|"capture"} kind                    Remove the target piece. "capture" is the legacy Ship #1 alias.
 * @property {AbilityEffectAOE} [aoe]                      Optional AOE around the target.
 *
 * @typedef {Object} EffectDisplace
 * @property {"displace"} kind                             Move target piece to a new square without removing it.
 * @property {[number, number]} [delta]                    Fixed [df, dr] offset to push the target. White-relative.
 * @property {("from_caster"|"toward_caster"|"toward_target_from_origin")} [direction]   Computed direction; alternative to `delta`.
 * @property {number} [distance]                           How many squares to push when using `direction`. 1..7.
 * @property {("destroy_target"|"destroy_collider"|"destroy_both"|"stop")} [onCollision] What happens when the displaced piece would land on an occupied square. Default "stop".
 * @property {boolean} [bounceOffEdge]                     If true, target stops at the board edge instead of being destroyed.
 *
 * @typedef {Object} EffectRelocateSelf
 * @property {"relocate_self"} kind                        Move the caster to a different square as part of the cast.
 * @property {("target"|"adjacent_to_target"|"caster_origin")} [destination]   Where the caster ends up. Default: "target".
 *
 * @typedef {Object} EffectSpawn
 * @property {"spawn"} kind                                Create a piece on an empty square (the cast target).
 * @property {PieceType} pieceType                         What to spawn (p, n, b, r, q, k).
 * @property {("caster"|"enemy")} [color]                  Default "caster".
 * @property {number} [lifespan]                           Plies until the spawn auto-destroys. Omit = permanent.
 *
 * @typedef {Object} EffectTransform
 * @property {"transform"} kind                            Change the target piece's type or color.
 * @property {PieceType} [pieceType]                       New type.
 * @property {("flip"|"caster"|"enemy")} [color]           "flip" = invert; "caster" = make friendly; "enemy" = make hostile.
 * @property {number} [duration]                           Plies before reverting. Omit = permanent.
 * @property {boolean} [revertOnCapture]                   If true, transform reverts when the piece is captured.
 *
 * Mark behavioral fields. AI emits any string `tag` (used as a label for
 * Ship #3+ visuals); engine cares only about the booleans/integers below.
 *
 * @typedef {Object} EffectMark
 * @property {"mark"} kind                                 Apply a tagged status effect.
 * @property {string} tag                                  Free-form label, lowercase letters/digits/underscores. Used for visuals; engine ignores semantic content.
 * @property {number} [duration]                           Plies remaining. Omit = permanent. Capped at 30.
 * @property {boolean} [skipTurns]                         While active, the marked piece emits zero moves.
 * @property {boolean} [silenceAbilities]                  While active, the marked piece can move but not cast abilities.
 * @property {number} [absorbCaptures]                     Mark absorbs N incoming captures, then expires.
 * @property {number} [extraMoves]                         Owner gets N extra moves on this piece this turn (capped at 2).
 * @property {boolean} [destroyOnExpire]                   When duration hits 0, destroy the piece (burn semantics).
 * @property {boolean} [expireOnCapture]                   Mark drops when the piece captures something.
 *
 * @typedef {Object} EffectAOEWrap
 * @property {"aoe_wrap"} kind                             Apply a primitive to every square in a radius around the target.
 * @property {number} radius                               1..3. Wrap caster excluded from AOE.
 * @property {Effect} inner                                The primitive to apply at each AOE square.
 * @property {boolean} [hitsPawns]                         Default false.
 * @property {boolean} [hitsFriendly]                      Default false.
 *
 * @typedef {EffectDestroy|EffectDisplace|EffectRelocateSelf|EffectSpawn|EffectTransform|EffectMark|EffectAOEWrap} Effect
 *
 * For backward compatibility with Ship #1, `AbilityEffect` is an alias for
 * `Effect`. Existing code that types things as `AbilityEffect` keeps
 * compiling.
 *
 * @typedef {Effect} AbilityEffect
 *
 * @typedef {Object} AbilityGating
 * @property {number} [charges]                            Total uses per match. Omit = unlimited.
 * @property {number} [cooldownPlies]                      Plies between casts. Omit = no cooldown. 1..20.
 * @property {boolean} [startsOnCooldown]                  Default false. If true, the cooldown is already ticking at match start.
 *
 * @typedef {Object} Ability
 * @property {string} id                                   Stable identifier, lowercase + alpha + underscore. Unique within a piece spec. e.g. "fireball", "frost_strike".
 * @property {string} [label]                              Human-readable name for the UI. Optional. Falls back to `id`.
 * @property {AbilityTarget} target                        Targeting spec.
 * @property {AbilityEffect} effect                        What happens at the target.
 * @property {AbilityGating} [gating]                      Charges / cooldown limits. Omit = no gating (chaos).
 * @property {"brief"|"medium"|"dramatic"} [intensity]     Animation intensity tier; engine uses this to time the input lock. Default "medium".
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
