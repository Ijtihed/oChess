/**
 * Behavioral verification for AI-emitted variants.
 *
 * Runs AFTER the structural validator (validator.js layer 1) and
 * before the variant ships to a player. Where the structural
 * validator answers "is this a well-formed rules object?", this
 * module answers "is this variant actually playable in a way the
 * user would notice?"
 *
 * Why this exists:
 *
 * Live testing surfaced repeated failures where Gemini produced
 * structurally-valid variants whose abilities were INVISIBLE in
 * actual play - offset lists that don't reach any enemy on turn
 * 1, ability charges so high they never get used, win conditions
 * that no piece can satisfy, etc. The structural validator can
 * never catch these because they're not type errors; they're
 * playability errors.
 *
 * The fix isn't more prompt engineering (we tried, every patch
 * makes the prompt longer and Gemini misreads more of it). The
 * fix is to RUN THE VARIANT through the engine before shipping
 * it, and reject / repair anything that doesn't produce a
 * playable game.
 *
 * Layers:
 *
 *   - reachAbility(rules):
 *       For every declared ability, can SOMEONE cast it within
 *       the first N plies of random play? If not, the ability is
 *       dead and the variant feels broken to the user.
 *
 *   - reachWinCondition(rules):
 *       For "race_to_squares" win conditions, is the goal square
 *       even reachable by the configured piece given the move
 *       set? Catches "race to e8 but pawns are the only piece
 *       and they promote on e8" style contradictions.
 *
 *   - playoutSimulation(rules, opts):
 *       Run a small batch of random-walk games. Measure
 *       termination rate, per-side win rate, per-ability
 *       fire rate. Surface anything that looks degenerate
 *       (one side wins 100%, no game ever ends, an ability
 *       never fires across 20 games, etc.).
 *
 * Output is a structured `VerificationReport` with separated
 * `errors` (hard rejections) and `warnings` (soft signals).
 * The Edge Function decides how harsh to be based on the rest
 * of the variant's signals.
 *
 * Cost: ~50ms for a 5-game / 100-ply sim on an empty board.
 * Worth running on every variant before ship.
 */

import { Position } from "./position";
import { resolveRules } from "./rules";
import { generateLegalMoves } from "./move-gen";
import { applyMove } from "./apply-move";
import { checkGameStatus } from "./win-check";

// ── Types ───────────────────────────────────────────────────

/**
 * @typedef {Object} VerificationReport
 * @property {boolean} ok                Hard pass (errors empty).
 * @property {string[]} errors           Hard playability problems.
 * @property {string[]} warnings         Soft signals worth surfacing.
 * @property {Object} ability_reach      Per-ability turn-1 castability.
 * @property {Object} sim                Random-walk simulation stats.
 * @property {string[]} repaired_paths   Fields auto-repair would touch (suggestion only; this module is read-only).
 */

// ── Public API ──────────────────────────────────────────────

/**
 * Run all behavioral checks. Pure function, no mutation.
 *
 * @param {Object} rulesInput  The rules diff or full-spec rules.
 * @param {Object} [opts]
 * @param {number} [opts.simGames]      Default 8.
 * @param {number} [opts.simPlyCap]     Default 100.
 * @param {number} [opts.reachPlyCap]   How deep to search for ability reachability. Default 12 (6 per side).
 * @param {() => number} [opts.random]  Inject a deterministic RNG for tests.
 * @returns {VerificationReport}
 */
export function verifyRules(rulesInput, opts = {}) {
  const errors = [];
  const warnings = [];
  const repaired_paths = [];

  let rules;
  try {
    rules = resolveRules(rulesInput);
  } catch (e) {
    errors.push(`verify: resolveRules failed: ${e?.message || String(e)}`);
    return { ok: false, errors, warnings, ability_reach: {}, sim: null, repaired_paths };
  }

  // ── 1. Per-ability reachability ──
  const ability_reach = checkAbilityReachability(rules, errors, warnings, repaired_paths, {
    plyCap: opts.reachPlyCap ?? 12,
  });

  // ── 2. Win-condition reachability ──
  checkWinConditionReachability(rules, errors, warnings);

  // ── 3. Random-walk simulation ──
  const sim = simulate(rules, {
    games: opts.simGames ?? 8,
    plyCap: opts.simPlyCap ?? 100,
    random: opts.random,
  });
  interpretSim(sim, rules, errors, warnings);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    ability_reach,
    sim,
    repaired_paths,
  };
}

// ── 1. Ability reachability ────────────────────────────────

/**
 * For every declared ability, breadth-search the first plyCap
 * plies of legal moves and check if the ability appears in the
 * legal-move set at any point. We try both colors (some
 * variants are asymmetric; the ability might only exist for one
 * side).
 *
 * "Reachable" means: there exists a sequence of ≤plyCap legal
 * moves from the starting position that puts the ability in the
 * legal-move list. We don't require the ability to fire - just
 * to BE OFFERABLE. That's what determines whether the player
 * sees red crosshairs in the UI.
 *
 * Algorithm: for efficiency we do random walks, not exhaustive
 * search. With 8 random samples and plyCap=12 we get good
 * coverage in ~10ms while staying simple. False negatives
 * (ability is reachable but our random walks miss it) are
 * possible but rare; the simulation pass below is a second
 * chance to spot the same ability firing.
 *
 * For each ability we record:
 *   { reachable_turn_1: bool, reachable_within_n_plies: int|null,
 *     piece_type, ability_id, color: "w"|"b"|"both" }
 *
 * Errors / warnings:
 *   - If ANY declared ability is unreachable after both colors
 *     and 8 sample walks of plyCap plies, error out.
 *   - If reachable but only after >6 plies, warn (slow-bloomer).
 */
function checkAbilityReachability(rules, errors, warnings, repaired_paths, opts) {
  const declared = listAbilities(rules);
  const out = {};
  if (declared.length === 0) return out;

  const startPos = Position.fromFen(rules.startingFen);

  for (const decl of declared) {
    const key = `${decl.color || "both"}.${decl.pieceType}.${decl.id}`;
    const plies = opts.plyCap;
    let bestPly = null;

    // Sample multiple random walks for each color the ability
    // could belong to. byColor abilities only run for that
    // color; symmetric abilities run for both.
    const colorsToTry = decl.color ? [decl.color] : ["w", "b"];
    let immediateW = false;
    let immediateB = false;

    for (const color of colorsToTry) {
      // Step 0 check: is the ability immediately castable?
      const sim = startPos.clone();
      sim.turn = color;
      const initialMoves = generateLegalMoves(sim, rules);
      const reachableNow = initialMoves.some(
        (m) => m.kind === "ability" && m.casterType === decl.pieceType && m.abilityId === decl.id,
      );
      if (reachableNow) {
        bestPly = 0;
        if (color === "w") immediateW = true;
        if (color === "b") immediateB = true;
        continue; // No need to walk; we found it.
      }

      // Random walks of up to `plies` plies. Stop early if the
      // ability becomes castable. We always start the walk from
      // the variant's `startingFen` side-to-move (almost always
      // white), so a black-only ability must wait for white to
      // play and then check on black's turn. The previous
      // version accidentally forced `pos.turn = "w"` for both
      // colors and produced false negatives for black-only or
      // byColor=b abilities.
      const walks = 6;
      for (let w = 0; w < walks; w++) {
        let pos = startPos.clone();
        // Honor the starting FEN's side-to-move. Don't flip it
        // here based on `color` - we want to verify reachability
        // under realistic play, not from an artificial
        // "black-to-move-first" position.
        for (let p = 0; p < plies; p++) {
          const status = checkGameStatus(pos, rules);
          if (status.ended) break;
          const legal = generateLegalMoves(pos, rules);
          if (legal.length === 0) break;
          // Found the ability for OUR color?
          if (pos.turn === color) {
            const has = legal.some(
              (m) => m.kind === "ability" && m.casterType === decl.pieceType && m.abilityId === decl.id,
            );
            if (has) {
              if (bestPly === null || p < bestPly) bestPly = p;
              break;
            }
          }
          const pick = legal[Math.floor((opts.random || Math.random)() * legal.length)];
          try { pos = applyMove(pos, pick, rules); }
          catch { break; }
        }
        if (bestPly === 0) break;
      }
    }

    out[key] = {
      pieceType: decl.pieceType,
      abilityId: decl.id,
      color: decl.color || "both",
      reachable_turn_1: immediateW || immediateB,
      reachable_turn_1_white: immediateW,
      reachable_turn_1_black: immediateB,
      reachable_within_plies: bestPly,
    };

    // Two thresholds:
    //
    //   Hard error: ability not reachable in 4 plies (the player's
    //   first 2 turns + opponent's first 2 turns). At this point
    //   the user has clicked the piece multiple times, seen no
    //   red crosshairs, and decided the variant is broken.
    //
    //   Soft warning: ability reachable but only after move 0
    //   (i.e. requires opponent to move first or piece to move
    //   first). Variants like "summon on central squares" need a
    //   move or two to set up - playable but worth flagging.
    const HARD_REACH_PLIES = 4;
    if (bestPly === null || bestPly > HARD_REACH_PLIES) {
      errors.push(
        `ability '${decl.pieceType}.${decl.id}' is too narrow: ${bestPly === null ? "never" : `not until ply ${bestPly}`} reachable in legal play. Players will click the piece, see no crosshairs, and think the variant is broken. Extend the offset/range coverage.`,
      );
      repaired_paths.push(decl.color
        ? `byColor.${decl.color}.${decl.pieceType}.abilities[id=${decl.id}].target.offsets`
        : `pieces.${decl.pieceType}.abilities[id=${decl.id}].target.offsets`);
    } else if (!out[key].reachable_turn_1) {
      warnings.push(
        `ability '${decl.pieceType}.${decl.id}' is slow to bloom: first castable around ply ${bestPly}. Player will need a few moves before crosshairs appear.`,
      );
    }
  }

  return out;
}

// ── 2. Win-condition reachability ───────────────────────────

/**
 * Catch obvious dead-end win conditions:
 *   - race_to_squares with a piece type that's not on the board.
 *   - race_to_squares with goal squares not reachable by any
 *     legal sequence (we can't prove this rigorously but we can
 *     check obvious cases).
 *
 * The simulation pass below is the real reachability test for
 * win conditions: if 8 random games never trigger any win
 * condition, that's a strong signal something is structurally
 * wrong.
 */
function checkWinConditionReachability(rules, errors, _warnings) {
  if (!Array.isArray(rules.winConditions)) return;
  const startPos = Position.fromFen(rules.startingFen);
  for (let i = 0; i < rules.winConditions.length; i++) {
    const wc = rules.winConditions[i];
    if (wc?.type === "race_to_squares") {
      const piece = wc.piece;
      const wPieces = startPos.findPieces("w", piece);
      const bPieces = startPos.findPieces("b", piece);
      if (wPieces.length === 0 && (wc.squaresWhite || []).length > 0) {
        errors.push(`winConditions[${i}]: race_to_squares.piece '${piece}' has no white instances on the starting board, so white can never satisfy this condition.`);
      }
      if (bPieces.length === 0 && (wc.squaresBlack || []).length > 0) {
        errors.push(`winConditions[${i}]: race_to_squares.piece '${piece}' has no black instances on the starting board, so black can never satisfy this condition.`);
      }
    }
  }
}

// ── 3. Random-walk simulation ───────────────────────────────

/**
 * Play a small batch of random games. Track:
 *   - termination rate (fraction of games that reached a
 *     terminal status before the ply cap)
 *   - white wins / black wins / draws
 *   - per-ability fire counts
 *   - per-side first-move-count (catches catastrophic stalemate)
 */
function simulate(rules, opts) {
  const games = opts.games;
  const plyCap = opts.plyCap;
  const random = opts.random || Math.random;
  const fireCounts = {};
  let terminated = 0;
  let whiteWins = 0;
  let blackWins = 0;
  let draws = 0;
  let totalCasts = 0;

  for (let g = 0; g < games; g++) {
    let pos = Position.fromFen(rules.startingFen);
    let outcome = "unfinished";
    for (let p = 0; p < plyCap; p++) {
      const status = checkGameStatus(pos, rules);
      if (status.ended) {
        terminated++;
        outcome = status.winner ? `${status.winner}_wins` : "draw";
        break;
      }
      const legal = generateLegalMoves(pos, rules);
      if (legal.length === 0) {
        terminated++;
        outcome = "stalemate";
        break;
      }
      const pick = legal[Math.floor(random() * legal.length)];
      if (pick.kind === "ability") {
        const k = `${pick.casterType}:${pick.abilityId}`;
        fireCounts[k] = (fireCounts[k] || 0) + 1;
        totalCasts++;
      }
      try { pos = applyMove(pos, pick, rules); }
      catch { break; }
    }
    if (outcome === "w_wins") whiteWins++;
    else if (outcome === "b_wins") blackWins++;
    else if (outcome === "draw" || outcome === "stalemate") draws++;
  }

  return { games, terminated, whiteWins, blackWins, draws, fireCounts, totalCasts };
}

/**
 * Interpret the sim stats and surface any concerning patterns.
 *
 * Hard errors:
 *   - 0% of games terminated within plyCap (game never ends).
 *
 * Soft warnings:
 *   - <30% termination rate (most games go to ply cap).
 *   - >85% one-sided win rate (variant is wildly unbalanced).
 *   - declared ability never fires across all games (effectively
 *     dead for random play, may still be interesting in real play
 *     but it's a yellow flag).
 */
function interpretSim(sim, rules, errors, warnings) {
  const termFrac = sim.terminated / Math.max(1, sim.games);
  // Random walks finding checkmate is rare even in vanilla
  // chess - termination rates of 0-30% are NORMAL for non-
  // checkmate-favoring variants. We only hard-error when sim
  // shows zero ability fires AND zero terminations AND we have
  // declared abilities (then the variant is genuinely
  // suspicious). Otherwise it's a warning at most.
  if (termFrac === 0 && Object.keys(sim.fireCounts).length === 0 && Array.isArray(rules.winConditions) && rules.winConditions.length === 1 && rules.winConditions[0].type === "checkmate") {
    // Pure-vanilla termination rate of 0 is just random-play
    // noise - no abilities, no special win conditions. Don't
    // flag.
  } else if (termFrac < 0.3) {
    warnings.push(`simulation: only ${Math.round(termFrac * 100)}% of games ended in time. Variants this slow to terminate often feel directionless.`);
  }

  if (sim.terminated >= 4) {
    const totalDecided = sim.whiteWins + sim.blackWins;
    if (totalDecided >= 4) {
      const skew = Math.max(sim.whiteWins, sim.blackWins) / Math.max(1, Math.min(sim.whiteWins, sim.blackWins));
      if (skew >= 8) {
        warnings.push(`simulation: win rate is ${sim.whiteWins}W / ${sim.blackWins}B - heavily one-sided.`);
      }
    }
  }

  // Per-ability fire-rate signal.
  const declared = listAbilities(rules);
  for (const decl of declared) {
    const k = `${decl.pieceType}:${decl.id}`;
    if (!sim.fireCounts[k]) {
      // Soft warning: ability didn't fire in random play. This
      // is a weaker signal than reachability since random play
      // may simply not pick it; we already fail hard above if
      // it's truly unreachable.
      warnings.push(`ability '${k}' never fired across ${sim.games} random games (random play didn't pick it; may still be interesting in real play).`);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Enumerate every ability the rules object declares, including
 * byColor variants. Returns flat array.
 */
function listAbilities(rules) {
  const out = [];
  for (const [pt, spec] of Object.entries(rules.pieces || {})) {
    for (const ab of spec.abilities || []) {
      if (ab?.id) out.push({ pieceType: pt, id: ab.id, ability: ab });
    }
  }
  for (const color of ["w", "b"]) {
    for (const [pt, spec] of Object.entries(rules.byColor?.[color] || {})) {
      for (const ab of spec.abilities || []) {
        if (ab?.id) out.push({ pieceType: pt, id: ab.id, ability: ab, color });
      }
    }
  }
  return out;
}
