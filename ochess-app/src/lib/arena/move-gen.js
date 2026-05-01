/**
 * Move generation for AI Arena.
 *
 * Drives off the structured rules object: every piece spec is a
 * list of move primitives (slide / leap / step), and the
 * generator produces every legal move by unioning their
 * outputs and then filtering anything that would leave / put
 * the friendly king in check (when checkmate is the active win
 * condition).
 *
 * White-relative direction conventions: every primitive's
 * `[df, dr]` tuple is from White's POV. For Black pieces we
 * negate `dr` so a step `[0, 1]` (forward for white) means
 * `[0, -1]` (forward for black) too.
 *
 * The generator depends only on:
 *   - `Position` for board state + tracking castling rights / en
 *     passant target,
 *   - the resolved Rules object for piece move specs and
 *     win-condition info (we only check king-safety when
 *     "checkmate" is in the win conditions).
 *
 * No mutation of Position - the generator either reads or
 * clones to simulate. apply-move.js is what actually plays
 * moves.
 */

import { pieceSpecFor } from "./rules";
import {
  squareToFR,
  frToSquare,
  inBounds,
  squareToIndex,
} from "./position";
import { applyMoveRaw } from "./apply-move";
import { pieceEffectiveState } from "./effects";

// ── Public API ──────────────────────────────────────────────

/**
 * Generate every legal move for the side-to-move.
 *
 * "Legal" means:
 *   - the piece can produce the move per its rule spec, AND
 *   - the move doesn't leave the friendly king in check, when
 *     "checkmate" is in the active win conditions. For
 *     non-checkmate variants (like "capture_king" or
 *     "first_to_n_captures"), pseudo-legal moves are returned -
 *     leaving your king attacked is the LOSS, not illegal.
 *
 * @param {import("./position").Position} position
 * @param {import("./schema").Rules}     rules
 * @returns {import("./schema").Move[]}
 */
export function generateLegalMoves(position, rules) {
  const pseudo = generatePseudoMoves(position, rules);
  if (!hasCheckmateRule(rules)) return pseudo;
  // Filter out self-checks. A move is illegal under classical
  // rules iff playing it leaves your own king attacked.
  return pseudo.filter((mv) => !leavesOwnKingInCheck(position, mv, rules));
}

/**
 * Pseudo-legal move generation: every move the piece spec
 * permits, ignoring king-safety. Useful for the "is this
 * square attacked" check that king-safety filtering needs.
 *
 * `opts.excludeCastling` skips castling generation. Used by
 * `isSquareAttacked` to break the addCastlingMoves ->
 * isSquareAttacked recursion - castling can't capture so it
 * never threatens any square.
 *
 * `opts.excludeAbilities` skips ability generation. Used by
 * `isSquareAttacked` so that ability-targeting (a "fireball at
 * e7") doesn't count as a king-attack for check detection -
 * abilities are turn-replacing actions, not threats. Without
 * this we'd over-detect check.
 */
export function generatePseudoMoves(position, rules, opts = {}) {
  const out = [];
  const me = position.turn;
  const includeCastling = !opts.excludeCastling;
  const includeAbilities = !opts.excludeAbilities;
  for (let i = 0; i < 64; i++) {
    const pc = position.board[i];
    if (!pc || pc.color !== me) continue;
    const file = i % 8;
    const rank = (i - file) / 8;
    const from = frToSquare([file, rank]);
    const spec = pieceSpecFor(rules, pc);
    if (!spec) continue;
    // Ship #2: status-mark gating. A piece with a `skipTurns`
    // mark contributes ZERO moves (frozen / stunned). A piece
    // with `silenceAbilities` contributes movement moves but
    // no ability casts.
    const effState = pieceEffectiveState(position, from);
    if (effState.skipTurns) continue;
    for (const prim of spec.moves || []) {
      if (effState.canMove) {
        addPrimitiveMoves(out, position, rules, pc, [file, rank], from, prim);
      }
    }
    // Castling - only for kings, only when their spec says so,
    // and only when the caller hasn't asked us to skip it.
    if (includeCastling && effState.canMove && pc.type === "k" && spec.castling) {
      addCastlingMoves(out, position, rules, pc, [file, rank], from, spec);
    }
    // Active abilities (AI Arena Ship #1+). Each ability emits
    // one or more candidate target squares; the engine treats
    // ability casts as turn-replacing moves with kind="ability".
    // Castles and abilities are mutually exclusive on a given
    // turn - the player picks one or the other. Silenced pieces
    // skip ability generation but can still move normally.
    if (includeAbilities && effState.canCast && Array.isArray(spec.abilities)) {
      for (const ability of spec.abilities) {
        addAbilityMoves(out, position, rules, pc, [file, rank], from, ability);
      }
    }
  }
  return out;
}

/**
 * Check whether `square` is attacked by any piece of `byColor`
 * in the given position. Used by king-safety filtering.
 *
 * Implementation: generate `byColor`'s pseudo moves on a
 * snapshot where it's their turn, EXCLUDING castling, and see
 * if any move's `to` matches the target square. Castling can't
 * capture so it never threatens; including it would create a
 * cycle between addCastlingMoves -> isSquareAttacked ->
 * generatePseudoMoves -> addCastlingMoves -> ... and stack
 * overflow.
 *
 * Slow but correct - for speed we'd cache attack maps, but we
 * can afford the simpler version given the engine isn't
 * running in a tournament setting.
 */
export function isSquareAttacked(position, square, byColor, rules) {
  const sim = position.turn === byColor ? position : position.clone();
  if (sim !== position) sim.turn = byColor;
  return generatePseudoMoves(sim, rules, { excludeCastling: true, excludeAbilities: true })
    .some((mv) => mv.to === square);
}

// ── Primitive expansion ─────────────────────────────────────

function addPrimitiveMoves(out, position, rules, piece, fromFR, fromSq, prim) {
  if (!prim || typeof prim !== "object") return;
  const flip = piece.color === "b" ? -1 : 1;

  if (prim.kind === "slide") {
    if (!Array.isArray(prim.dirs)) return;
    const max = Number.isFinite(prim.maxRange) ? prim.maxRange : 8;
    for (const [df, dr] of prim.dirs) {
      let f = fromFR[0];
      let r = fromFR[1];
      for (let step = 0; step < max; step++) {
        f += df;
        r += dr * flip;
        if (!inBounds([f, r])) break;
        const targetSq = frToSquare([f, r]);
        const targetPc = position.pieceAt(targetSq);
        if (!targetPc) {
          out.push({ from: fromSq, to: targetSq });
          continue;
        }
        if (targetPc.color !== piece.color) {
          out.push({ from: fromSq, to: targetSq });
        }
        break; // friend or enemy, slide is blocked beyond.
      }
    }
    return;
  }

  if (prim.kind === "leap") {
    if (!Array.isArray(prim.offsets)) return;
    for (const [df, dr] of prim.offsets) {
      const f = fromFR[0] + df;
      const r = fromFR[1] + dr * flip;
      if (!inBounds([f, r])) continue;
      const targetSq = frToSquare([f, r]);
      const targetPc = position.pieceAt(targetSq);
      if (targetPc && targetPc.color === piece.color) continue;
      out.push({ from: fromSq, to: targetSq });
    }
    return;
  }

  if (prim.kind === "step") {
    if (!Array.isArray(prim.dirs)) return;
    const cond = prim.conditions || {};
    const promotionTypes = pieceSpecFor(rules, piece)?.promotion?.type || null;
    for (const [df, dr] of prim.dirs) {
      const f = fromFR[0] + df;
      const r = fromFR[1] + dr * flip;
      if (!inBounds([f, r])) continue;
      const targetSq = frToSquare([f, r]);
      const targetPc = position.pieceAt(targetSq);

      if (cond.onlyFirstMove) {
        if (!isOnStartingRank(piece, fromFR)) continue;
        // Multi-square steps need every intermediate empty.
        if (!intermediateClear(position, fromFR, [f, r])) continue;
      }
      if (cond.onlyCapture) {
        if (!targetPc) continue;
        if (targetPc.color === piece.color) continue;
      }
      if (cond.onlyNonCapture) {
        if (targetPc) continue;
      }
      if (cond.enPassant) {
        // En passant is only legal when the position's enPassant
        // target square matches AND the destination is empty.
        // The captured pawn lives one rank back from the
        // destination (on the rank we came from).
        if (!position.enPassant) continue;
        if (targetSq !== position.enPassant) continue;
        if (targetPc) continue;
        out.push({ from: fromSq, to: targetSq, enPassant: true });
        continue;
      }
      // Already filtered by cond.* above. Now decide whether
      // this is a promotion or a plain step.
      if (promotionTypes && isOnPromotionRank(piece, [f, r])) {
        for (const promoType of promotionTypes) {
          out.push({ from: fromSq, to: targetSq, promotion: promoType });
        }
      } else {
        out.push({ from: fromSq, to: targetSq });
      }
    }
    return;
  }
}

// ── Active abilities (AI Arena) ────────────────────────────

/**
 * Emit ability-cast moves for a single ability owned by a
 * piece. Ability moves are turn-replacing actions: instead of
 * moving, the piece spends a charge or starts a cooldown to
 * apply an effect at a target square within range.
 *
 * Ship #1: only `target.kind === "ranged"` and
 * `effect.kind === "capture"` are wired through. Future ships
 * add slide/leap targeting for empty squares (summon,
 * teleport) and freeze/burn/shield/swap effects.
 *
 * Charges and cooldowns live in the position's `crazyState`
 * sidecar (see `crazy-state.js` from Ship #2). For Ship #1 the
 * sidecar is optional - if it's absent, abilities are
 * effectively unlimited (which matches "no gating" semantics).
 *
 * Each emitted move has shape:
 *   { from, to, kind: "ability", abilityId, casterType, intensity }
 *
 * `to` is the target square. The caster does NOT move; that's
 * resolved by `apply-move.js` which knows to keep the piece
 * on its origin square for ability moves.
 */
function addAbilityMoves(out, position, rules, piece, fromFR, fromSq, ability) {
  if (!ability || typeof ability !== "object") return;
  if (typeof ability.id !== "string" || ability.id.length === 0) return;
  if (!ability.target || typeof ability.target !== "object") return;
  if (!ability.effect || typeof ability.effect !== "object") return;

  // Cooldown / charge gating. If the position has no crazyState
  // (pre-Ship-#2), assume unlimited - the engine still resolves
  // the ability correctly without it.
  const cs = position.crazyState;
  if (cs) {
    const cooldown = cs.cooldowns?.[fromSq]?.[ability.id];
    if (Number.isFinite(cooldown) && cooldown > 0) return;
    const charges = cs.charges?.[fromSq]?.[ability.id];
    if (Number.isFinite(charges) && charges <= 0) return;
  }

  const target = ability.target;
  const kind = target.kind;
  // Compute final filter constraints by combining the AI's
  // explicit `requireEnemy`/`requireEmpty` flags with the
  // requirements implied by the EFFECT kind. Without this,
  // an ability declared as "spawn" with the AI's flags loose
  // (or missing) would be offered as a valid cast on enemy
  // squares too - and then the resolver would throw "spawn:
  // target is not empty" mid-cast, surfacing as a red error
  // toast even though the ability is well-formed. Tightening
  // here means the player never sees "valid" crosshairs that
  // can't actually fire.
  const filter = computeTargetFilter(target, ability.effect);
  const flip = piece.color === "b" ? -1 : 1;
  const intensity = ability.intensity === "brief" || ability.intensity === "dramatic"
    ? ability.intensity
    : "medium";

  const candidates = [];

  if (kind === "ranged" || kind === "leap") {
    const offsets = Array.isArray(target.offsets) ? target.offsets : [];
    for (const [df, dr] of offsets) {
      if (!Number.isFinite(df) || !Number.isFinite(dr)) continue;
      const f = fromFR[0] + df;
      const r = fromFR[1] + dr * flip;
      if (!inBounds([f, r])) continue;
      candidates.push([f, r]);
    }
  } else if (kind === "slide") {
    const dirs = Array.isArray(target.dirs) ? target.dirs : [];
    const max = Number.isFinite(target.maxRange) ? target.maxRange : 8;
    const blocked = target.blockedByPieces !== false; // default true
    for (const [df, dr] of dirs) {
      if (!Number.isFinite(df) || !Number.isFinite(dr)) continue;
      let f = fromFR[0];
      let r = fromFR[1];
      for (let step = 0; step < max; step++) {
        f += df;
        r += dr * flip;
        if (!inBounds([f, r])) break;
        candidates.push([f, r]);
        // If blocked, the line stops once we hit any piece; we
        // still allow targeting that occupied square (so a
        // fireball can hit through to the first piece in line),
        // but anything beyond is out of reach.
        if (blocked && position.board[f + r * 8]) break;
      }
    }
  } else {
    return; // unknown target kind - silently skip; validator catches it.
  }

  for (const [f, r] of candidates) {
    const targetSq = frToSquare([f, r]);
    const targetPc = position.board[f + r * 8];

    if (filter.requireEmpty && targetPc) continue;
    if (filter.requireFilled && !targetPc) continue;
    if (filter.requireEnemy && targetPc && targetPc.color === piece.color) continue;
    if (filter.requireFriendly && targetPc && targetPc.color !== piece.color) continue;

    out.push({
      from: fromSq,
      to: targetSq,
      kind: "ability",
      abilityId: ability.id,
      casterType: piece.type,
      intensity,
    });
  }
}

/**
 * Combine the ability's declared `target.requireEnemy` /
 * `requireEmpty` flags with the implied requirements of the
 * effect itself. Returns a unified filter object the candidate
 * loop can apply uniformly:
 *
 *   { requireEmpty, requireFilled, requireEnemy, requireFriendly }
 *
 * Why this exists: the effect resolvers in effects.js have
 * implicit assumptions ("displace needs a piece at target",
 * "spawn needs an empty target"). When the AI emits a sloppy
 * target spec (no requireEnemy / no requireEmpty), move-gen
 * would otherwise emit unreachable casts that throw mid-resolve
 * and surface as confusing red error toasts. Tightening here
 * means the user only sees crosshairs the engine can actually
 * fulfill.
 */
function computeTargetFilter(target, effect) {
  // Start from the AI's explicit flags. requireEnemy defaults
  // true on ranged/leap targets (matches Ship #1 behaviour);
  // requireEmpty defaults false.
  const aiRequireEnemy = target.requireEnemy !== false;
  const aiRequireEmpty = target.requireEmpty === true;

  const filter = {
    requireEmpty: aiRequireEmpty,
    requireFilled: false,
    requireEnemy: false,
    requireFriendly: false,
  };
  if (aiRequireEnemy) {
    filter.requireFilled = true;
    filter.requireEnemy = true;
  }

  // Effect-kind implications. Most effects imply something
  // about whether the target should/shouldn't have a piece.
  const ek = effect?.kind;
  if (ek === "spawn") {
    // Spawn always requires an empty target square.
    filter.requireEmpty = true;
    filter.requireFilled = false;
    filter.requireEnemy = false;
    filter.requireFriendly = false;
  } else if (ek === "destroy" || ek === "capture") {
    // Destroy needs a piece on the target. Honor hitsFriendly
    // for the AOE inner; the direct-target piece must still
    // be hittable. Default is hit-enemies-only.
    filter.requireFilled = true;
    if (effect.aoe?.hitsFriendly !== true) {
      filter.requireEnemy = true;
    }
  } else if (ek === "displace" || ek === "transform" || ek === "mark") {
    // These need a piece to act on. We don't strictly require
    // enemy - a "shield ally" mark or a "swap with friend"
    // displace could legitimately target a friendly. Honor
    // the AI's requireEnemy flag here without overriding it.
    filter.requireFilled = true;
  } else if (ek === "relocate_self") {
    // Caster moves to the target. Empty is the safe default
    // unless requireEnemy is set (capture-on-arrival pattern).
    if (!aiRequireEnemy) {
      filter.requireEmpty = true;
      filter.requireFilled = false;
      filter.requireEnemy = false;
    }
  } else if (ek === "aoe_wrap") {
    // AOE either acts on existing pieces or spawns; the inner
    // primitive's filter applies at each AOE square (handled
    // by resolveAOEWrap), so the centre target's requirement
    // depends on the inner. Use the inner's filter for the
    // centre.
    return computeTargetFilter(target, effect.inner);
  }

  return filter;
}

// ── Castling ────────────────────────────────────────────────

function addCastlingMoves(out, position, rules, piece, fromFR, fromSq, spec) {
  // Castling only fires on the king's standard rank. We hardwire
  // those (rank 0 for white, rank 7 for black) to keep things
  // tractable - variants that put the king elsewhere can disable
  // castling entirely.
  const expectedRank = piece.color === "w" ? 0 : 7;
  if (fromFR[1] !== expectedRank) return;
  const rights = position.castling[piece.color];
  if (!rights) return;
  const castling = spec.castling;
  if (!castling) return;

  if (spec.castling.requireUnmoved && !(rights.kingside || rights.queenside)) {
    return; // Both sides revoked already.
  }

  const checks = {
    kingside: { allowed: !!castling.kingside && rights.kingside, rookFile: 7, kingTargetFile: 6, betweenFiles: [5, 6], safeFiles: [4, 5, 6] },
    queenside: { allowed: !!castling.queenside && rights.queenside, rookFile: 0, kingTargetFile: 2, betweenFiles: [1, 2, 3], safeFiles: [4, 3, 2] },
  };

  for (const [side, cfg] of Object.entries(checks)) {
    if (!cfg.allowed) continue;
    // Rook present at expected file?
    const rookSq = frToSquare([cfg.rookFile, expectedRank]);
    const rook = position.pieceAt(rookSq);
    if (!rook || rook.type !== "r" || rook.color !== piece.color) continue;
    // Squares between king and rook clear?
    if (!cfg.betweenFiles.every((f) => !position.pieceAt(frToSquare([f, expectedRank])))) continue;
    // King doesn't pass through check - but ONLY if checkmate
    // is the active win condition. Variants that don't care
    // about check (capture-king, etc.) skip this so a king CAN
    // castle through attacked squares.
    if (hasCheckmateRule(rules)) {
      const enemy = piece.color === "w" ? "b" : "w";
      const passes = cfg.safeFiles.every(
        (f) => !isSquareAttacked(position, frToSquare([f, expectedRank]), enemy, rules),
      );
      if (!passes) continue;
    }
    out.push({
      from: fromSq,
      to: frToSquare([cfg.kingTargetFile, expectedRank]),
      castling: true,
      castlingSide: side,
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────

function hasCheckmateRule(rules) {
  return Array.isArray(rules.winConditions) && rules.winConditions.some((wc) => wc?.type === "checkmate");
}

/** True iff the piece is on its color-relative starting rank. Used by `onlyFirstMove`. */
function isOnStartingRank(piece, fromFR) {
  if (piece.type === "p") {
    return piece.color === "w" ? fromFR[1] === 1 : fromFR[1] === 6;
  }
  return false;
}

/** True iff the piece is moving onto its promotion rank (used for pawns). */
function isOnPromotionRank(piece, toFR) {
  if (piece.type === "p") {
    return piece.color === "w" ? toFR[1] === 7 : toFR[1] === 0;
  }
  return false;
}

/**
 * For multi-square steps (e.g. 2-square pawn jump), every
 * intermediate square must be empty for the move to be legal.
 * The single-square case has nothing to check.
 */
function intermediateClear(position, fromFR, toFR) {
  const [f0, r0] = fromFR;
  const [f1, r1] = toFR;
  const stepF = Math.sign(f1 - f0);
  const stepR = Math.sign(r1 - r0);
  let f = f0 + stepF;
  let r = r0 + stepR;
  while (f !== f1 || r !== r1) {
    if (position.pieceAt(frToSquare([f, r]))) return false;
    f += stepF;
    r += stepR;
  }
  return true;
}

/**
 * Apply a move on a clone and check whether the friendly king
 * is now under attack. Used by the legal-move filter.
 *
 * Ability moves don't relocate the caster, so the only way an
 * ability can leave the king in check is if the ability
 * itself happens to be cast BY the king (rare) or if the AOE
 * blast from the ability removes a friendly defender. We
 * still funnel through the same path - apply, then test - so
 * both kinds of moves obey the same "you can't leave your king
 * attacked" rule.
 */
function leavesOwnKingInCheck(position, move, rules) {
  const us = position.turn;
  const next = applyMoveRaw(position, move, rules);
  if (!next) return true; // Move couldn't be applied = treat as illegal.
  const ourKing = next.findKing(us);
  if (!ourKing) {
    // No king to check - whatever happened, it's not "leaves
    // king in check" (the variant either has no kings or just
    // captured ours). Treat as not-illegal so the apply path
    // can decide game-over via the win-conditions.
    return false;
  }
  const enemy = us === "w" ? "b" : "w";
  return isSquareAttacked(next, ourKing, enemy, rules);
}

// Re-export for tests + external consumers.
export { squareToIndex };
