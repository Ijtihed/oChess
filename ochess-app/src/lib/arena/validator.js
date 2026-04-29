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
