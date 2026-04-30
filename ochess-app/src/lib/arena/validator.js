/**
 * Validator for AI Arena rule objects.
 *
 * AI-produced rules are untrusted - the model can hallucinate
 * piece moves that don't loop forever, win conditions that
 * can never fire, starting positions missing kings, etc. The
 * validator runs three layers of checks:
 *
 *   1. Static structure: well-formed JSON, every required
 *      field present, sane types, primitives reference real
 *      directions, win conditions are recognized.
 *
 *   2. Starting position: both kings present (for variants
 *      that use checkmate), the first mover has at least one
 *      legal move, win conditions reference squares / pieces
 *      that exist on the board.
 *
 *   3. Mobility / fairness check: from the starting position,
 *      both colors have comparable piece mobility. This is a
 *      cheap deterministic check (one ply of move generation
 *      per side) that catches "white can move, black is hard-
 *      locked" without needing to simulate full games. We do
 *      NOT run random-walk simulation by default - it's both
 *      slow (synchronous on the main thread) AND it produces
 *      false positives for variants where random play rarely
 *      finds checkmate (knight-queens, no-king-side endings,
 *      etc.).
 *
 * Simulation IS available behind opts.runSimulation = true so
 * tests / admin tooling can still exercise it, but the default
 * path stays fast + deterministic.
 *
 * The validator returns a structured report so the UI can
 * surface the specific problem. Soft warnings are flagged
 * separately from hard rejections - "starting mobility is
 * skewed 4:1" is suspicious but might be playable; "starting
 * position has no white king" is a hard reject.
 *
 * @typedef {Object} ValidatorReport
 * @property {boolean} valid                          Hard reject if false.
 * @property {string[]} errors                        Hard rejections.
 * @property {string[]} warnings                      Soft issues; UI may surface but doesn't block.
 * @property {Object} [mobility]                      Per-color move-count snapshot from the start.
 * @property {Object} [stats]                         Simulation stats when explicitly opted in.
 */

import { Position } from "./position";
import { resolveRules } from "./rules";
import { generateLegalMoves, isSquareAttacked } from "./move-gen";
import { applyMove } from "./apply-move";
import { checkGameStatus } from "./win-check";
import { PIECE_TYPES } from "./schema";

const KNOWN_WIN_CONDITIONS = new Set([
  "checkmate",
  "capture_king",
  "first_to_n_captures",
  "race_to_squares",
  "last_standing",
]);
const KNOWN_PRIMITIVE_KINDS = new Set(["slide", "leap", "step"]);

/**
 * Validate a rules object (full-spec or diff). Resolves the
 * diff form first so all checks see the canonical shape.
 *
 * @param {Object} rulesInput
 * @param {Object} [opts]
 * @param {boolean} [opts.runSimulation]              Opt in to the random-walk simulator (slow, false-positive-prone). Default false.
 * @param {number}  [opts.simulations]                Used only when runSimulation=true. Default 50.
 * @param {number}  [opts.simulationPlyCap]           Used only when runSimulation=true. Default 200.
 * @param {boolean} [opts.skipSimulation]             Legacy alias for !runSimulation. Ignored if runSimulation is set.
 * @param {() => number} [opts.random]                Inject a deterministic RNG for tests.
 * @returns {ValidatorReport}
 */
export function validateRules(rulesInput, opts = {}) {
  const errors = [];
  const warnings = [];

  let resolved;
  try {
    resolved = resolveRules(rulesInput);
  } catch (e) {
    errors.push(`resolveRules failed: ${e?.message || String(e)}`);
    return { valid: false, errors, warnings };
  }

  // ── Layer 1: static structure ──
  validateStructure(resolved, errors, warnings);
  if (errors.length > 0) return { valid: false, errors, warnings };

  // ── Layer 2: starting position sanity ──
  let startingPosition;
  try {
    startingPosition = Position.fromFen(resolved.startingFen);
  } catch (e) {
    errors.push(`startingFen is not a valid FEN: ${e?.message || String(e)}`);
    return { valid: false, errors, warnings };
  }
  validateStartingPosition(startingPosition, resolved, errors, warnings);
  if (errors.length > 0) return { valid: false, errors, warnings };

  // ── Layer 3a: structural mobility / fairness check ──
  // Cheap, deterministic, and a much better signal than a
  // random-walk simulator for whether the variant is broken.
  // Compare both colors' starting move count - if one side has
  // zero moves or the ratio is catastrophic we flag it. This
  // runs synchronously but is O(legal-moves-from-start), no
  // recursion.
  const mobility = analyzeMobility(startingPosition, resolved, errors, warnings);

  // ── Layer 3b: random-walk simulation (opt-in) ──
  // Only runs when explicitly requested. Useful for admin
  // tooling and the engine test suite, NOT in the lobby's
  // post-AI-call validation path.
  let stats;
  const wantSim = opts.runSimulation === true;
  if (wantSim) {
    stats = simulate(resolved, opts);
    interpretSimulationStats(stats, errors, warnings, opts);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    mobility,
    ...(stats ? { stats } : {}),
  };
}

// ── Layer 3a: starting-position mobility analyzer ──────────

/**
 * Cheap deterministic fairness check: count legal moves for
 * each color from the starting position. Catches the obvious
 * failure modes:
 *
 *   - One color has zero legal moves (rules hard-lock that
 *     side from the very first turn).
 *   - One color has < 5% of the other's moves AND fewer than
 *     5 moves total (severely cripled but not fully blocked).
 *
 * Returns the per-color move counts so the UI can surface
 * them. Does NOT run simulation, does NOT iterate beyond a
 * single ply, does NOT depend on randomness.
 */
function analyzeMobility(position, rules, errors, warnings) {
  const whiteMoves = countMovesFor(position, rules, "w");
  const blackMoves = countMovesFor(position, rules, "b");

  if (whiteMoves === 0) {
    errors.push("white has zero legal moves from the starting position");
  }
  if (blackMoves === 0) {
    errors.push("black has zero legal moves from the starting position");
  }

  if (whiteMoves > 0 && blackMoves > 0) {
    const min = Math.min(whiteMoves, blackMoves);
    const max = Math.max(whiteMoves, blackMoves);
    const ratio = max / min;
    // Severe asymmetry, but only flag as a hard error when one
    // side is genuinely starved. A 2:1 mobility advantage on
    // turn 1 is normal for asymmetric variants and should NOT
    // hard-fail. Hard reject only when one side has very few
    // moves AND the ratio is extreme (12:1+).
    if (min < 5 && ratio >= 12) {
      errors.push(`mobility is severely one-sided: white has ${whiteMoves} legal moves, black has ${blackMoves} (${ratio.toFixed(1)}:1)`);
    } else if (ratio >= 4) {
      warnings.push(`starting mobility is asymmetric: white ${whiteMoves} / black ${blackMoves} (${ratio.toFixed(1)}:1)`);
    }
  }

  return { white: whiteMoves, black: blackMoves };
}

function countMovesFor(position, rules, color) {
  if (position.turn === color) {
    return generateLegalMoves(position, rules).length;
  }
  // Flip side-to-move on a clone to count the OTHER color's
  // move set without mutating the source.
  const sim = position.clone();
  sim.turn = color;
  return generateLegalMoves(sim, rules).length;
}

// ── Layer 1: structure ─────────────────────────────────────

function validateStructure(rules, errors, warnings) {
  if (!rules.pieces || typeof rules.pieces !== "object") {
    errors.push("rules.pieces is missing or not an object");
    return;
  }
  for (const pt of PIECE_TYPES) {
    const spec = rules.pieces[pt];
    if (!spec) {
      errors.push(`piece spec for "${pt}" is missing`);
      continue;
    }
    if (!Array.isArray(spec.moves)) {
      errors.push(`piece "${pt}" has no moves array`);
      continue;
    }
    if (spec.moves.length === 0) {
      // A piece with NO moves is technically legal (it just
      // sits forever), but it usually indicates a malformed
      // diff. Warn but don't reject - an AI-designed variant
      // might intentionally lock a piece.
      warnings.push(`piece "${pt}" has zero move primitives - it can never move`);
    }
    for (let i = 0; i < spec.moves.length; i++) {
      const prim = spec.moves[i];
      const path = `pieces.${pt}.moves[${i}]`;
      if (!prim || typeof prim !== "object") {
        errors.push(`${path} is not an object`);
        continue;
      }
      if (!KNOWN_PRIMITIVE_KINDS.has(prim.kind)) {
        errors.push(`${path}.kind = "${prim.kind}" is unknown (must be one of ${[...KNOWN_PRIMITIVE_KINDS].join(", ")})`);
        continue;
      }
      if (prim.kind === "slide" || prim.kind === "step") {
        if (!Array.isArray(prim.dirs) || prim.dirs.length === 0) {
          errors.push(`${path}.dirs must be a non-empty array of [df,dr] tuples`);
        } else {
          for (let j = 0; j < prim.dirs.length; j++) {
            const d = prim.dirs[j];
            if (!Array.isArray(d) || d.length !== 2 || !Number.isFinite(d[0]) || !Number.isFinite(d[1])) {
              errors.push(`${path}.dirs[${j}] is not a [df,dr] tuple of finite numbers`);
            }
            if (d[0] === 0 && d[1] === 0) {
              errors.push(`${path}.dirs[${j}] is [0,0] - zero-vector direction loops forever`);
            }
          }
        }
        if (prim.kind === "slide" && prim.maxRange !== undefined) {
          if (!Number.isFinite(prim.maxRange) || prim.maxRange < 1 || prim.maxRange > 8) {
            errors.push(`${path}.maxRange must be 1..8`);
          }
        }
      } else if (prim.kind === "leap") {
        if (!Array.isArray(prim.offsets) || prim.offsets.length === 0) {
          errors.push(`${path}.offsets must be a non-empty array of [df,dr] tuples`);
        } else {
          for (let j = 0; j < prim.offsets.length; j++) {
            const off = prim.offsets[j];
            if (!Array.isArray(off) || off.length !== 2 || !Number.isFinite(off[0]) || !Number.isFinite(off[1])) {
              errors.push(`${path}.offsets[${j}] is not a [df,dr] tuple of finite numbers`);
            }
          }
        }
      }
    }

    // Active abilities (AI Arena Ship #1+). Each ability is an
    // active-cast effect: instead of moving, the piece spends a
    // charge / starts a cooldown to apply an effect at a target
    // square. Optional - vanilla and pre-Ship-#1 variants don't
    // set this.
    if (spec.abilities !== undefined) {
      validatePieceAbilities(`pieces.${pt}.abilities`, spec.abilities, errors, warnings);
    }
  }

  // Win conditions.
  if (!Array.isArray(rules.winConditions) || rules.winConditions.length === 0) {
    errors.push("rules.winConditions must be a non-empty array");
  } else {
    for (let i = 0; i < rules.winConditions.length; i++) {
      const wc = rules.winConditions[i];
      if (!wc || typeof wc !== "object" || !KNOWN_WIN_CONDITIONS.has(wc.type)) {
        errors.push(`winConditions[${i}].type "${wc?.type}" is unknown`);
        continue;
      }
      if (wc.type === "first_to_n_captures") {
        if (!Number.isFinite(wc.target) || wc.target < 1 || wc.target > 64) {
          errors.push(`winConditions[${i}].target must be 1..64`);
        }
      }
      if (wc.type === "race_to_squares") {
        if (!Array.isArray(wc.squaresWhite) || wc.squaresWhite.length === 0) {
          errors.push(`winConditions[${i}].squaresWhite must be a non-empty array`);
        }
        if (!Array.isArray(wc.squaresBlack) || wc.squaresBlack.length === 0) {
          errors.push(`winConditions[${i}].squaresBlack must be a non-empty array`);
        }
      }
    }
  }

  // Capture effects.
  if (rules.capture) {
    if (!Number.isFinite(rules.capture.explosionRadius) || rules.capture.explosionRadius < 0 || rules.capture.explosionRadius > 3) {
      errors.push("capture.explosionRadius must be 0..3");
    }
  }

  // Ply cap sanity.
  if (!Number.isFinite(rules.maxPlies) || rules.maxPlies < 10 || rules.maxPlies > 2000) {
    errors.push("maxPlies must be 10..2000");
  }
}

// ── Active-ability structural validation (AI Arena) ─────────

const KNOWN_ABILITY_TARGET_KINDS = new Set(["ranged", "leap", "slide"]);
// Ship #2: seven composable effect primitives. "capture" is the Ship #1
// alias for "destroy" - kept for backward compat with already-saved
// variants.
const KNOWN_ABILITY_EFFECT_KINDS = new Set([
  "capture", "destroy", "displace", "relocate_self",
  "spawn", "transform", "mark", "aoe_wrap",
]);
const KNOWN_INTENSITIES = new Set(["brief", "medium", "dramatic"]);
const ABILITY_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const TAG_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SPAWNABLE_PIECE_TYPES = new Set(["p", "n", "b", "r", "q"]);
const ALL_PIECE_TYPES = new Set(["p", "n", "b", "r", "q", "k"]);

/**
 * Validate the `abilities` array on a piece spec. Every check
 * here also runs server-side (the Edge Function mirrors this
 * logic to keep parity), but the client validator is the
 * authoritative defense against a stale Edge Function deploy.
 */
function validatePieceAbilities(pathPrefix, abilities, errors, warnings) {
  if (!Array.isArray(abilities)) {
    errors.push(`${pathPrefix} must be an array`);
    return;
  }
  if (abilities.length > 8) {
    errors.push(`${pathPrefix} caps at 8 abilities per piece (got ${abilities.length})`);
  }
  const seenIds = new Set();
  for (let i = 0; i < abilities.length; i++) {
    const ab = abilities[i];
    const path = `${pathPrefix}[${i}]`;
    if (!ab || typeof ab !== "object" || Array.isArray(ab)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    if (typeof ab.id !== "string" || !ABILITY_ID_RE.test(ab.id)) {
      errors.push(`${path}.id must be lowercase letters/digits/underscores, 1-32 chars (got ${JSON.stringify(ab.id)})`);
    } else if (seenIds.has(ab.id)) {
      errors.push(`${path}.id "${ab.id}" is duplicated within the same piece`);
    } else {
      seenIds.add(ab.id);
    }
    if (ab.label !== undefined && typeof ab.label !== "string") {
      errors.push(`${path}.label must be a string when set`);
    }
    if (ab.intensity !== undefined && !KNOWN_INTENSITIES.has(ab.intensity)) {
      errors.push(`${path}.intensity must be one of ${[...KNOWN_INTENSITIES].join("/")} when set`);
    }

    // Target.
    const tgt = ab.target;
    if (!tgt || typeof tgt !== "object") {
      errors.push(`${path}.target is required and must be an object`);
    } else if (!KNOWN_ABILITY_TARGET_KINDS.has(tgt.kind)) {
      errors.push(`${path}.target.kind "${tgt.kind}" is unknown (must be ranged/leap/slide)`);
    } else if (tgt.kind === "ranged" || tgt.kind === "leap") {
      if (!Array.isArray(tgt.offsets) || tgt.offsets.length === 0) {
        errors.push(`${path}.target.offsets must be a non-empty array for kind=${tgt.kind}`);
      } else if (tgt.offsets.length > 64) {
        errors.push(`${path}.target.offsets caps at 64 entries (got ${tgt.offsets.length})`);
      } else {
        for (let j = 0; j < tgt.offsets.length; j++) {
          const off = tgt.offsets[j];
          if (!Array.isArray(off) || off.length !== 2 || !Number.isFinite(off[0]) || !Number.isFinite(off[1])) {
            errors.push(`${path}.target.offsets[${j}] must be a [df,dr] tuple of finite numbers`);
          } else if (off[0] === 0 && off[1] === 0) {
            errors.push(`${path}.target.offsets[${j}] is [0,0] - cannot target your own square`);
          }
        }
      }
    } else if (tgt.kind === "slide") {
      if (!Array.isArray(tgt.dirs) || tgt.dirs.length === 0) {
        errors.push(`${path}.target.dirs must be a non-empty array for kind=slide`);
      } else {
        for (let j = 0; j < tgt.dirs.length; j++) {
          const d = tgt.dirs[j];
          if (!Array.isArray(d) || d.length !== 2 || !Number.isFinite(d[0]) || !Number.isFinite(d[1])) {
            errors.push(`${path}.target.dirs[${j}] must be a [df,dr] tuple of finite numbers`);
          } else if (d[0] === 0 && d[1] === 0) {
            errors.push(`${path}.target.dirs[${j}] is [0,0] - zero-vector direction loops forever`);
          }
        }
      }
      if (tgt.maxRange !== undefined) {
        if (!Number.isFinite(tgt.maxRange) || tgt.maxRange < 1 || tgt.maxRange > 8) {
          errors.push(`${path}.target.maxRange must be 1..8 when set`);
        }
      }
    }

    // Effect (Ship #2: composable primitive validation).
    if (!ab.effect || typeof ab.effect !== "object") {
      errors.push(`${path}.effect is required and must be an object`);
    } else {
      validateEffectPrimitive(`${path}.effect`, ab.effect, errors, /*nested*/ false);
    }

    // Gating.
    if (ab.gating !== undefined) {
      if (!ab.gating || typeof ab.gating !== "object") {
        errors.push(`${path}.gating must be an object when set`);
      } else {
        if (ab.gating.charges !== undefined) {
          if (!Number.isFinite(ab.gating.charges) || ab.gating.charges < 1 || ab.gating.charges > 99) {
            errors.push(`${path}.gating.charges must be 1..99 when set`);
          }
        }
        if (ab.gating.cooldownPlies !== undefined) {
          if (!Number.isFinite(ab.gating.cooldownPlies) || ab.gating.cooldownPlies < 1 || ab.gating.cooldownPlies > 20) {
            errors.push(`${path}.gating.cooldownPlies must be 1..20 when set`);
          }
        }
        if (ab.gating.startsOnCooldown !== undefined && typeof ab.gating.startsOnCooldown !== "boolean") {
          errors.push(`${path}.gating.startsOnCooldown must be a boolean when set`);
        }
      }
    } else {
      // Soft warning: ungated abilities can be balanced ("free
      // fireball every turn from any pawn") but they're easy to
      // misuse. The critic catches the truly broken cases via
      // simulation; this just nudges the AI toward sensible
      // gating during retry.
      warnings.push(`${pathPrefix}[${i}].gating is unset - ability "${ab.id}" has unlimited uses with no cooldown`);
    }
  }
}

/**
 * Validate a composable effect primitive (Ship #2).
 *
 * `nested` is true when this primitive is INSIDE an `aoe_wrap.inner`,
 * which forbids further nesting (no AOE-of-AOE) and forbids ability-level
 * concerns like AOE radius on an `aoe_wrap` at the top level.
 *
 * Mirror of the same logic in supabase/functions/arena_rules/index.ts -
 * any rule we add here MUST also land in the server validator.
 */
function validateEffectPrimitive(path, eff, errors, nested) {
  if (!eff || typeof eff !== "object") {
    errors.push(`${path}: must be an object`);
    return;
  }
  if (!KNOWN_ABILITY_EFFECT_KINDS.has(eff.kind)) {
    errors.push(`${path}.kind "${eff.kind}" is unknown (must be one of ${[...KNOWN_ABILITY_EFFECT_KINDS].join("/")})`);
    return;
  }

  // Per-primitive rules.
  if (eff.kind === "destroy" || eff.kind === "capture") {
    // Optional AOE for back-compat with Ship #1's
    // { kind: "capture", aoe: {...} }. New variants should use
    // aoe_wrap+destroy instead, but we still accept the legacy
    // shape.
    if (eff.aoe !== undefined) {
      if (!eff.aoe || typeof eff.aoe !== "object") {
        errors.push(`${path}.aoe must be an object when set`);
      } else {
        if (eff.aoe.radius !== undefined && (!Number.isFinite(eff.aoe.radius) || eff.aoe.radius < 0 || eff.aoe.radius > 3)) {
          errors.push(`${path}.aoe.radius must be 0..3 when set`);
        }
        if (eff.aoe.hitsPawns !== undefined && typeof eff.aoe.hitsPawns !== "boolean") {
          errors.push(`${path}.aoe.hitsPawns must be a boolean when set`);
        }
        if (eff.aoe.hitsFriendly !== undefined && typeof eff.aoe.hitsFriendly !== "boolean") {
          errors.push(`${path}.aoe.hitsFriendly must be a boolean when set`);
        }
      }
    }
    return;
  }

  if (eff.kind === "displace") {
    const hasDelta = Array.isArray(eff.delta);
    const hasDir = typeof eff.direction === "string";
    if (!hasDelta && !hasDir) {
      errors.push(`${path} must specify either 'delta' or 'direction'+'distance'`);
    }
    if (hasDelta) {
      if (eff.delta.length !== 2 || !Number.isFinite(eff.delta[0]) || !Number.isFinite(eff.delta[1])) {
        errors.push(`${path}.delta must be a [df,dr] tuple of finite numbers`);
      } else if (eff.delta[0] === 0 && eff.delta[1] === 0) {
        errors.push(`${path}.delta is [0,0] - displace must move the target somewhere`);
      } else if (Math.abs(eff.delta[0]) > 7 || Math.abs(eff.delta[1]) > 7) {
        errors.push(`${path}.delta components must be -7..7`);
      }
    }
    if (hasDir) {
      const validDirs = ["from_caster", "toward_caster", "toward_target_from_origin"];
      if (!validDirs.includes(eff.direction)) {
        errors.push(`${path}.direction must be one of ${validDirs.join("/")}`);
      }
      if (!Number.isFinite(eff.distance) || eff.distance < 1 || eff.distance > 7) {
        errors.push(`${path}.distance must be 1..7 when direction is set`);
      }
    }
    if (eff.onCollision !== undefined) {
      const validCollision = ["stop", "destroy_target", "destroy_collider", "destroy_both"];
      if (!validCollision.includes(eff.onCollision)) {
        errors.push(`${path}.onCollision must be one of ${validCollision.join("/")}`);
      }
    }
    if (eff.bounceOffEdge !== undefined && typeof eff.bounceOffEdge !== "boolean") {
      errors.push(`${path}.bounceOffEdge must be a boolean when set`);
    }
    return;
  }

  if (eff.kind === "relocate_self") {
    if (eff.destination !== undefined) {
      const valid = ["target", "adjacent_to_target", "caster_origin"];
      if (!valid.includes(eff.destination)) {
        errors.push(`${path}.destination must be one of ${valid.join("/")} when set`);
      }
    }
    return;
  }

  if (eff.kind === "spawn") {
    if (typeof eff.pieceType !== "string" || !SPAWNABLE_PIECE_TYPES.has(eff.pieceType)) {
      errors.push(`${path}.pieceType must be one of ${[...SPAWNABLE_PIECE_TYPES].join("/")} (kings can't be spawned)`);
    }
    if (eff.color !== undefined && eff.color !== "caster" && eff.color !== "enemy") {
      errors.push(`${path}.color must be 'caster' or 'enemy' when set`);
    }
    if (eff.lifespan !== undefined) {
      if (!Number.isFinite(eff.lifespan) || eff.lifespan < 1 || eff.lifespan > 30) {
        errors.push(`${path}.lifespan must be 1..30 when set`);
      }
    }
    return;
  }

  if (eff.kind === "transform") {
    const hasTypeChange = typeof eff.pieceType === "string";
    const hasColorChange = typeof eff.color === "string";
    if (!hasTypeChange && !hasColorChange) {
      errors.push(`${path} must specify at least one of 'pieceType' or 'color'`);
    }
    if (hasTypeChange && !ALL_PIECE_TYPES.has(eff.pieceType)) {
      errors.push(`${path}.pieceType must be one of ${[...ALL_PIECE_TYPES].join("/")}`);
    }
    if (hasColorChange && !["flip", "caster", "enemy"].includes(eff.color)) {
      errors.push(`${path}.color must be 'flip'/'caster'/'enemy'`);
    }
    if (eff.duration !== undefined) {
      if (!Number.isFinite(eff.duration) || eff.duration < 1 || eff.duration > 30) {
        errors.push(`${path}.duration must be 1..30 when set`);
      }
    }
    if (eff.revertOnCapture !== undefined && typeof eff.revertOnCapture !== "boolean") {
      errors.push(`${path}.revertOnCapture must be a boolean when set`);
    }
    return;
  }

  if (eff.kind === "mark") {
    if (typeof eff.tag !== "string" || !TAG_RE.test(eff.tag)) {
      errors.push(`${path}.tag must be lowercase letters/digits/underscores, 1-32 chars (got ${JSON.stringify(eff.tag)})`);
    }
    if (eff.duration !== undefined) {
      if (!Number.isFinite(eff.duration) || eff.duration < 1 || eff.duration > 30) {
        errors.push(`${path}.duration must be 1..30 when set`);
      }
    }
    if (eff.skipTurns !== undefined && typeof eff.skipTurns !== "boolean") {
      errors.push(`${path}.skipTurns must be boolean when set`);
    }
    if (eff.silenceAbilities !== undefined && typeof eff.silenceAbilities !== "boolean") {
      errors.push(`${path}.silenceAbilities must be boolean when set`);
    }
    if (eff.absorbCaptures !== undefined) {
      if (!Number.isFinite(eff.absorbCaptures) || eff.absorbCaptures < 1 || eff.absorbCaptures > 9) {
        errors.push(`${path}.absorbCaptures must be 1..9 when set`);
      }
    }
    if (eff.extraMoves !== undefined) {
      if (!Number.isFinite(eff.extraMoves) || eff.extraMoves < 1 || eff.extraMoves > 2) {
        errors.push(`${path}.extraMoves must be 1..2 when set`);
      }
    }
    if (eff.destroyOnExpire !== undefined && typeof eff.destroyOnExpire !== "boolean") {
      errors.push(`${path}.destroyOnExpire must be boolean when set`);
    }
    if (eff.expireOnCapture !== undefined && typeof eff.expireOnCapture !== "boolean") {
      errors.push(`${path}.expireOnCapture must be boolean when set`);
    }
    return;
  }

  if (eff.kind === "aoe_wrap") {
    if (nested) {
      errors.push(`${path}: aoe_wrap cannot be nested inside another aoe_wrap`);
      return;
    }
    if (!Number.isFinite(eff.radius) || eff.radius < 1 || eff.radius > 3) {
      errors.push(`${path}.radius must be 1..3`);
    }
    if (!eff.inner || typeof eff.inner !== "object") {
      errors.push(`${path}.inner must be an effect object`);
    } else {
      validateEffectPrimitive(`${path}.inner`, eff.inner, errors, /*nested*/ true);
    }
    if (eff.hitsPawns !== undefined && typeof eff.hitsPawns !== "boolean") {
      errors.push(`${path}.hitsPawns must be boolean when set`);
    }
    if (eff.hitsFriendly !== undefined && typeof eff.hitsFriendly !== "boolean") {
      errors.push(`${path}.hitsFriendly must be boolean when set`);
    }
    return;
  }
}

// ── Layer 2: starting position ─────────────────────────────

function validateStartingPosition(position, rules, errors, warnings) {
  // Both kings present unless the rules explicitly use
  // capture-king or last-standing as the only win condition.
  // Otherwise checkmate / stalemate detection breaks.
  const wKing = position.findKing("w");
  const bKing = position.findKing("b");
  const checkmateInRules = rules.winConditions?.some((wc) => wc.type === "checkmate");
  if (checkmateInRules) {
    if (!wKing) errors.push("starting position is missing the white king (required by checkmate rules)");
    if (!bKing) errors.push("starting position is missing the black king (required by checkmate rules)");
  } else {
    if (!wKing) warnings.push("starting position has no white king");
    if (!bKing) warnings.push("starting position has no black king");
  }

  // Side to move sanity.
  if (position.turn !== "w" && position.turn !== "b") {
    errors.push(`starting FEN has unknown side-to-move: ${position.turn}`);
  }

  // Legal-position sanity: neither king may start in check.
  //
  // Two distinct illegality modes are caught here:
  //
  //   1. Side-NOT-to-move is in check: their previous turn
  //      ended with their king attacked, which is impossible
  //      in any chess-like game. The position is fundamentally
  //      illegal regardless of variant rules.
  //   2. Side-TO-move is in check: while not strictly illegal
  //      (vanilla allows the active side to be in check at the
  //      start of their turn), starting a brand-new game with
  //      one side already needing to address check is
  //      asymmetric, confusing, and almost certainly not what
  //      the user asked for. Reject so the AI doesn't produce
  //      "kings in middle staring at each other through an
  //      open file" positions.
  //
  // Skipped for variants that don't even have a king-attack
  // model (no king on the board at all, e.g. last-standing
  // races without checkmate).
  const opponentColor = position.turn === "w" ? "b" : "w";
  const myKing = position.turn === "w" ? wKing : bKing;
  const oppKing = position.turn === "w" ? bKing : wKing;

  if (oppKing) {
    try {
      if (isSquareAttacked(position, oppKing, position.turn, rules)) {
        const oppName = opponentColor === "w" ? "white" : "black";
        errors.push(`starting position is illegal: ${oppName} king is in check before their turn began`);
      }
    } catch {
      // Defensive: if the move generator throws we don't want
      // to abort the whole validation - flag as a warning so
      // the rest of the checks still run.
      warnings.push("could not verify king-attack at start (move generator threw)");
    }
  }

  if (myKing) {
    try {
      if (isSquareAttacked(position, myKing, opponentColor, rules)) {
        const myName = position.turn === "w" ? "white" : "black";
        errors.push(`starting position is illegal: ${myName} king starts in check`);
      }
    } catch {
      // Already flagged above if it threw the first time;
      // don't duplicate the warning.
    }
  }

  // First mover must have at least one legal move; otherwise
  // the game ends immediately.
  const firstMoves = generateLegalMoves(position, rules);
  if (firstMoves.length === 0) {
    errors.push("starting position has zero legal moves for the first mover");
  }
}

// ── Layer 3: simulation ────────────────────────────────────

function simulate(rules, opts) {
  const games = Number.isFinite(opts.simulations) ? opts.simulations : 50;
  const plyCap = Number.isFinite(opts.simulationPlyCap) ? opts.simulationPlyCap : 200;
  const random = typeof opts.random === "function" ? opts.random : Math.random;

  let terminated = 0;
  let plyCapped = 0;
  let whiteWins = 0;
  let blackWins = 0;
  let draws = 0;

  for (let g = 0; g < games; g++) {
    let pos = Position.fromFen(rules.startingFen);
    let outcome = null;
    for (let ply = 0; ply < plyCap; ply++) {
      const status = checkGameStatus(pos, rules);
      if (status.ended) {
        outcome = status.winner;
        terminated += 1;
        break;
      }
      const legal = generateLegalMoves(pos, rules);
      if (legal.length === 0) {
        // Defensive: should have been caught by checkGameStatus
        // but break anyway to avoid an infinite loop.
        outcome = null;
        terminated += 1;
        break;
      }
      const pick = legal[Math.floor(random() * legal.length)];
      try {
        pos = applyMove(pos, pick, rules);
      } catch {
        // Move-gen produced something apply-move rejected -
        // shouldn't happen, but bail rather than crash.
        outcome = null;
        terminated += 1;
        break;
      }
    }
    if (outcome === null && terminated === g) {
      plyCapped += 1;
    }
    if (outcome === "w") whiteWins += 1;
    else if (outcome === "b") blackWins += 1;
    else draws += 1;
  }

  return {
    games,
    terminated,
    plyCapped,
    whiteWins,
    blackWins,
    draws,
  };
}

function interpretSimulationStats(stats, errors, warnings, _opts) {
  if (!stats) return;
  // Random-walk simulation is a noisy signal: in nontrivial
  // variants, random play almost never finds checkmate even
  // when the rules are perfectly fair. Treat ALL simulation
  // findings as soft warnings; the structural mobility check
  // in layer 3a is the real fairness gate.
  const termFrac = stats.terminated / Math.max(1, stats.games);
  if (termFrac < 0.2) {
    warnings.push(`only ${Math.round(termFrac * 100)}% of simulated games ended within the ply cap (random play struggles to find checkmate)`);
  }
  // Win-rate skew, but only relevant when at least 10 games
  // actually terminated. A "0 wins for black" out of 1
  // terminated game is sample-size noise, not a fairness
  // signal.
  if (stats.terminated >= 10) {
    if (stats.whiteWins === 0) {
      warnings.push("random simulation didn't surface a white win (small sample, may not reflect actual play)");
    }
    if (stats.blackWins === 0) {
      warnings.push("random simulation didn't surface a black win (small sample, may not reflect actual play)");
    }
    if (stats.whiteWins > 0 && stats.blackWins > 0) {
      const skew = Math.max(stats.whiteWins, stats.blackWins) / Math.min(stats.whiteWins, stats.blackWins);
      if (skew > 10) {
        warnings.push(`simulated win rate is ${stats.whiteWins}W / ${stats.blackWins}B - heavily skewed`);
      }
    }
  }
}
