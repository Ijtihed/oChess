/**
 * Rules: vanilla baseline + diff resolver.
 *
 * `vanillaRules()` returns a fresh full-spec Rules object that
 * faithfully describes standard chess. The other engine modules
 * are tested against it as a parity check vs chess.js so we
 * know the move generator, capture handler, and win checker
 * are all internally consistent before we layer custom variants
 * on top.
 *
 * `resolveRules(diff)` takes either:
 *   - a full-spec Rules object - returned as-is (with defaults
 *     filled in for optional fields), or
 *   - a diff object `{ extends: "vanilla", overrides, pieces,
 *     byColor, ... }` - merged on top of the vanilla baseline.
 *
 * The merge is intentionally shallow at the top level + deep
 * inside `pieces` / `byColor`, so an AI-produced diff like
 * `{ extends: "vanilla", pieces: { k: { castling: { kingside:
 * false, queenside: false } } } }` only touches the king's
 * castling spec without overwriting its `moves`.
 */

import {
  VANILLA_FEN,
  DIR,
  KNIGHT_OFFSETS,
  KING_OFFSETS,
  DEFAULT_MAX_PLIES,
} from "./schema";

// ── Vanilla baseline ─────────────────────────────────────────

/**
 * Build a fresh full-spec Rules object describing standard chess.
 * Fresh on every call so callers can mutate the result without
 * polluting other consumers; the engine treats Rules as
 * read-only but downstream code (validator, etc.) sometimes
 * wants to splice.
 */
export function vanillaRules() {
  return {
    name: "Standard chess",
    description: "Standard chess. Checkmate to win.",
    startingFen: VANILLA_FEN,
    pieces: {
      p: {
        moves: [
          // One-step forward, no capture.
          { kind: "step", dirs: [DIR.N], conditions: { onlyNonCapture: true } },
          // Two-step forward from starting rank, no capture.
          { kind: "step", dirs: [[0, 2]], conditions: { onlyFirstMove: true, onlyNonCapture: true } },
          // Diagonal capture.
          { kind: "step", dirs: [DIR.NE, DIR.NW], conditions: { onlyCapture: true } },
          // En passant - destination is empty but the just-moved
          // pawn occupies the adjacent file, one rank below.
          { kind: "step", dirs: [DIR.NE, DIR.NW], conditions: { enPassant: true } },
        ],
        promotion: { type: ["n", "b", "r", "q"] },
      },
      n: {
        moves: [{ kind: "leap", offsets: [...KNIGHT_OFFSETS] }],
      },
      b: {
        moves: [{ kind: "slide", dirs: [DIR.NE, DIR.NW, DIR.SE, DIR.SW] }],
      },
      r: {
        moves: [{ kind: "slide", dirs: [DIR.N, DIR.S, DIR.E, DIR.W] }],
      },
      q: {
        moves: [
          { kind: "slide", dirs: [DIR.N, DIR.S, DIR.E, DIR.W] },
          { kind: "slide", dirs: [DIR.NE, DIR.NW, DIR.SE, DIR.SW] },
        ],
      },
      k: {
        moves: [{ kind: "leap", offsets: [...KING_OFFSETS] }],
        castling: {
          kingside: true,
          queenside: true,
          requireUnmoved: true,
          // Squares between king and rook that must be empty.
          // Filled in by the move generator from the king/rook
          // positions; we just flag that castling is allowed.
          requireEmpty: [],
          requireSafe: [],
        },
      },
    },
    capture: {
      explosionRadius: 0,
      convert: false,
    },
    winConditions: [{ type: "checkmate" }],
    maxPlies: DEFAULT_MAX_PLIES,
  };
}

// ── Resolver ────────────────────────────────────────────────

/**
 * Resolve a diff or full-spec rules input into a full-spec
 * Rules object. The engine ALWAYS sees the resolved form, so
 * deep merges and shorthand expansions live here, not in the
 * hot path.
 *
 * Throws on unknown `extends` values - we don't silently fall
 * back to vanilla because that hides bad AI output.
 */
export function resolveRules(input) {
  if (!input || typeof input !== "object") {
    throw new Error("rules input must be an object");
  }

  // Already full-spec: trust it but fill in any optional fields
  // the engine expects.
  if (!input.extends) {
    return fillDefaults(structuredClone(input));
  }

  if (input.extends !== "vanilla") {
    throw new Error(`unknown extends base: ${input.extends}`);
  }

  const base = vanillaRules();
  const merged = { ...base };

  // Top-level scalar / array overrides.
  if (typeof input.startingFen === "string") merged.startingFen = input.startingFen;
  if (Number.isFinite(input.maxPlies)) merged.maxPlies = input.maxPlies;
  if (typeof input.name === "string") merged.name = input.name;
  if (typeof input.description === "string") merged.description = input.description;
  if (Array.isArray(input.winConditions)) merged.winConditions = structuredClone(input.winConditions);
  if (input.capture && typeof input.capture === "object") {
    merged.capture = { ...base.capture, ...input.capture };
  }

  // Top-level `overrides` is a shallow shortcut for the most
  // common case: replace specific top-level fields outright.
  // Useful when the AI returns "set startingFen = X" without
  // touching anything else.
  if (input.overrides && typeof input.overrides === "object") {
    if (typeof input.overrides.startingFen === "string") merged.startingFen = input.overrides.startingFen;
    if (Number.isFinite(input.overrides.maxPlies)) merged.maxPlies = input.overrides.maxPlies;
    if (typeof input.overrides.name === "string") merged.name = input.overrides.name;
    if (typeof input.overrides.description === "string") merged.description = input.overrides.description;
    if (Array.isArray(input.overrides.winConditions)) {
      merged.winConditions = structuredClone(input.overrides.winConditions);
    }
    if (input.overrides.capture && typeof input.overrides.capture === "object") {
      merged.capture = { ...merged.capture, ...input.overrides.capture };
    }
  }

  // Per-piece deep merge. Lets a diff target { k: { castling: {
  // kingside: false } } } without having to re-spell the king's
  // moves. Nested fields (`moves`, `castling`, `promotion`) are
  // ALL replaced wholesale on overlap - we don't try to merge
  // the moves array since it's order-sensitive.
  if (input.pieces && typeof input.pieces === "object") {
    merged.pieces = { ...base.pieces };
    for (const [pt, override] of Object.entries(input.pieces)) {
      if (!override || typeof override !== "object") continue;
      const baseSpec = merged.pieces[pt] || {};
      merged.pieces[pt] = mergePieceSpec(baseSpec, override);
    }
  }

  // Per-color overrides - same deep-merge semantics, scoped to
  // a single color. If both `pieces` and `byColor.{w,b}` set the
  // same field, byColor wins (it's strictly more specific).
  if (input.byColor && typeof input.byColor === "object") {
    merged.byColor = {};
    for (const color of ["w", "b"]) {
      if (!input.byColor[color] || typeof input.byColor[color] !== "object") continue;
      const colorOverrides = {};
      for (const [pt, override] of Object.entries(input.byColor[color])) {
        if (!override || typeof override !== "object") continue;
        const baseSpec = merged.pieces[pt] || {};
        colorOverrides[pt] = mergePieceSpec(baseSpec, override);
      }
      if (Object.keys(colorOverrides).length > 0) merged.byColor[color] = colorOverrides;
    }
    if (Object.keys(merged.byColor).length === 0) delete merged.byColor;
  }

  return fillDefaults(merged);
}

// ── Internal helpers ────────────────────────────────────────

/** Deep-merge a piece spec override on top of a base spec. */
function mergePieceSpec(base, override) {
  const out = { ...base };
  if (override.moves !== undefined) {
    out.moves = structuredClone(override.moves);
  } else if (Array.isArray(out.moves)) {
    out.moves = structuredClone(out.moves);
  }
  if (override.castling !== undefined) {
    out.castling = { ...(base.castling || {}), ...override.castling };
  } else if (out.castling) {
    out.castling = { ...out.castling };
  }
  if (override.promotion !== undefined) {
    out.promotion = structuredClone(override.promotion);
  } else if (out.promotion) {
    out.promotion = structuredClone(out.promotion);
  }
  return out;
}

/** Fill in any optional fields the engine downstream expects. */
function fillDefaults(rules) {
  if (typeof rules.startingFen !== "string") rules.startingFen = VANILLA_FEN;
  if (!Array.isArray(rules.winConditions) || rules.winConditions.length === 0) {
    rules.winConditions = [{ type: "checkmate" }];
  }
  if (!Number.isFinite(rules.maxPlies)) rules.maxPlies = DEFAULT_MAX_PLIES;
  if (!rules.capture || typeof rules.capture !== "object") {
    rules.capture = { explosionRadius: 0, convert: false };
  } else {
    if (!Number.isFinite(rules.capture.explosionRadius)) rules.capture.explosionRadius = 0;
    if (typeof rules.capture.convert !== "boolean") rules.capture.convert = false;
  }
  if (!rules.pieces || typeof rules.pieces !== "object") {
    rules.pieces = vanillaRules().pieces;
  }
  return rules;
}

/**
 * Look up the active piece move spec for a piece on the board.
 * Per-color overrides win over the global `pieces` entry. The
 * move generator and apply-move both go through this so they
 * agree on what a piece can do.
 */
export function pieceSpecFor(rules, piece) {
  if (!piece) return null;
  const colorOverride = rules.byColor?.[piece.color]?.[piece.type];
  if (colorOverride) return colorOverride;
  return rules.pieces[piece.type] || null;
}
