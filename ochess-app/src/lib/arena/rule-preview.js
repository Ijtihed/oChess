/**
 * Rule-diff renderer helpers for the Arena UI.
 *
 * Takes a resolved Rules object and produces a human-readable
 * diff against vanilla so the user can see WHAT actually
 * changes before committing to a round. Pure data transform,
 * no React - the React renderer in ArenaRoom consumes the
 * output and lays it out.
 *
 * Output shape:
 *
 *   {
 *     name,           // e.g. "Atomic-lite" or "AI: Reverse pawns"
 *     description,    // 1-2 sentence summary
 *     changes: [
 *       { kind: "starting_position",  detail: "...non-vanilla FEN..." },
 *       { kind: "piece_moves",        piece: "p", detail: "..." },
 *       { kind: "castling",           detail: "Castling disabled for both sides" },
 *       { kind: "capture_effect",     detail: "..." },
 *       { kind: "win_condition",      detail: "..." },
 *       { kind: "byColor",            detail: "..." },
 *       { kind: "ply_cap",            detail: "..." },
 *     ],
 *   }
 *
 * If a section is identical to vanilla, we omit it. If
 * everything matches vanilla, `changes` is empty and the
 * caller can render "Standard chess".
 */

import { vanillaRules } from "./rules";
import { VANILLA_FEN } from "./schema";

const PIECE_NAMES = {
  p: "Pawn",
  n: "Knight",
  b: "Bishop",
  r: "Rook",
  q: "Queen",
  k: "King",
};

/**
 * Build the structured diff against vanilla.
 *
 * @param {object} rules                     Resolved Rules object (NOT a diff).
 * @returns {{ name: string, description: string, changes: Array<object> }}
 */
export function describeRules(rules) {
  if (!rules) return { name: "Standard chess", description: "", changes: [] };
  const v = vanillaRules();
  const changes = [];

  // Starting position
  if (rules.startingFen && rules.startingFen !== VANILLA_FEN) {
    changes.push({
      kind: "starting_position",
      detail: `Custom starting position`,
      fen: rules.startingFen,
    });
  }

  // Per-piece move changes
  for (const pt of ["p", "n", "b", "r", "q", "k"]) {
    const userSpec = rules.pieces?.[pt];
    const vanillaSpec = v.pieces[pt];
    if (!userSpec) continue;
    const movesChanged = !movesEqual(userSpec.moves, vanillaSpec.moves);
    const castlingChanged = !castlingEqual(userSpec.castling, vanillaSpec.castling);
    const promotionChanged = !promotionEqual(userSpec.promotion, vanillaSpec.promotion);

    if (movesChanged) {
      changes.push({
        kind: "piece_moves",
        piece: pt,
        detail: describeMoves(pt, userSpec.moves),
      });
    }
    if (castlingChanged && pt === "k") {
      const c = userSpec.castling;
      let castlingDescr;
      if (!c?.kingside && !c?.queenside) {
        castlingDescr = "Castling disabled for both sides";
      } else if (!c.kingside) {
        castlingDescr = "Kingside castling disabled";
      } else if (!c.queenside) {
        castlingDescr = "Queenside castling disabled";
      } else {
        castlingDescr = "Castling rules modified";
      }
      changes.push({ kind: "castling", detail: castlingDescr });
    }
    if (promotionChanged) {
      const types = (userSpec.promotion?.type || []).map((t) => PIECE_NAMES[t] || t).join(", ");
      changes.push({
        kind: "promotion",
        piece: pt,
        detail: types ? `${PIECE_NAMES[pt] || pt} promotes to: ${types}` : `${PIECE_NAMES[pt] || pt} promotion disabled`,
      });
    }
  }

  // Per-color asymmetry
  if (rules.byColor && (rules.byColor.w || rules.byColor.b)) {
    const colors = [];
    if (rules.byColor.w) colors.push("White");
    if (rules.byColor.b) colors.push("Black");
    changes.push({
      kind: "byColor",
      detail: `Asymmetric: ${colors.join(" + ")} have unique rules`,
    });
  }

  // Capture effects
  if (rules.capture && rules.capture.explosionRadius > 0) {
    changes.push({
      kind: "capture_effect",
      detail: `Captures explode (radius ${rules.capture.explosionRadius}, non-pawn pieces)`,
    });
  }
  if (rules.capture?.convert) {
    changes.push({
      kind: "capture_effect",
      detail: "Captured pieces convert to capturer's color",
    });
  }

  // Win conditions
  for (const wc of rules.winConditions || []) {
    if (wc.type === "checkmate") continue; // vanilla
    changes.push({
      kind: "win_condition",
      detail: describeWinCondition(wc),
    });
  }

  // Ply cap
  if (Number.isFinite(rules.maxPlies) && rules.maxPlies !== v.maxPlies) {
    changes.push({
      kind: "ply_cap",
      detail: `Game declared a draw after ${rules.maxPlies} plies (${Math.round(rules.maxPlies / 2)} moves)`,
    });
  }

  return {
    name: rules.name || "Custom rules",
    description: rules.description || "",
    changes,
  };
}

// ── Helpers ──────────────────────────────────────────────

function movesEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function castlingEqual(a, b) {
  if (a === b) return true;
  if (!a && !b) return true;
  if (!a || !b) return false;
  return !!a.kingside === !!b.kingside && !!a.queenside === !!b.queenside;
}

function promotionEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a.type || []) === JSON.stringify(b.type || []);
}

function describeMoves(pt, moves) {
  if (!Array.isArray(moves) || moves.length === 0) {
    return `${PIECE_NAMES[pt] || pt} can't move`;
  }
  const summary = [];
  for (const m of moves) {
    if (m.kind === "slide") {
      summary.push(slideDescription(m));
    } else if (m.kind === "leap") {
      summary.push(leapDescription(m));
    } else if (m.kind === "step") {
      summary.push(stepDescription(m));
    }
  }
  return `${PIECE_NAMES[pt] || pt}: ${summary.filter(Boolean).join("; ")}`;
}

function slideDescription(m) {
  const dirNames = (m.dirs || []).map(dirName).filter(Boolean);
  const range = m.maxRange ? ` up to ${m.maxRange}` : "";
  if (dirNames.length === 0) return `slides`;
  return `slides ${dirNames.join(", ")}${range}`;
}

function leapDescription(m) {
  const knight = isKnightSet(m.offsets);
  const king = isKingSet(m.offsets);
  if (knight) return "leaps as a knight";
  if (king) return "leaps to adjacent squares";
  return `leaps to ${(m.offsets || []).length} offsets`;
}

function stepDescription(m) {
  const dirNames = (m.dirs || []).map(dirName).filter(Boolean);
  const cond = m.conditions || {};
  let prefix = "steps";
  if (cond.onlyCapture) prefix = "captures by stepping";
  else if (cond.onlyNonCapture) prefix = "moves";
  if (cond.onlyFirstMove) prefix += " (first move only)";
  if (cond.enPassant) prefix = "en passant capture";
  return dirNames.length ? `${prefix} ${dirNames.join(", ")}` : prefix;
}

function dirName([df, dr]) {
  const map = {
    "0,1":   "forward",
    "0,-1":  "backward",
    "1,0":   "right",
    "-1,0":  "left",
    "1,1":   "forward-right",
    "-1,1":  "forward-left",
    "1,-1":  "backward-right",
    "-1,-1": "backward-left",
    "0,2":   "two forward",
  };
  return map[`${df},${dr}`] || `(${df},${dr})`;
}

function isKnightSet(offsets) {
  if (!Array.isArray(offsets) || offsets.length !== 8) return false;
  const knight = new Set(["1,2", "2,1", "2,-1", "1,-2", "-1,-2", "-2,-1", "-2,1", "-1,2"]);
  return offsets.every(([a, b]) => knight.has(`${a},${b}`));
}

function isKingSet(offsets) {
  if (!Array.isArray(offsets) || offsets.length !== 8) return false;
  const king = new Set(["0,1", "1,1", "1,0", "1,-1", "0,-1", "-1,-1", "-1,0", "-1,1"]);
  return offsets.every(([a, b]) => king.has(`${a},${b}`));
}

function describeWinCondition(wc) {
  switch (wc.type) {
    case "capture_king":
      return "Win by capturing the enemy king (no checkmate required)";
    case "first_to_n_captures":
      return `First side to capture ${wc.target} pieces wins`;
    case "race_to_squares": {
      const piece = PIECE_NAMES[wc.piece] || wc.piece;
      const w = (wc.squaresWhite || []).join(", ");
      const b = (wc.squaresBlack || []).join(", ");
      return `Race to a goal: White wins by ${piece} on ${w}; Black wins by ${piece} on ${b}`;
    }
    case "last_standing":
      return "Win by reducing opponent to king only";
    default:
      return wc.type;
  }
}
