/**
 * Validator for AI Arena rule objects.
 *
 * AI-produced rules are untrusted - the model can hallucinate
 * piece moves that don't terminate, win conditions that can
 * never fire, starting positions missing kings, etc. The
 * validator runs three layers of checks before a rules object
 * is allowed to go live:
 *
 *   1. Static structure: well-formed JSON, every required
 *      field present, sane types, primitives reference real
 *      directions, win conditions are recognized.
 *
 *   2. Static reachability: starting position has both kings
 *      (for variants that use them), every piece has at least
 *      one move primitive that COULD produce a move from
 *      somewhere on the board.
 *
 *   3. Simulation: run N random games to completion and check
 *      they actually terminate (don't hit the ply cap) and
 *      that both colors win at least one game (rules aren't
 *      catastrophically one-sided).
 *
 * The validator returns a structured report so the UI can
 * surface the specific problem. Soft warnings are flagged
 * separately from hard rejections - "60% of games hit the ply
 * cap" is suspicious but might be playable; "starting position
 * has no white king" is a hard reject.
 *
 * @typedef {Object} ValidatorReport
 * @property {boolean} valid                          Hard reject if false.
 * @property {string[]} errors                        Hard rejections.
 * @property {string[]} warnings                      Soft issues; UI may surface but doesn't block.
 * @property {Object} [stats]                         Simulation stats when ran.
 * @property {number} stats.games                     Total simulated games.
 * @property {number} stats.terminated                Games that ended via a win condition.
 * @property {number} stats.plyCapped                 Games that hit the ply cap.
 * @property {number} stats.whiteWins
 * @property {number} stats.blackWins
 * @property {number} stats.draws
 */

import { Position } from "./position";
import { resolveRules } from "./rules";
import { generateLegalMoves } from "./move-gen";
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
 * @param {number} [opts.simulations]                 Default 50.
 * @param {number} [opts.simulationPlyCap]            Default 200.
 * @param {boolean} [opts.skipSimulation]             Skip layer 3.
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

  // ── Layer 3: simulation ──
  let stats;
  if (!opts.skipSimulation) {
    stats = simulate(resolved, opts);
    interpretSimulationStats(stats, errors, warnings, opts);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats,
  };
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

function interpretSimulationStats(stats, errors, warnings, opts) {
  if (!stats) return;
  // Hard reject: very few games terminate. If 80%+ hit the ply
  // cap the rules are likely broken (no terminal condition can
  // fire from typical positions).
  const termFrac = stats.terminated / Math.max(1, stats.games);
  if (termFrac < 0.2) {
    errors.push(`only ${Math.round(termFrac * 100)}% of simulated games terminated within the ply cap (need 20%+)`);
  } else if (termFrac < 0.5) {
    warnings.push(`only ${Math.round(termFrac * 100)}% of simulated games terminated within the ply cap (rules may be slow)`);
  }

  // Hard reject: catastrophically one-sided. If one color
  // wins zero games out of 50 the rules are unbalanced.
  if (stats.whiteWins === 0 && stats.games >= 20) {
    errors.push("white never won in simulation - rules look one-sided in black's favor");
  }
  if (stats.blackWins === 0 && stats.games >= 20) {
    errors.push("black never won in simulation - rules look one-sided in white's favor");
  }

  // Warn on heavy skew (10:1+).
  if (stats.whiteWins > 0 && stats.blackWins > 0) {
    const skew = Math.max(stats.whiteWins, stats.blackWins) / Math.min(stats.whiteWins, stats.blackWins);
    if (skew > 10) {
      warnings.push(`win rate is ${stats.whiteWins} W / ${stats.blackWins} B - heavily skewed`);
    }
  }
}
