/**
 * Deterministic auto-repair for AI-emitted variants that fail
 * behavioral verification.
 *
 * The most common failure is "ability unreachable from the
 * starting position" - Gemini emits a too-narrow offset list
 * and the player sees no red crosshairs at game start. Rather
 * than re-prompting Gemini (slow, expensive, and the model
 * often makes the same mistake on retry), we PROGRAMMATICALLY
 * extend the offset list to a baseline coverage that
 * guarantees turn-1 reachability for any back-rank caster.
 *
 * Repair is conservative: we only extend, never remove or
 * shrink. The user-stated range cap is still honored as a
 * MINIMUM - if Gemini said "4 squares" we keep that as the
 * floor, but ensure offsets cover the full distance up to
 * 7 in case the starting board needs longer reach.
 *
 * Repair is a pure transformation: takes a rules diff in,
 * returns a new rules diff. The verifier is run again on the
 * repaired output to confirm we actually fixed the problem.
 *
 * What we DON'T try to repair:
 *   - Win conditions that can't fire (no piece can reach goal).
 *   - Asymmetric unfairness.
 *   - Self-contradicting rules.
 *   - Effect kinds we don't know about.
 *   - Anything outside ability targeting.
 *
 * Those failures get bounced back to Gemini via the repair-
 * retry loop in arena_rules/index.ts, which feeds the verifier
 * errors into a focused retry prompt. That's a separate
 * mechanism from this module.
 */

// ── Public API ──────────────────────────────────────────────

/**
 * Apply deterministic repairs to a rules diff based on a
 * verification report. Returns a NEW rules diff with repairs
 * applied (input is not mutated).
 *
 * @param {Object} rulesDiff           The original AI-emitted rules diff.
 * @param {import("./verification").VerificationReport} report
 * @returns {{ repaired: Object, applied: string[] }}
 *   `repaired` is the new rules diff. `applied` lists the human-
 *   readable fixes we applied so the Edge Function can log them.
 */
export function repairRules(rulesDiff, report) {
  const applied = [];
  if (!rulesDiff || typeof rulesDiff !== "object") {
    return { repaired: rulesDiff, applied };
  }
  if (!report || !Array.isArray(report.errors)) {
    return { repaired: rulesDiff, applied };
  }

  // Find every ability flagged as too-narrow by the verifier.
  // The verifier hard-errors when reachable_within_plies is null
  // (ability never castable) OR > the hard threshold (player
  // gives up before they see it). Repair both classes.
  const HARD_REACH_PLIES = 4;
  const unreachable = [];
  for (const [, info] of Object.entries(report.ability_reach || {})) {
    const ply = info?.reachable_within_plies;
    if (ply === null || (typeof ply === "number" && ply > HARD_REACH_PLIES)) {
      unreachable.push({
        color: info.color === "both" ? null : info.color,
        pieceType: info.pieceType,
        abilityId: info.abilityId,
      });
    }
  }
  if (unreachable.length === 0) return { repaired: rulesDiff, applied };

  // Deep-clone so we can mutate freely without leaking back.
  const out = JSON.parse(JSON.stringify(rulesDiff));

  for (const target of unreachable) {
    const ability = findAbility(out, target);
    if (!ability) continue;
    const did = extendAbilityReach(ability, target);
    if (did) applied.push(did);
  }

  return { repaired: out, applied };
}

// ── Ability lookup ──────────────────────────────────────────

/**
 * Locate an ability descriptor inside the (mutable) rules diff.
 * Returns the descriptor by reference so callers can mutate.
 */
function findAbility(rulesDiff, target) {
  const containers = [];
  if (target.color) {
    containers.push(rulesDiff?.byColor?.[target.color]?.[target.pieceType]);
  } else {
    containers.push(rulesDiff?.pieces?.[target.pieceType]);
    containers.push(rulesDiff?.byColor?.w?.[target.pieceType]);
    containers.push(rulesDiff?.byColor?.b?.[target.pieceType]);
  }
  for (const spec of containers) {
    if (!spec || !Array.isArray(spec.abilities)) continue;
    const ab = spec.abilities.find((a) => a?.id === target.abilityId);
    if (ab) return ab;
  }
  return null;
}

// ── Extension strategy ─────────────────────────────────────

/**
 * Mutate the ability's targeting in place to extend reach.
 *
 * Strategy by target.kind:
 *
 * "ranged" / "leap":
 *   Union the existing offsets with a baseline coverage set.
 *   The baseline is a queen-shaped fan at distances 1..7 in
 *   8 directions (56 offsets), PLUS the 8 knight-jump offsets
 *   (= 64 total). This guarantees turn-1 reachability from any
 *   back-rank piece against the standard starting board, while
 *   preserving any unusual offsets the AI emitted (which might
 *   be central to the variant's flavor).
 *
 * "slide":
 *   Slide kinds reach the back rank automatically as long as
 *   `dirs` covers the relevant directions. If `dirs` is missing
 *   any of the 8 standard directions, we union them in. We also
 *   strip `maxRange` if it's set to <8 - the value of slide is
 *   reaching the back rank, so capping it short defeats the
 *   purpose.
 *
 * Returns a string describing what was changed, or null if no
 * repair was possible.
 */
function extendAbilityReach(ability, target) {
  const tgt = ability.target;
  if (!tgt || typeof tgt !== "object") return null;

  if (tgt.kind === "ranged" || tgt.kind === "leap") {
    const before = (tgt.offsets || []).length;
    const merged = unionOffsets(tgt.offsets || [], BASELINE_QUEEN_FAN_PLUS_KNIGHT);
    tgt.offsets = merged;
    return `extended ${target.color ? `byColor.${target.color}.` : ""}pieces.${target.pieceType}.abilities[${target.abilityId}].target.offsets from ${before} to ${merged.length} entries (added baseline queen-fan + knight-jumps for guaranteed turn-1 reach)`;
  }

  if (tgt.kind === "slide") {
    let changed = false;
    const fixes = [];
    const haveDirs = tgt.dirs || [];
    const merged = unionOffsets(haveDirs, ALL_8_DIRECTIONS);
    if (merged.length !== haveDirs.length) {
      tgt.dirs = merged;
      fixes.push("filled missing directions");
      changed = true;
    }
    if (Number.isFinite(tgt.maxRange) && tgt.maxRange < 8) {
      delete tgt.maxRange;
      fixes.push("removed maxRange cap");
      changed = true;
    }
    // The most common slide-unreachable failure on a starting
    // chess board is blockedByPieces=true with the caster on
    // the back rank, where pawns wall the queen / bishop /
    // rook in. Flipping to blockedByPieces=false makes the
    // ability behave like a spell that reaches through blockers,
    // which is what most "long-range spell" prompts actually want
    // even when the AI literally said "slide".
    if (tgt.blockedByPieces !== false) {
      tgt.blockedByPieces = false;
      fixes.push("flipped blockedByPieces=false (so the slide reaches through opening-rank pawns)");
      changed = true;
    }
    if (!changed) return null;
    return `extended ${target.color ? `byColor.${target.color}.` : ""}pieces.${target.pieceType}.abilities[${target.abilityId}].target: ${fixes.join(", ")}`;
  }

  return null;
}

// ── Constants ───────────────────────────────────────────────

/**
 * Baseline 56-offset queen-fan (8 directions × distances 1..7)
 * + 8 standard knight-jumps. Covers everything a back-rank
 * piece could reasonably need to reach in the opening.
 */
const BASELINE_QUEEN_FAN_PLUS_KNIGHT = (() => {
  const out = [];
  // Queen fan ranges 1..7
  for (let n = 1; n <= 7; n++) {
    out.push([n, 0], [-n, 0], [0, n], [0, -n]);
    out.push([n, n], [-n, n], [n, -n], [-n, -n]);
  }
  // Knight jumps
  out.push([1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]);
  return out;
})();

const ALL_8_DIRECTIONS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [-1, 1], [1, -1], [-1, -1],
];

// ── Set operations on offset arrays ─────────────────────────

function unionOffsets(a, b) {
  const seen = new Set();
  const out = [];
  for (const v of [...a, ...b]) {
    if (!Array.isArray(v) || v.length !== 2) continue;
    if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) continue;
    if (v[0] === 0 && v[1] === 0) continue; // never include [0,0]
    const key = `${v[0]},${v[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([v[0], v[1]]);
  }
  return out;
}
