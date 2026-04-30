/**
 * Composable effect primitives for AI Arena (Ship #2).
 *
 * Replaces the original fixed-enum approach (`{ kind: "freeze" }`,
 * `{ kind: "burn" }`, etc.) with seven orthogonal primitives the AI
 * combines to express any physical mechanic:
 *
 *   destroy        — remove the target piece
 *   displace       — move target to a new square (push, pull, throw, bowl)
 *   relocate_self  — move the caster as part of the cast (teleport, blink)
 *   spawn          — create a piece on an empty square (summon, raise)
 *   transform      — change a piece's type or color (charm, polymorph)
 *   mark           — apply a tagged status the engine ticks (freeze, burn,
 *                    shield, stun, root, silence, haste, anything)
 *   aoe_wrap       — apply any of the above to neighbors of the target
 *
 * The `mark` primitive is the catch-all for status effects. AI emits a
 * `tag` string (any name) plus behavioral fields the engine acts on:
 *
 *   skipTurns          — frozen-style: piece emits zero moves
 *   silenceAbilities   — silenced: can move but not cast
 *   absorbCaptures: N  — shield: absorbs N captures, then expires
 *   extraMoves: N      — haste: owner gets N extra moves on this piece
 *   destroyOnExpire    — burn: piece dies when timer hits 0
 *   expireOnCapture    — drops on capturing
 *   duration: plies    — ticks down at end of every move
 *
 * Strict failure mode: every primitive resolver returns either a successful
 * mutation result or an `Error`-shaped object. Apply-move surfaces failures
 * to the caller, which aborts the match with a "variant error" toast. No
 * silent best-effort; if a fireball somehow targets an off-board square,
 * the match ends.
 *
 * Backward compatibility: the legacy `{ kind: "capture" }` from Ship #1
 * resolves to `{ kind: "destroy" }` here. No client-side migration needed
 * for existing variants.
 */

import {
  squareToFR,
  frToSquare,
  inBounds,
} from "./position";

// ── Public entry point ──────────────────────────────────────

/**
 * Resolve a single ability effect on a Position clone.
 *
 * @param {import("./position").Position} next   The position to mutate (already cloned by apply-move).
 * @param {Object} ctx                            Resolution context: { caster, casterSquare, casterFR, targetSquare, targetFR, abilityId, rules }.
 * @param {Object} effect                         The effect descriptor from the ability spec.
 * @returns {{ ok: true, captures: number } | { ok: false, error: string }}
 */
export function resolveEffect(next, ctx, effect) {
  if (!effect || typeof effect !== "object") {
    return { ok: false, error: "effect descriptor missing" };
  }
  const kind = effect.kind;

  // Backward-compat: Ship #1 emitted { kind: "capture" }. Treat
  // it as destroy with the same AOE shape.
  if (kind === "capture") {
    return resolveDestroy(next, ctx, effect);
  }
  if (kind === "destroy") {
    return resolveDestroy(next, ctx, effect);
  }
  if (kind === "displace") {
    return resolveDisplace(next, ctx, effect);
  }
  if (kind === "relocate_self") {
    return resolveRelocateSelf(next, ctx, effect);
  }
  if (kind === "spawn") {
    return resolveSpawn(next, ctx, effect);
  }
  if (kind === "transform") {
    return resolveTransform(next, ctx, effect);
  }
  if (kind === "mark") {
    return resolveMark(next, ctx, effect);
  }
  if (kind === "aoe_wrap") {
    return resolveAOEWrap(next, ctx, effect);
  }
  return { ok: false, error: `unknown effect.kind: ${kind}` };
}

// ── destroy ─────────────────────────────────────────────────

function resolveDestroy(next, ctx, effect) {
  const target = next.pieceAt(ctx.targetSquare);
  let captures = 0;
  if (target) {
    next.setSquare(ctx.targetSquare, null);
    next.captureTally[ctx.caster.color] += 1;
    captures += 1;
  }
  // Optional AOE on legacy {kind:"capture", aoe:{...}}.
  if (effect.aoe && Number.isFinite(effect.aoe.radius) && effect.aoe.radius > 0) {
    const aoeResult = applyAOE(next, ctx, effect.aoe, () => null);
    captures += aoeResult.captures;
  }
  return { ok: true, captures };
}

// ── displace ────────────────────────────────────────────────

/**
 * Move the target piece to a new square. Supports three styles:
 *
 *   1. Fixed delta:    `{ delta: [df, dr] }`
 *   2. Computed dir:   `{ direction: "from_caster" | "toward_caster" |
 *                         "toward_target_from_origin", distance: 1..7 }`
 *   3. Bowling line:   delta or direction with `onCollision: "destroy_*"`
 *      so the displaced piece travels until it hits something.
 *
 * On-collision modes:
 *   "stop"             — target stops one square before the collider (default)
 *   "destroy_target"   — target is removed when it collides
 *   "destroy_collider" — collider removed, target lands on collider's square
 *   "destroy_both"     — both removed
 *
 * `bounceOffEdge: false` (default) destroys the target if it's pushed off
 * the board. `true` makes it stop at the edge instead.
 */
function resolveDisplace(next, ctx, effect) {
  const target = next.pieceAt(ctx.targetSquare);
  if (!target) {
    return { ok: false, error: `displace: no piece at target ${ctx.targetSquare}` };
  }
  const targetFR = ctx.targetFR;

  // Compute the unit direction + max distance.
  let stepF = 0;
  let stepR = 0;
  let distance = 0;

  if (Array.isArray(effect.delta) && effect.delta.length === 2 &&
      Number.isFinite(effect.delta[0]) && Number.isFinite(effect.delta[1])) {
    // Fixed delta. Distance is the chebyshev magnitude; step is the unit
    // vector.
    const flip = ctx.caster.color === "b" ? -1 : 1;
    const df = effect.delta[0];
    const dr = effect.delta[1] * flip;
    stepF = Math.sign(df);
    stepR = Math.sign(dr);
    distance = Math.max(Math.abs(df), Math.abs(dr));
    if (distance === 0) {
      return { ok: false, error: "displace.delta is [0,0]" };
    }
  } else if (typeof effect.direction === "string") {
    const dist = Number(effect.distance);
    if (!Number.isFinite(dist) || dist < 1 || dist > 7) {
      return { ok: false, error: `displace.distance must be 1..7 (got ${effect.distance})` };
    }
    distance = dist;
    if (effect.direction === "from_caster") {
      stepF = Math.sign(targetFR[0] - ctx.casterFR[0]);
      stepR = Math.sign(targetFR[1] - ctx.casterFR[1]);
    } else if (effect.direction === "toward_caster") {
      stepF = Math.sign(ctx.casterFR[0] - targetFR[0]);
      stepR = Math.sign(ctx.casterFR[1] - targetFR[1]);
    } else if (effect.direction === "toward_target_from_origin") {
      // Less common: push the target along its OWN forward direction.
      // Useful for "the wind blows enemies in the direction they
      // were facing." Forward = +1 rank for white, -1 for black.
      stepF = 0;
      stepR = target.color === "w" ? 1 : -1;
    } else {
      return { ok: false, error: `displace.direction "${effect.direction}" is unknown` };
    }
    if (stepF === 0 && stepR === 0) {
      return { ok: false, error: "displace direction is zero (caster on target?)" };
    }
  } else {
    return { ok: false, error: "displace requires either `delta` or `direction`+`distance`" };
  }

  const onCollision = typeof effect.onCollision === "string" ? effect.onCollision : "stop";
  const bounceOffEdge = effect.bounceOffEdge === true;

  // Walk the line square-by-square. Collision detection runs at each step;
  // "stop" lands on the last empty square, "destroy_*" handles collisions
  // explicitly.
  let currentFR = [targetFR[0], targetFR[1]];
  let landingFR = currentFR;
  let captures = 0;
  let targetDestroyed = false;

  for (let i = 0; i < distance; i++) {
    const nextFR = [currentFR[0] + stepF, currentFR[1] + stepR];
    if (!inBounds(nextFR)) {
      // Pushed off the edge.
      if (bounceOffEdge) {
        landingFR = currentFR; // stay at last in-bounds square
      } else {
        // Destroy the target.
        targetDestroyed = true;
        captures += 1;
        next.captureTally[ctx.caster.color] += 1;
      }
      break;
    }
    const occupant = next.board[nextFR[0] + nextFR[1] * 8];
    if (!occupant) {
      currentFR = nextFR;
      landingFR = nextFR;
      continue;
    }
    // Collision.
    if (onCollision === "stop") {
      landingFR = currentFR;
      break;
    }
    if (onCollision === "destroy_target") {
      targetDestroyed = true;
      captures += 1;
      next.captureTally[ctx.caster.color] += 1;
      break;
    }
    if (onCollision === "destroy_collider") {
      next.setSquare(frToSquare(nextFR), null);
      captures += 1;
      next.captureTally[ctx.caster.color] += 1;
      currentFR = nextFR;
      landingFR = nextFR;
      continue; // bowling-style: continue down the line through the new gap
    }
    if (onCollision === "destroy_both") {
      next.setSquare(frToSquare(nextFR), null);
      captures += 1;
      next.captureTally[ctx.caster.color] += 1;
      targetDestroyed = true;
      captures += 1;
      next.captureTally[ctx.caster.color] += 1;
      break;
    }
    // Unknown mode → safe fallback to stop.
    landingFR = currentFR;
    break;
  }

  // Apply the displacement. Original square always clears; target lands on
  // landingFR unless destroyed.
  next.setSquare(ctx.targetSquare, null);
  if (!targetDestroyed) {
    next.setSquare(frToSquare(landingFR), target);
    // If the target had crazy-state marks tied to its old square,
    // migrate them to the new square so they stay attached to the
    // piece.
    migrateSquareState(next, ctx.targetSquare, frToSquare(landingFR));
  } else {
    // Destroyed in flight - drop any state that was tied to the
    // origin square.
    clearSquareState(next, ctx.targetSquare);
  }
  return { ok: true, captures };
}

// ── relocate_self ───────────────────────────────────────────

function resolveRelocateSelf(next, ctx, effect) {
  const dest = effect.destination || "target";
  let destFR = null;
  if (dest === "target") {
    destFR = ctx.targetFR;
  } else if (dest === "caster_origin") {
    destFR = ctx.casterFR;
  } else if (dest === "adjacent_to_target") {
    // First in-bounds empty square adjacent to the target. Deterministic
    // ordering so multiplayer stays in sync.
    const offsets = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    for (const [df, dr] of offsets) {
      const fr = [ctx.targetFR[0] + df, ctx.targetFR[1] + dr];
      if (!inBounds(fr)) continue;
      const occ = next.board[fr[0] + fr[1] * 8];
      if (!occ) {
        destFR = fr;
        break;
      }
    }
    if (!destFR) {
      return { ok: false, error: "relocate_self: no empty square adjacent to target" };
    }
  } else {
    return { ok: false, error: `relocate_self.destination "${dest}" is unknown` };
  }

  if (!inBounds(destFR)) {
    return { ok: false, error: `relocate_self destination off-board: ${destFR}` };
  }
  const destSquare = frToSquare(destFR);

  // If the destination is occupied AND it's not the caster's own square,
  // we have a conflict. For now: if it's an enemy, capture them; if it's
  // a friendly, abort.
  const occupant = next.pieceAt(destSquare);
  let captures = 0;
  if (occupant && destSquare !== ctx.casterSquare) {
    if (occupant.color === ctx.caster.color) {
      return { ok: false, error: `relocate_self: destination ${destSquare} is occupied by friendly` };
    }
    next.setSquare(destSquare, null);
    captures += 1;
    next.captureTally[ctx.caster.color] += 1;
  }

  // Move the caster.
  if (destSquare !== ctx.casterSquare) {
    next.setSquare(ctx.casterSquare, null);
    next.setSquare(destSquare, ctx.caster);
    migrateSquareState(next, ctx.casterSquare, destSquare);
    // Update ctx so any subsequent primitives in the same effect chain
    // see the new caster square (used by aoe_wrap composition).
    ctx.casterSquare = destSquare;
    ctx.casterFR = destFR;
  }
  return { ok: true, captures };
}

// ── spawn ───────────────────────────────────────────────────

function resolveSpawn(next, ctx, effect) {
  if (next.pieceAt(ctx.targetSquare)) {
    return { ok: false, error: `spawn: target ${ctx.targetSquare} is not empty` };
  }
  const pieceType = typeof effect.pieceType === "string" ? effect.pieceType : null;
  if (!pieceType || !["p", "n", "b", "r", "q"].includes(pieceType)) {
    // Kings can't be spawned - too many edge cases with checkmate. AI
    // gets told this in the prompt.
    return { ok: false, error: `spawn.pieceType "${pieceType}" must be p/n/b/r/q` };
  }
  const colorChoice = effect.color || "caster";
  let color;
  if (colorChoice === "caster") color = ctx.caster.color;
  else if (colorChoice === "enemy") color = ctx.caster.color === "w" ? "b" : "w";
  else return { ok: false, error: `spawn.color "${colorChoice}" must be caster/enemy` };

  next.setSquare(ctx.targetSquare, { type: pieceType, color });

  // Optional lifespan: attach a `mark` with destroyOnExpire so the engine
  // cleans up after `lifespan` plies. This piggybacks on the mark
  // bookkeeping we already need for status effects, no new mechanism.
  if (Number.isFinite(effect.lifespan) && effect.lifespan > 0) {
    addMark(next, ctx.targetSquare, {
      tag: "summon_lifespan",
      duration: effect.lifespan,
      destroyOnExpire: true,
    });
  }
  return { ok: true, captures: 0 };
}

// ── transform ───────────────────────────────────────────────

function resolveTransform(next, ctx, effect) {
  const target = next.pieceAt(ctx.targetSquare);
  if (!target) {
    return { ok: false, error: `transform: no piece at target ${ctx.targetSquare}` };
  }

  const original = { type: target.type, color: target.color };

  // Determine new type + color.
  const newPiece = { ...target };
  if (typeof effect.pieceType === "string") {
    if (!["p", "n", "b", "r", "q", "k"].includes(effect.pieceType)) {
      return { ok: false, error: `transform.pieceType "${effect.pieceType}" invalid` };
    }
    newPiece.type = effect.pieceType;
  }
  if (typeof effect.color === "string") {
    if (effect.color === "flip") {
      newPiece.color = target.color === "w" ? "b" : "w";
    } else if (effect.color === "caster") {
      newPiece.color = ctx.caster.color;
    } else if (effect.color === "enemy") {
      newPiece.color = ctx.caster.color === "w" ? "b" : "w";
    } else {
      return { ok: false, error: `transform.color "${effect.color}" must be flip/caster/enemy` };
    }
  }

  if (newPiece.type === target.type && newPiece.color === target.color) {
    // No-op transform; treat as success but record nothing.
    return { ok: true, captures: 0 };
  }

  next.setSquare(ctx.targetSquare, newPiece);

  // If duration is set, attach a revert mark. revertOnCapture also wires
  // through the mark system.
  if (Number.isFinite(effect.duration) && effect.duration > 0) {
    addMark(next, ctx.targetSquare, {
      tag: "transform_revert",
      duration: effect.duration,
      revertTo: original,
      expireOnCapture: effect.revertOnCapture === true,
    });
  } else if (effect.revertOnCapture === true) {
    addMark(next, ctx.targetSquare, {
      tag: "transform_revert",
      revertTo: original,
      expireOnCapture: true,
    });
  }
  return { ok: true, captures: 0 };
}

// ── mark ────────────────────────────────────────────────────

function resolveMark(next, ctx, effect) {
  const target = next.pieceAt(ctx.targetSquare);
  if (!target) {
    return { ok: false, error: `mark: no piece at target ${ctx.targetSquare}` };
  }

  const tag = typeof effect.tag === "string" ? effect.tag : null;
  if (!tag || !/^[a-z][a-z0-9_]{0,31}$/.test(tag)) {
    return { ok: false, error: `mark.tag "${tag}" must be lowercase alphanumeric+underscore, 1..32 chars` };
  }

  const mark = { tag };
  if (Number.isFinite(effect.duration)) {
    if (effect.duration < 1 || effect.duration > 30) {
      return { ok: false, error: `mark.duration must be 1..30 (got ${effect.duration})` };
    }
    mark.duration = effect.duration;
  }
  if (effect.skipTurns === true) mark.skipTurns = true;
  if (effect.silenceAbilities === true) mark.silenceAbilities = true;
  if (Number.isFinite(effect.absorbCaptures)) {
    if (effect.absorbCaptures < 1 || effect.absorbCaptures > 9) {
      return { ok: false, error: `mark.absorbCaptures must be 1..9 (got ${effect.absorbCaptures})` };
    }
    mark.absorbCaptures = effect.absorbCaptures;
  }
  if (Number.isFinite(effect.extraMoves)) {
    if (effect.extraMoves < 1 || effect.extraMoves > 2) {
      return { ok: false, error: `mark.extraMoves must be 1..2 (got ${effect.extraMoves})` };
    }
    mark.extraMoves = effect.extraMoves;
  }
  if (effect.destroyOnExpire === true) mark.destroyOnExpire = true;
  if (effect.expireOnCapture === true) mark.expireOnCapture = true;

  // No behavioral fields = bare cosmetic mark. That's fine; visuals in
  // ship #3 will still pick it up via the tag.
  addMark(next, ctx.targetSquare, mark);
  return { ok: true, captures: 0 };
}

// ── aoe_wrap ────────────────────────────────────────────────

function resolveAOEWrap(next, ctx, effect) {
  const radius = Number(effect.radius);
  if (!Number.isFinite(radius) || radius < 1 || radius > 3) {
    return { ok: false, error: `aoe_wrap.radius must be 1..3 (got ${effect.radius})` };
  }
  if (!effect.inner || typeof effect.inner !== "object") {
    return { ok: false, error: "aoe_wrap.inner is required and must be an effect object" };
  }
  if (effect.inner.kind === "aoe_wrap") {
    // Disallow nested AOE - quadratic blow-up + makes the validator's job
    // way harder. Caller should compose another way.
    return { ok: false, error: "aoe_wrap cannot wrap aoe_wrap (no nested AOE)" };
  }

  const hitsPawns = effect.hitsPawns === true;
  const hitsFriendly = effect.hitsFriendly === true;

  let totalCaptures = 0;

  // Iterate every square in the radius around the target.
  for (let df = -radius; df <= radius; df++) {
    for (let dr = -radius; dr <= radius; dr++) {
      const nf = ctx.targetFR[0] + df;
      const nr = ctx.targetFR[1] + dr;
      if (!inBounds([nf, nr])) continue;
      const sq = frToSquare([nf, nr]);
      // Caster's square is always immune to its own AOE.
      if (sq === ctx.casterSquare) continue;

      const pc = next.pieceAt(sq);
      // Filtering rules apply to primitives that act ON existing pieces
      // (destroy/displace/transform/mark). For spawn on an empty square,
      // we allow the AOE to fire there even without an occupant. The
      // inner resolver itself rejects mismatches.
      if (pc) {
        if (!hitsFriendly && pc.color === ctx.caster.color) continue;
        if (!hitsPawns && pc.type === "p") continue;
      } else {
        // Empty square - only spawn benefits from this; everything else
        // is a no-op.
        if (effect.inner.kind !== "spawn") continue;
      }

      const subCtx = {
        ...ctx,
        targetSquare: sq,
        targetFR: [nf, nr],
      };
      const result = resolveEffect(next, subCtx, effect.inner);
      if (!result.ok) {
        // Strict mode: any inner failure aborts the cast.
        return { ok: false, error: `aoe_wrap inner failure at ${sq}: ${result.error}` };
      }
      totalCaptures += result.captures;
    }
  }
  return { ok: true, captures: totalCaptures };
}

// ── Mark bookkeeping helpers ───────────────────────────────

/**
 * Attach a mark to a square. Multiple marks can stack on the same square;
 * we just append to the array. Tickdown / capture absorption / expiry all
 * iterate the array.
 */
export function addMark(next, square, mark) {
  if (!next.crazyState) next.crazyState = {};
  if (!next.crazyState.effects) next.crazyState.effects = {};
  const existing = next.crazyState.effects[square] || [];
  existing.push({ ...mark });
  next.crazyState.effects[square] = existing;
}

/**
 * Tick down every active mark on the board by 1 ply. Marks with no
 * duration are permanent and skipped.  Marks expiring trigger their
 * end-of-life handlers (destroyOnExpire, revertTo).
 *
 * Called at the end of every move (regular OR ability) by apply-move.
 */
export function tickMarks(next) {
  const cs = next.crazyState;
  if (!cs?.effects) return;
  for (const [sq, marks] of Object.entries(cs.effects)) {
    if (!Array.isArray(marks) || marks.length === 0) continue;
    const surviving = [];
    for (const m of marks) {
      if (!Number.isFinite(m.duration)) {
        // Permanent mark; carry forward.
        surviving.push(m);
        continue;
      }
      const remaining = m.duration - 1;
      if (remaining > 0) {
        surviving.push({ ...m, duration: remaining });
        continue;
      }
      // Expired. Run end-of-life handlers.
      if (m.destroyOnExpire) {
        next.setSquare(sq, null);
      }
      if (m.revertTo && next.pieceAt(sq)) {
        next.setSquare(sq, { type: m.revertTo.type, color: m.revertTo.color });
      }
    }
    if (surviving.length === 0) {
      delete cs.effects[sq];
    } else {
      cs.effects[sq] = surviving;
    }
  }
  if (Object.keys(cs.effects).length === 0) {
    delete cs.effects;
  }
}

/**
 * Hook called when a piece is about to be captured. If the piece has an
 * `absorbCaptures` mark with remaining absorbs, decrement the counter
 * (and remove the mark when it hits 0) and return true to indicate the
 * capture was absorbed. Otherwise return false and the caller proceeds
 * with normal capture removal.
 */
export function tryAbsorbCapture(next, square) {
  const marks = next.crazyState?.effects?.[square];
  if (!Array.isArray(marks) || marks.length === 0) return false;
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    if (!Number.isFinite(m.absorbCaptures) || m.absorbCaptures <= 0) continue;
    const remaining = m.absorbCaptures - 1;
    if (remaining > 0) {
      marks[i] = { ...m, absorbCaptures: remaining };
    } else {
      marks.splice(i, 1);
    }
    if (marks.length === 0) {
      delete next.crazyState.effects[square];
    }
    return true;
  }
  return false;
}

/**
 * Drop any expireOnCapture marks attached to a piece that just made a
 * capture. Called by apply-move after the capture is committed.
 */
export function dropExpireOnCaptureMarks(next, square) {
  const marks = next.crazyState?.effects?.[square];
  if (!Array.isArray(marks) || marks.length === 0) return;
  const surviving = marks.filter((m) => !m.expireOnCapture);
  if (surviving.length === 0) {
    delete next.crazyState.effects[square];
  } else if (surviving.length !== marks.length) {
    next.crazyState.effects[square] = surviving;
  }
}

/**
 * Compute a piece's effective state - whether it can move, whether it
 * can cast, and how many extra moves it has this turn. Used by move-gen
 * to filter moves and apply-move to gate ability casts.
 */
export function pieceEffectiveState(position, square) {
  const marks = position.crazyState?.effects?.[square];
  const out = {
    canMove: true,
    canCast: true,
    extraMoves: 0,
    skipTurns: false,
  };
  if (!Array.isArray(marks)) return out;
  for (const m of marks) {
    if (m.skipTurns) {
      out.canMove = false;
      out.canCast = false;
      out.skipTurns = true;
    }
    if (m.silenceAbilities) {
      out.canCast = false;
    }
    if (Number.isFinite(m.extraMoves) && m.extraMoves > 0) {
      out.extraMoves = Math.max(out.extraMoves, m.extraMoves);
    }
  }
  return out;
}

/** Move all marks attached to fromSq onto toSq. Used when a piece is displaced. */
function migrateSquareState(next, fromSq, toSq) {
  if (fromSq === toSq) return;
  const cs = next.crazyState;
  if (!cs?.effects) return;
  if (cs.effects[fromSq]) {
    cs.effects[toSq] = (cs.effects[toSq] || []).concat(cs.effects[fromSq]);
    delete cs.effects[fromSq];
  }
  // Charges/cooldowns also migrate (the piece is the same; the square
  // just changed).
  if (cs.charges?.[fromSq]) {
    cs.charges[toSq] = { ...(cs.charges[toSq] || {}), ...cs.charges[fromSq] };
    delete cs.charges[fromSq];
  }
  if (cs.cooldowns?.[fromSq]) {
    cs.cooldowns[toSq] = { ...(cs.cooldowns[toSq] || {}), ...cs.cooldowns[fromSq] };
    delete cs.cooldowns[fromSq];
  }
}

/** Drop any state attached to a square (used when a piece is destroyed). */
function clearSquareState(next, square) {
  const cs = next.crazyState;
  if (!cs) return;
  if (cs.effects?.[square]) delete cs.effects[square];
  if (cs.charges?.[square]) delete cs.charges[square];
  if (cs.cooldowns?.[square]) delete cs.cooldowns[square];
}

// ── Internal: legacy AOE for { kind: "capture", aoe: ... } ──

function applyAOE(next, ctx, aoe, _innerHandler) {
  const radius = Number(aoe.radius) | 0;
  const hitsPawns = aoe.hitsPawns === true;
  const hitsFriendly = aoe.hitsFriendly === true;
  let captures = 0;
  for (let df = -radius; df <= radius; df++) {
    for (let dr = -radius; dr <= radius; dr++) {
      if (df === 0 && dr === 0) continue;
      const nf = ctx.targetFR[0] + df;
      const nr = ctx.targetFR[1] + dr;
      if (!inBounds([nf, nr])) continue;
      const sq = frToSquare([nf, nr]);
      if (sq === ctx.casterSquare) continue;
      const pc = next.pieceAt(sq);
      if (!pc) continue;
      if (!hitsFriendly && pc.color === ctx.caster.color) continue;
      if (!hitsPawns && pc.type === "p") continue;
      next.setSquare(sq, null);
      clearSquareState(next, sq);
      captures += 1;
      next.captureTally[ctx.caster.color] += 1;
    }
  }
  return { captures };
}
