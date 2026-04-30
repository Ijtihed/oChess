/**
 * Position: a serializable snapshot of a single point in a
 * variant chess game. Designed to be cheap to clone (so the
 * move generator can simulate moves without mutating the live
 * position) and FEN-compatible (so we can hand a FEN to chess.js
 * for SAN display + share links).
 *
 * The board is a flat 64-entry array indexed (file + rank * 8)
 * from White's POV. Each entry is either `null` (empty square)
 * or `{ type, color }`.
 *
 * Side-effects we track beyond the board:
 *   - `turn`: side to move ("w" or "b").
 *   - `castling`: per-color, per-side castling rights.
 *   - `enPassant`: target square for an en passant capture (or
 *      null). Set after a 2-square pawn move.
 *   - `halfmove`: half-move clock for the 50-move rule. Resets
 *      on captures + pawn moves.
 *   - `fullmove`: 1-indexed full move counter.
 *   - `history`: ordered list of moves applied to this position.
 *      Used by win conditions ("first to N captures") and for
 *      threefold-repetition checks if we add them later.
 *   - `captureTally`: per-color count of captures made. Used by
 *      "first_to_n_captures" win conditions.
 *   - `extinct`: per-color flag set when a color has only its
 *      king left (or no king if rules removed the king-must-
 *      survive contract). Used by "last_standing" win conditions.
 *   - `crazyState`: AI-Arena-specific sidecar carrying ability
 *      charges, cooldowns, and (Ship #2+) per-square status
 *      effects. Optional - vanilla / non-ability variants
 *      leave it unset and the engine treats abilities as
 *      unlimited.
 *
 * The class only knows about board state. It does NOT know
 * about move primitives, win conditions, or rule semantics -
 * those live in `move-gen.js`, `apply-move.js`, and
 * `win-check.js`. Position is JUST the data.
 */

import { Chess } from "chess.js";

// ── Square helpers ──────────────────────────────────────────

/**
 * Convert algebraic ("e4") to a (file, rank) tuple where file 0
 * is the a-file and rank 0 is rank 1, both from White's POV.
 * Returns null on bad input so callers can defend.
 */
export function squareToFR(sq) {
  if (typeof sq !== "string" || sq.length !== 2) return null;
  const file = sq.charCodeAt(0) - 97; // 'a' = 0
  const rank = sq.charCodeAt(1) - 49; // '1' = 0
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return [file, rank];
}

/** Convert a (file, rank) tuple back to algebraic. */
export function frToSquare([file, rank]) {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return String.fromCharCode(97 + file) + String.fromCharCode(49 + rank);
}

/** Convert (file, rank) to the flat board index 0..63. */
export function frToIndex([file, rank]) {
  return file + rank * 8;
}

/** Convert algebraic to flat board index. */
export function squareToIndex(sq) {
  const fr = squareToFR(sq);
  return fr ? frToIndex(fr) : -1;
}

/** Bounds check for a (file, rank) tuple. */
export function inBounds([file, rank]) {
  return file >= 0 && file <= 7 && rank >= 0 && rank <= 7;
}

/** Iterate every square as algebraic strings. Useful in tests. */
export function allSquares() {
  const out = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      out.push(frToSquare([f, r]));
    }
  }
  return out;
}

// ── Position class ──────────────────────────────────────────

export class Position {
  /**
   * @param {Object} [init]
   * @param {(import("./schema").Piece|null)[]} [init.board]   64-entry board.
   * @param {("w"|"b")} [init.turn]
   * @param {{w: {kingside: boolean, queenside: boolean}, b: {kingside: boolean, queenside: boolean}}} [init.castling]
   * @param {string|null} [init.enPassant]      Algebraic target square, or null.
   * @param {number} [init.halfmove]
   * @param {number} [init.fullmove]
   * @param {Array} [init.history]
   * @param {{w: number, b: number}} [init.captureTally]
   */
  constructor(init = {}) {
    this.board = Array.isArray(init.board) && init.board.length === 64
      ? init.board.slice()
      : new Array(64).fill(null);
    this.turn = init.turn === "b" ? "b" : "w";
    this.castling = init.castling
      ? {
          w: { kingside: !!init.castling.w?.kingside, queenside: !!init.castling.w?.queenside },
          b: { kingside: !!init.castling.b?.kingside, queenside: !!init.castling.b?.queenside },
        }
      : { w: { kingside: false, queenside: false }, b: { kingside: false, queenside: false } };
    this.enPassant = typeof init.enPassant === "string" ? init.enPassant : null;
    this.halfmove = Number.isFinite(init.halfmove) ? init.halfmove : 0;
    this.fullmove = Number.isFinite(init.fullmove) ? init.fullmove : 1;
    this.history = Array.isArray(init.history) ? init.history.slice() : [];
    this.captureTally = init.captureTally
      ? { w: init.captureTally.w | 0, b: init.captureTally.b | 0 }
      : { w: 0, b: 0 };
    // Crazy-arena sidecar (AI Arena Ship #1+). Holds per-square
    // ability charges and cooldowns. Optional - undefined means
    // "no ability gating" which is the correct semantics for
    // pre-Ship-#1 callers.
    this.crazyState = init.crazyState
      ? cloneCrazyState(init.crazyState)
      : null;
  }

  /** Build a Position from a FEN string. Throws on bad FEN. */
  static fromFen(fen) {
    if (typeof fen !== "string") throw new Error("FEN must be a string");
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 4) throw new Error(`bad FEN: ${fen}`);
    const [boardField, turnField, castlingField, enPassantField, halfmoveField, fullmoveField] = parts;

    const board = new Array(64).fill(null);
    const ranks = boardField.split("/");
    if (ranks.length !== 8) throw new Error(`bad FEN board: ${boardField}`);
    // FEN ranks go from rank 8 down to rank 1 (top of board to
    // bottom). Our internal rank 0 is rank 1.
    for (let i = 0; i < 8; i++) {
      const rankIdx = 7 - i;
      let fileIdx = 0;
      for (const ch of ranks[i]) {
        if (/[1-8]/.test(ch)) {
          fileIdx += parseInt(ch, 10);
        } else if (/[pnbrqkPNBRQK]/.test(ch)) {
          const color = ch === ch.toUpperCase() ? "w" : "b";
          const type = ch.toLowerCase();
          board[frToIndex([fileIdx, rankIdx])] = { type, color };
          fileIdx += 1;
        } else {
          throw new Error(`bad FEN piece char: ${ch}`);
        }
      }
      if (fileIdx !== 8) throw new Error(`bad FEN rank ${rankIdx + 1}: ${ranks[i]}`);
    }

    const turn = turnField === "b" ? "b" : "w";
    const castling = {
      w: { kingside: castlingField.includes("K"), queenside: castlingField.includes("Q") },
      b: { kingside: castlingField.includes("k"), queenside: castlingField.includes("q") },
    };
    const enPassant = enPassantField && enPassantField !== "-" ? enPassantField : null;
    const halfmove = halfmoveField !== undefined ? parseInt(halfmoveField, 10) || 0 : 0;
    const fullmove = fullmoveField !== undefined ? parseInt(fullmoveField, 10) || 1 : 1;

    return new Position({ board, turn, castling, enPassant, halfmove, fullmove });
  }

  /** Serialize the position to a FEN string. */
  toFen() {
    const ranks = [];
    for (let r = 7; r >= 0; r--) {
      let row = "";
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const pc = this.board[frToIndex([f, r])];
        if (!pc) {
          empty += 1;
        } else {
          if (empty > 0) {
            row += empty.toString();
            empty = 0;
          }
          row += pc.color === "w" ? pc.type.toUpperCase() : pc.type.toLowerCase();
        }
      }
      if (empty > 0) row += empty.toString();
      ranks.push(row);
    }
    let castle = "";
    if (this.castling.w.kingside) castle += "K";
    if (this.castling.w.queenside) castle += "Q";
    if (this.castling.b.kingside) castle += "k";
    if (this.castling.b.queenside) castle += "q";
    if (!castle) castle = "-";
    return `${ranks.join("/")} ${this.turn} ${castle} ${this.enPassant || "-"} ${this.halfmove} ${this.fullmove}`;
  }

  /** Cheap clone for move-gen simulation. History + tally arrays are copied shallow. */
  clone() {
    return new Position({
      board: this.board.slice(),
      turn: this.turn,
      castling: {
        w: { ...this.castling.w },
        b: { ...this.castling.b },
      },
      enPassant: this.enPassant,
      halfmove: this.halfmove,
      fullmove: this.fullmove,
      history: this.history.slice(),
      captureTally: { ...this.captureTally },
      crazyState: this.crazyState ? cloneCrazyState(this.crazyState) : null,
    });
  }

  /** Return the piece at a given algebraic square, or null. */
  pieceAt(sq) {
    const idx = squareToIndex(sq);
    if (idx < 0) return null;
    return this.board[idx];
  }

  /** Set / clear a square. Used by apply-move; tests + rules logic should NOT call this directly. */
  setSquare(sq, piece) {
    const idx = squareToIndex(sq);
    if (idx < 0) return;
    this.board[idx] = piece || null;
  }

  /** Find every square occupied by the given color + (optional) type. */
  findPieces(color, type) {
    const out = [];
    for (let i = 0; i < 64; i++) {
      const pc = this.board[i];
      if (!pc) continue;
      if (color && pc.color !== color) continue;
      if (type && pc.type !== type) continue;
      out.push(frToSquare([i % 8, Math.floor(i / 8)]));
    }
    return out;
  }

  /** Locate the king of a given color, or null if missing. */
  findKing(color) {
    const all = this.findPieces(color, "k");
    return all.length > 0 ? all[0] : null;
  }
}

// ── Crazy-arena sidecar ─────────────────────────────────────

/**
 * Deep-copy the crazyState sidecar so cloning a Position
 * doesn't share mutable maps. Shape is forgiving: missing
 * sub-objects collapse to `undefined`, never throw.
 *
 * @param {{
 *   charges?:   Record<string, Record<string, number>>,
 *   cooldowns?: Record<string, Record<string, number>>,
 *   effects?:   Record<string, Array<object>>
 * }} state
 */
function cloneCrazyState(state) {
  if (!state || typeof state !== "object") return null;
  const out = {};
  if (state.charges && typeof state.charges === "object") {
    out.charges = {};
    for (const [sq, abilityMap] of Object.entries(state.charges)) {
      if (!abilityMap || typeof abilityMap !== "object") continue;
      out.charges[sq] = { ...abilityMap };
    }
  }
  if (state.cooldowns && typeof state.cooldowns === "object") {
    out.cooldowns = {};
    for (const [sq, abilityMap] of Object.entries(state.cooldowns)) {
      if (!abilityMap || typeof abilityMap !== "object") continue;
      out.cooldowns[sq] = { ...abilityMap };
    }
  }
  if (state.effects && typeof state.effects === "object") {
    out.effects = {};
    for (const [sq, effs] of Object.entries(state.effects)) {
      if (!Array.isArray(effs)) continue;
      out.effects[sq] = effs.map((e) => ({ ...e }));
    }
  }
  return out;
}

// ── chess.js bridge ─────────────────────────────────────────

/**
 * Wrap a Position in a chess.js instance (read-only - chess.js
 * doesn't know our variant rules). Used by the move-gen
 * vanilla-parity test, by SAN display, and as a fallback for
 * variant-agnostic helpers like FEN serialization.
 *
 * Returns null if chess.js refuses the FEN (which happens for
 * positions with extra pieces, missing kings under custom
 * rules, etc.). Callers must tolerate null.
 */
export function chessJsFromPosition(position) {
  try {
    return new Chess(position.toFen());
  } catch {
    return null;
  }
}
