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
 *     name,           // e.g. "Wizard Queen" or "AI: Reverse pawns"
 *     description,    // 1-2 sentence summary
 *     changes: [
 *       { kind: "starting_position",  detail: "...non-vanilla FEN..." },
 *       { kind: "piece_moves",        piece: "p", detail: "..." },
 *       { kind: "castling",           detail: "Castling disabled for both sides" },
 *       { kind: "ability",            piece: "q", detail: "...", abilityId, label, gating, effectSummary, targetSummary },  // Ship #2.5
 *       { kind: "capture_effect",     detail: "..." },
 *       { kind: "win_condition",      detail: "..." },
 *       { kind: "byColor",            detail: "..." },
 *       { kind: "ply_cap",            detail: "..." },
 *     ],
 *   }
 *
 * Ability changes are surfaced explicitly (not just as a
 * "piece moves changed" generic note) so the lobby preview can
 * tell the player "Queens can cast Fireball: 3 charges, 4-turn
 * cooldown, AOE radius 1." Without this, players see the prose
 * description and zero structured info, then sit at the board
 * not knowing what they have. That's the #1 discoverability
 * failure mode.
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
    // Ship #2.5: surface abilities so the lobby preview shows
    // the player WHAT they can do before the match starts. The
    // structured fields (gating, effectSummary, targetSummary)
    // also drive the in-match AbilityPanel.
    if (Array.isArray(userSpec.abilities) && userSpec.abilities.length > 0) {
      for (const ab of userSpec.abilities) {
        changes.push(describeAbility(pt, ab));
      }
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
    // Surface byColor abilities too. We label them so the panel
    // can scope the right abilities to the right color.
    for (const color of ["w", "b"]) {
      const colorSpecs = rules.byColor[color] || {};
      for (const pt of ["p", "n", "b", "r", "q", "k"]) {
        const spec = colorSpecs[pt];
        if (!Array.isArray(spec?.abilities) || spec.abilities.length === 0) continue;
        for (const ab of spec.abilities) {
          const change = describeAbility(pt, ab);
          change.color = color;
          changes.push(change);
        }
      }
    }
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

// ── Ability descriptions ──────────────────────────────────

/**
 * Render an ability spec into a structured change-list entry the
 * UI can hydrate in two ways:
 *
 *   - As a one-line summary in the lobby preview (using `detail`)
 *   - As a structured row in the in-match AbilityPanel
 *     (using `targetSummary`, `effectSummary`, `gating`, `label`)
 *
 * Keep this string-only - no JSX. The React renderer is in
 * RulePreview / AbilityPanel and does its own layout.
 */
function describeAbility(pieceType, ab) {
  const pieceName = PIECE_NAMES[pieceType] || pieceType;
  const label = ab.label || ab.id || "ability";
  const targetSummary = describeAbilityTarget(ab.target);
  const effectSummary = describeAbilityEffect(ab.effect);
  const gating = describeGating(ab.gating);
  // The lobby's one-line summary. Skip the gating clause when
  // omitted (intentional unlimited use).
  const parts = [
    `${pieceName} can cast "${label}":`,
    `${effectSummary}`,
    `targets ${targetSummary}.`,
    gating ? gating : null,
  ].filter(Boolean);
  return {
    kind: "ability",
    piece: pieceType,
    abilityId: ab.id,
    label,
    targetSummary,
    effectSummary,
    gating: ab.gating || null,
    intensity: ab.intensity || "medium",
    detail: parts.join(" "),
  };
}

function describeAbilityTarget(target) {
  if (!target || typeof target !== "object") return "anywhere";
  if (target.kind === "ranged" || target.kind === "leap") {
    const n = (target.offsets || []).length;
    const filterParts = [];
    if (target.requireEmpty) filterParts.push("empty squares");
    else if (target.requireEnemy === false) filterParts.push("any square");
    else filterParts.push("enemy pieces");
    return `${filterParts.join(" / ")} within ${n} positions`;
  }
  if (target.kind === "slide") {
    const dirCount = (target.dirs || []).length;
    const range = target.maxRange ? `up to ${target.maxRange} squares` : "any distance";
    const blockTag = target.blockedByPieces === false ? "(reaches through pieces)" : "(line of sight)";
    return `${dirCount} sliding directions, ${range} ${blockTag}`;
  }
  return target.kind || "unknown";
}

function describeAbilityEffect(effect) {
  if (!effect || typeof effect !== "object") return "does nothing";
  switch (effect.kind) {
    case "destroy":
    case "capture": {
      const aoe = effect.aoe;
      if (aoe && Number.isFinite(aoe.radius) && aoe.radius > 0) {
        return `destroys the target and pieces within ${aoe.radius} square(s)`;
      }
      return "destroys the target";
    }
    case "displace": {
      if (Array.isArray(effect.delta)) {
        return `pushes the target by [${effect.delta[0]}, ${effect.delta[1]}]`;
      }
      const dist = effect.distance || "?";
      return `displaces the target ${dist} square(s) ${effect.direction || ""}`.trim();
    }
    case "relocate_self":
      return `teleports the caster (destination: ${effect.destination || "target"})`;
    case "spawn":
      return `summons a friendly ${PIECE_NAMES[effect.pieceType] || effect.pieceType}${
        effect.lifespan ? ` (lasts ${effect.lifespan} plies)` : ""
      }`;
    case "transform": {
      const dur = effect.duration ? ` for ${effect.duration} plies` : "";
      const what = effect.color === "caster" ? "charms the target" : effect.color === "flip" ? "flips the target's color" : "transforms the target";
      return `${what}${dur}`;
    }
    case "mark": {
      const tag = effect.tag || "marked";
      const dur = effect.duration ? ` (${effect.duration} plies)` : "";
      const verbs = [];
      if (effect.skipTurns) verbs.push("can't move");
      if (effect.silenceAbilities) verbs.push("can't cast");
      if (effect.absorbCaptures) verbs.push(`absorbs ${effect.absorbCaptures} captures`);
      if (effect.extraMoves) verbs.push(`extra ${effect.extraMoves} move(s)`);
      if (effect.destroyOnExpire) verbs.push("dies when timer hits 0");
      const what = verbs.length ? ` (${verbs.join(", ")})` : "";
      return `marks the target as "${tag}"${dur}${what}`;
    }
    case "aoe_wrap": {
      const inner = describeAbilityEffect(effect.inner);
      return `for every piece within ${effect.radius || 1} square(s) of the target: ${inner}`;
    }
    default:
      return effect.kind || "unknown effect";
  }
}

function describeGating(gating) {
  if (!gating) return "Unlimited uses (no cooldown).";
  const parts = [];
  if (Number.isFinite(gating.charges)) parts.push(`${gating.charges} charge${gating.charges === 1 ? "" : "s"}`);
  if (Number.isFinite(gating.cooldownPlies)) parts.push(`${gating.cooldownPlies}-ply cooldown`);
  if (parts.length === 0) return null;
  return `${parts.join(", ")}.`;
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
