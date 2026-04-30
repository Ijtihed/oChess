/**
 * Apply a move to a Position, producing a NEW Position with
 * the move played. Mutation only happens on the clone - the
 * original Position is untouched, so the move generator can
 * cheaply simulate without risking bleed-through.
 *
 * Two entry points:
 *
 *   - `applyMoveRaw(position, move, rules)`  no validation,
 *     just plays the move. Used by move-gen's king-safety
 *     filter (it has already vetted the move against the
 *     piece spec).
 *
 *   - `applyMove(position, move, rules)`  validates against
 *     `generateLegalMoves` first; throws if the move isn't in
 *     the legal list. This is what the UI / 1v1 sync code
 *     should call.
 *
 * Capture effects supported: standard remove, atomic-style
 * explosion radius, color-conversion. New effects can be
 * added without touching the move generator - the rule object
 * is the single source of truth.
 */

import { Chess } from "chess.js";
import { generateLegalMoves } from "./move-gen";
import { pieceSpecFor } from "./rules";
import {
  squareToFR,
  frToSquare,
  inBounds,
} from "./position";
import {
  resolveEffect,
  tickMarks,
  tryAbsorbCapture,
  dropExpireOnCaptureMarks,
} from "./effects";

/**
 * Validated version: call this from the UI / network sync.
 * Throws if `move` isn't in the legal list under the current
 * rules.
 *
 * Ship #2 strict-failure: if the move is legal but its effect
 * resolver fails (e.g. a malformed ability descriptor produces
 * an off-board target at runtime), this throws an Error
 * tagged with `name === "VariantError"` so the lobby can
 * display "variant error - match cancelled" rather than a
 * generic illegal-move toast.
 */
export function applyMove(position, move, rules) {
  if (!move || typeof move !== "object") throw new Error("move must be an object");
  const legal = generateLegalMoves(position, rules);
  const match = legal.find((m) => sameMove(m, move));
  if (!match) {
    throw new Error(`illegal move ${move.from}${move.to}${move.promotion ? `=${move.promotion}` : ""}`);
  }
  // Clear any stale resolver-error message before applying so
  // the next cast doesn't pick up a previous match's debris.
  position.lastEffectError = null;
  const next = applyMoveRaw(position, match, rules);
  if (!next) {
    const detail = position.lastEffectError || "effect resolver returned null";
    const err = new Error(`variant error: ${detail}`);
    err.name = "VariantError";
    throw err;
  }
  return next;
}

/**
 * Raw version: apply without legality check. Returns a fresh
 * Position. Returns null if the move would be a no-op (target
 * square is friendly) - shouldn't happen with a properly-
 * generated move but defends against bad input.
 */
export function applyMoveRaw(position, move, rules) {
  if (!move?.from || !move?.to) return null;
  const next = position.clone();
  const moverFR = squareToFR(move.from);
  const targetFR = squareToFR(move.to);
  if (!moverFR || !targetFR) return null;

  const piece = next.pieceAt(move.from);
  if (!piece) return null;

  // Ability casts (AI Arena Ship #1+) are turn-replacing
  // actions: the caster does NOT move, the target square is
  // resolved per the ability's effect, and charges/cooldowns
  // are decremented. They share the side-to-move-flip and
  // history-append bookkeeping with regular moves but skip
  // castling rights, en-passant, and promotion entirely.
  if (move.kind === "ability") {
    return applyAbilityMove(next, position, move, rules, piece, moverFR, targetFR);
  }

  // ── Move classification ──
  // Pull these out so the post-move bookkeeping (en passant,
  // castling rights, captures, halfmove clock) can use them
  // without recomputing.
  const isCastle = !!move.castling;
  const isEnPassant = !!move.enPassant;
  const isPromotion = !!move.promotion;
  let captured = null;

  // ── Castling: move both pieces ──
  if (isCastle) {
    const rank = moverFR[1];
    const kingTargetFile = move.castlingSide === "kingside" ? 6 : 2;
    const rookFromFile = move.castlingSide === "kingside" ? 7 : 0;
    const rookToFile = move.castlingSide === "kingside" ? 5 : 3;
    next.setSquare(move.from, null);
    next.setSquare(frToSquare([rookFromFile, rank]), null);
    next.setSquare(frToSquare([kingTargetFile, rank]), piece);
    next.setSquare(frToSquare([rookToFile, rank]), { type: "r", color: piece.color });
    next.castling[piece.color] = { kingside: false, queenside: false };
    next.enPassant = null;
    next.history.push({ ...move, captured: null, san: castleSan(move.castlingSide) });
    next.halfmove += 1;
    if (piece.color === "b") next.fullmove += 1;
    next.turn = piece.color === "w" ? "b" : "w";
    return next;
  }

  // ── En passant: capture the pawn behind the destination ──
  if (isEnPassant) {
    const captureRank = piece.color === "w" ? targetFR[1] - 1 : targetFR[1] + 1;
    const captureSq = frToSquare([targetFR[0], captureRank]);
    captured = next.pieceAt(captureSq);
    next.setSquare(captureSq, null);
  }

  // ── Standard capture detection (non-en-passant) ──
  if (!isEnPassant && next.pieceAt(move.to)) {
    // Shield check (Ship #2 absorb_captures marks). If the target
    // has a shield mark with remaining absorbs, eat one absorb and
    // treat the move as a non-capture: the attacker stops at its
    // origin (the move "bounces"). This is the simplest physically-
    // sensible interpretation of "shield blocked the attack."
    if (tryAbsorbCapture(next, move.to)) {
      // Cancel the move entirely: the piece does not move, the
      // shield absorbed one charge, and the side-to-move still
      // flips (the caster used their turn). History records a
      // bounce.
      next.history.push({ ...move, bounced: true, san: `${move.from}>${move.to}!shield` });
      next.halfmove = next.halfmove + 1;
      if (piece.color === "b") next.fullmove += 1;
      next.enPassant = null;
      tickCooldowns(next);
      tickMarks(next);
      next.turn = piece.color === "w" ? "b" : "w";
      return next;
    }
    captured = next.pieceAt(move.to);
  }

  // ── Move the piece ──
  next.setSquare(move.from, null);
  // Promotion replaces the moved piece with the chosen type.
  const placed = isPromotion
    ? { type: move.promotion, color: piece.color }
    : piece;
  next.setSquare(move.to, placed);

  // ── Capture effects ──
  if (captured) {
    applyCaptureEffects(next, move.to, captured, rules);
    next.captureTally[piece.color] += 1;
    // Marks with `expireOnCapture` drop now that this piece just
    // made a capture.
    dropExpireOnCaptureMarks(next, move.to);
  }
  // Migrate any marks attached to the from-square to the to-square
  // so status effects follow the piece (frozen knight that's
  // forced to move via haste should still BE frozen on its new
  // square, etc.).
  migrateSquareEffects(next, move.from, move.to);

  // ── En passant target for the NEXT move ──
  // Standard rules: a 2-square pawn move sets the en-passant
  // target on the square jumped over. Match chess.js's smart
  // behavior: ONLY set the target when an enemy pawn is in
  // position to actually capture (adjacent file, same rank as
  // the pushed pawn). Otherwise dumping the EP square pollutes
  // FEN comparisons + threefold-repetition checks.
  next.enPassant = null;
  if (piece.type === "p" && Math.abs(targetFR[1] - moverFR[1]) === 2) {
    const epRank = (moverFR[1] + targetFR[1]) / 2;
    const enemyColor = piece.color === "w" ? "b" : "w";
    const adjacentFiles = [targetFR[0] - 1, targetFR[0] + 1];
    let canBeCaptured = false;
    for (const af of adjacentFiles) {
      if (af < 0 || af > 7) continue;
      const adjPc = next.board[af + targetFR[1] * 8];
      if (adjPc && adjPc.type === "p" && adjPc.color === enemyColor) {
        canBeCaptured = true;
        break;
      }
    }
    if (canBeCaptured) {
      next.enPassant = frToSquare([targetFR[0], epRank]);
    }
  }

  // ── Castling rights bookkeeping ──
  // King move revokes both sides for that color. Rook move
  // from a corner revokes that side. Capturing an enemy rook
  // on its starting square revokes the enemy's matching side.
  if (piece.type === "k") {
    next.castling[piece.color] = { kingside: false, queenside: false };
  } else if (piece.type === "r") {
    revokeCastlingFromRookSquare(next, piece.color, move.from);
  }
  if (captured && captured.type === "r") {
    revokeCastlingFromRookSquare(next, captured.color, move.to);
  }

  // ── 50-move clock + full-move counter ──
  next.halfmove = (captured || piece.type === "p") ? 0 : next.halfmove + 1;
  if (piece.color === "b") next.fullmove += 1;

  // ── History entry ──
  // SAN is computed by chess.js when possible (vanilla rules).
  // For variant-only moves we fall back to long algebraic so
  // the move list stays readable.
  const san = computeSan(position, move, piece, captured, isPromotion, isEnPassant);
  next.history.push({ ...move, captured, san });

  // ── Cooldowns tick at end of every move (Ship #1+). ──
  // Charges don't auto-refill; only ability casts decrement
  // them. Cooldowns are inclusive: a cooldown of 4 means the
  // piece can cast again on its 4th turn after the cast.
  tickCooldowns(next);
  // Status marks tick at end of every move too (Ship #2). Marks
  // with destroyOnExpire run their handler when the timer hits
  // zero (burn semantics).
  tickMarks(next);

  // ── Side to move ──
  next.turn = piece.color === "w" ? "b" : "w";

  return next;
}

/**
 * Move all crazyState marks from one square to another. Used by
 * regular moves so that status effects follow the piece. Ability
 * casts already handle this themselves via the resolver.
 */
function migrateSquareEffects(next, fromSq, toSq) {
  if (fromSq === toSq) return;
  const cs = next.crazyState;
  if (!cs?.effects) return;
  if (cs.effects[fromSq]) {
    cs.effects[toSq] = (cs.effects[toSq] || []).concat(cs.effects[fromSq]);
    delete cs.effects[fromSq];
  }
}

// ── Active abilities (AI Arena Ship #1+) ───────────────────

/**
 * Resolve a `kind: "ability"` move: do not move the caster,
 * apply the ability's effect to the target square via the
 * Ship #2 composable primitive resolver, then decrement
 * charges / start cooldown for that ability. Side-to-move
 * flips after, just like a regular move.
 *
 * Strict failure mode (Ship #2): if the effect resolver
 * returns an error, this function returns null. The caller
 * (`applyMoveRaw` / `applyMove`) treats that as an
 * unresolvable move; `applyMove` throws, which the lobby
 * surfaces as "variant error - match cancelled."
 */
function applyAbilityMove(next, prevPosition, move, rules, piece, moverFR, targetFR) {
  const ability = findAbility(rules, piece, move.abilityId);
  if (!ability) return null;

  const effect = ability.effect || {};
  const ctx = {
    caster: piece,
    casterSquare: move.from,
    casterFR: moverFR,
    targetSquare: move.to,
    targetFR,
    abilityId: ability.id,
    rules,
  };
  const result = resolveEffect(next, ctx, effect);
  if (!result.ok) {
    // Strict mode: surface a recognizable error so apply-move's
    // caller can show "variant error" toast and abort the round.
    // We attach it to the SOURCE position (prevPosition) because
    // the clone is being thrown away.
    prevPosition.lastEffectError = result.error;
    return null;
  }

  // ── Gating bookkeeping ──
  // Only mutate crazyState if it exists; pre-Ship-#2 callers
  // who never plumbed crazyState through skip this and just
  // get unlimited-uses-no-cooldown semantics. Note: the
  // resolver may have moved the caster (relocate_self), so
  // gating attaches to ctx.casterSquare, not move.from.
  if (next.crazyState && ability.gating) {
    if (!next.crazyState.charges) next.crazyState.charges = {};
    if (!next.crazyState.cooldowns) next.crazyState.cooldowns = {};

    if (Number.isFinite(ability.gating.charges)) {
      const sqMap = next.crazyState.charges[ctx.casterSquare] || {};
      const remaining = Number.isFinite(sqMap[ability.id])
        ? sqMap[ability.id] - 1
        : ability.gating.charges - 1;
      sqMap[ability.id] = Math.max(0, remaining);
      next.crazyState.charges[ctx.casterSquare] = sqMap;
    }
    if (Number.isFinite(ability.gating.cooldownPlies) && ability.gating.cooldownPlies > 0) {
      const sqMap = next.crazyState.cooldowns[ctx.casterSquare] || {};
      // Plus 1 because tickCooldowns runs once at the end of
      // this same move; without the +1 we'd silently skip a
      // ply.
      sqMap[ability.id] = ability.gating.cooldownPlies + 1;
      next.crazyState.cooldowns[ctx.casterSquare] = sqMap;
    }
  }

  // ── Halfmove + fullmove + history bookkeeping ──
  next.halfmove = result.captures > 0 ? 0 : next.halfmove + 1;
  if (piece.color === "b") next.fullmove += 1;
  next.enPassant = null;

  const san = abilityCastSan(move, result.captures);
  next.history.push({ ...move, captures: result.captures, san });
  tickCooldowns(next);
  tickMarks(next);
  next.turn = piece.color === "w" ? "b" : "w";
  return next;
}

/** Look up an ability descriptor on a piece's spec by id. */
function findAbility(rules, piece, abilityId) {
  const spec = pieceSpecFor(rules, piece);
  if (!spec || !Array.isArray(spec.abilities)) return null;
  return spec.abilities.find((a) => a?.id === abilityId) || null;
}

/**
 * Decrement every cooldown by 1 ply, dropping zero entries to
 * keep the sidecar tidy. Runs at the end of every move
 * (regular OR ability) so cooldowns measured in plies
 * progress consistently.
 */
function tickCooldowns(next) {
  const cs = next.crazyState;
  if (!cs?.cooldowns) return;
  for (const [sq, abilityMap] of Object.entries(cs.cooldowns)) {
    if (!abilityMap || typeof abilityMap !== "object") continue;
    for (const [abilityId, plies] of Object.entries(abilityMap)) {
      if (!Number.isFinite(plies)) continue;
      const remaining = plies - 1;
      if (remaining <= 0) {
        delete abilityMap[abilityId];
      } else {
        abilityMap[abilityId] = remaining;
      }
    }
    if (Object.keys(abilityMap).length === 0) {
      delete cs.cooldowns[sq];
    }
  }
}

/** Best-effort SAN-ish string for ability casts. */
function abilityCastSan(move, captures) {
  const verb = captures > 0 ? `x${captures > 1 ? captures : ""}` : "→";
  return `${move.casterType?.toUpperCase() || "?"}!${move.abilityId}${verb}${move.to}`;
}

// ── Capture effects ────────────────────────────────────────

function applyCaptureEffects(next, atSquare, captured, rules) {
  const effects = rules?.capture || {};
  // Convert: captured piece changes to capturer's color rather
  // than being removed. We do this by simply not removing it
  // (the standard remove already happened by overwriting the
  // square with the moving piece) - so for `convert` we restore
  // the captured square with a piece of OUR color and the type
  // of the captured piece. This intentionally creates an extra
  // piece for the capturer, which matches the loose "convert"
  // semantics used by anti-chess-style variants.
  if (effects.convert) {
    const moverColor = next.turn; // After clone, before turn swap below.
    // Wait - turn hasn't swapped yet. The capturer is the
    // CURRENT side (next.turn).
    const target = next.pieceAt(atSquare);
    if (target) {
      next.setSquare(atSquare, { type: captured.type, color: moverColor });
      // And also re-place the moving piece elsewhere? No - the
      // moving piece already moved AND captured, so the
      // squares involved are: from (now empty) and to (now the
      // mover). Convert means "the captured piece joins your
      // side" - we materialize it on its OLD square. Need to
      // pull oldSquare from history; for now we approximate by
      // putting the converted piece back where it was captured
      // (which is `atSquare` for the standard-capture path,
      // not en-passant-square). This is a simplification: for
      // en passant + convert at the same time, we'd lose the
      // captured square. The MVP doesn't expose convert + EP
      // simultaneously.
    }
    // Fall through to explosion handling for symmetry.
  }

  // Explosion: remove every non-pawn piece in the surrounding
  // squares (atomic-style), plus the capturing piece itself.
  // Pawns survive explosions to keep the variant playable.
  if (effects.explosionRadius && effects.explosionRadius > 0) {
    const radius = effects.explosionRadius | 0;
    const [f0, r0] = squareToFR(atSquare);
    // The capturing piece (currently at atSquare) explodes.
    next.setSquare(atSquare, null);
    for (let df = -radius; df <= radius; df++) {
      for (let dr = -radius; dr <= radius; dr++) {
        if (df === 0 && dr === 0) continue;
        const nf = f0 + df;
        const nr = r0 + dr;
        if (!inBounds([nf, nr])) continue;
        const sq = frToSquare([nf, nr]);
        const pc = next.pieceAt(sq);
        if (!pc) continue;
        if (pc.type === "p") continue; // Pawns survive.
        next.setSquare(sq, null);
      }
    }
  }
}

// ── Castling rights bookkeeping ────────────────────────────

function revokeCastlingFromRookSquare(next, color, sq) {
  const fr = squareToFR(sq);
  if (!fr) return;
  const expectedRank = color === "w" ? 0 : 7;
  if (fr[1] !== expectedRank) return;
  if (fr[0] === 0) next.castling[color].queenside = false;
  if (fr[0] === 7) next.castling[color].kingside = false;
}

// ── SAN ────────────────────────────────────────────────────

function castleSan(side) {
  return side === "queenside" ? "O-O-O" : "O-O";
}

/**
 * Best-effort SAN. Tries chess.js (which only succeeds for
 * vanilla-rules positions); falls back to long algebraic
 * including a check / capture marker.
 */
function computeSan(prevPosition, move, piece, captured, isPromotion, isEnPassant) {
  // Try chess.js for vanilla. chess.js refuses positions whose
  // FEN doesn't match its rule set (extra pieces, missing
  // kings, etc.), in which case we fall through to manual SAN.
  try {
    const ch = new Chess();
    if (!ch.load(prevPosition.toFen())) {
      throw new Error("chess.js refused FEN");
    }
    const moveObj = { from: move.from, to: move.to };
    if (move.promotion) moveObj.promotion = move.promotion;
    const result = ch.move(moveObj);
    if (result?.san) return result.san;
  } catch {
    // Fall through to manual SAN.
  }
  // Manual SAN: Type letter + (capture x) + dest + (=Promo).
  const typeLetter = piece.type === "p" ? "" : piece.type.toUpperCase();
  const captureMarker = captured || isEnPassant ? "x" : "";
  const promo = isPromotion ? `=${move.promotion.toUpperCase()}` : "";
  // Pawn captures need the file of origin in front.
  const filePrefix = piece.type === "p" && captureMarker ? move.from[0] : "";
  return `${typeLetter}${filePrefix}${captureMarker}${move.to}${promo}`;
}

// ── Move equality ──────────────────────────────────────────

/**
 * Compare two moves for "the engine should treat these as the
 * same action." Beyond from/to/promotion we also distinguish:
 *
 *   - ability casts vs regular moves (kind="ability" vs absent)
 *   - which ability is being cast (abilityId)
 *
 * Without the kind+abilityId check, a regular slide from d3 to
 * d5 would shadow an ability cast targeting d5, since both
 * have the same from/to. The UI MUST send the move object
 * generated by `generateLegalMoves` (with `kind` set) for
 * ability casts to dispatch correctly.
 */
function sameMove(a, b) {
  if (a.from !== b.from) return false;
  if (a.to !== b.to) return false;
  if ((a.promotion || null) !== (b.promotion || null)) return false;
  if ((a.kind || null) !== (b.kind || null)) return false;
  if ((a.abilityId || null) !== (b.abilityId || null)) return false;
  return true;
}
