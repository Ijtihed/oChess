/**
 * Compile AI-emitted raw draw source → ready-for-iframe Function
 * source string.
 *
 * Pipeline:
 *   1. validateDraw  - reject anything outside the API allowlist
 *      or matching the banlist.
 *   2. injectLoopGuard - rewrite the source to call __arenaGuard__
 *      at the top of every loop body.
 *   3. Return a complete `function __draw__(__arenaGuardCtx__,
 *      __arenaGuard__, ctx, x, y, ...) { ... }` source string.
 *
 * The output goes into the SCENE.drawSources field passed to the
 * iframe. The iframe compiles via `new Function("return (" +
 * source + ")")` to get back a callable.
 *
 * Per-slot-type parameter signatures:
 *
 *   slot draw       (ctx, x, y, facing, owner, t, random, state)
 *   projectile draw (ctx, p)                  // p has { x, y, fromX, ... }
 *   overlay draw    (ctx, scene)              // scene has { width, height, ... }
 *   brain (cosmetic)(self, world, dt)
 *
 * The validator's allowlist permits all these param names so the
 * AI can use any of them in any draw kind without confusion. The
 * actual runtime binds only the ones relevant to the slot kind.
 */

import { validateDraw } from "./ast-validator";
import { injectLoopGuard } from "./inject-loop-guard";

/**
 * Compile a single draw source.
 *
 * @param {string} rawSource              Body of the user's draw function.
 * @param {string[]} params               Parameter names the runtime will bind.
 * @returns {{ ok: boolean, source?: string, reason?: string, line?: number, col?: number }}
 *   On success: `source` is a complete function-decl string, ready
 *   to pass to `new Function("return (" + source + ")")`.
 *   On failure: `reason` describes why; `line`/`col` may pin the
 *   problem location in the original source.
 */
export function compileDraw(rawSource, params) {
  const v = validateDraw(rawSource, { params });
  if (!v.ok) {
    return { ok: false, reason: v.reason, line: v.line, col: v.col };
  }
  const inj = injectLoopGuard(rawSource, params);
  if (!inj.ok) {
    return { ok: false, reason: inj.reason };
  }
  return { ok: true, source: inj.source };
}

/**
 * Compile every draw in the rules' visual block.
 *
 * Input shape (the AI emits this as part of the rules diff):
 *
 *   {
 *     slots: { "q.aura": "<source>", "n.body": "<source>", ... },
 *     projectiles: { "fireball": "<source>", ... },
 *     overlays: ["<source>", ...],
 *     brains: { "q": "<source>", ... }
 *   }
 *
 * Output shape (passed to iframe via INIT.drawSources):
 *
 *   Same shape, but each value is the function-declaration
 *   string from injectLoopGuard.
 *
 * Compile failures for individual draws are NOT fatal: we drop
 * the bad draw and the iframe just renders without it. The list
 * of skipped draws is returned in `errors` for surfacing in the
 * debug panel.
 */
export function compileVisuals(visualBlock) {
  if (!visualBlock || typeof visualBlock !== "object") {
    return { ok: true, compiled: { slots: {}, projectiles: {}, overlays: [], brains: {} }, errors: [] };
  }
  const compiled = {
    slots: {},
    projectiles: {},
    overlays: [],
    brains: {},
  };
  const errors = [];

  // Slot draws — params: ctx, x, y, facing, owner, t, random, state
  if (visualBlock.slots && typeof visualBlock.slots === "object") {
    for (const [key, src] of Object.entries(visualBlock.slots)) {
      const r = compileDraw(src, ["ctx", "x", "y", "facing", "owner", "t", "random", "state"]);
      if (r.ok) {
        compiled.slots[key] = r.source;
      } else {
        errors.push({ kind: "slot", key, reason: r.reason, line: r.line, col: r.col });
      }
    }
  }

  // Projectile draws — params: ctx, p
  if (visualBlock.projectiles && typeof visualBlock.projectiles === "object") {
    for (const [key, src] of Object.entries(visualBlock.projectiles)) {
      const r = compileDraw(src, ["ctx", "p"]);
      if (r.ok) {
        compiled.projectiles[key] = r.source;
      } else {
        errors.push({ kind: "projectile", key, reason: r.reason, line: r.line, col: r.col });
      }
    }
  }

  // Overlay draws — params: ctx, scene
  if (Array.isArray(visualBlock.overlays)) {
    for (let i = 0; i < visualBlock.overlays.length; i++) {
      const r = compileDraw(visualBlock.overlays[i], ["ctx", "scene"]);
      if (r.ok) {
        compiled.overlays.push(r.source);
      } else {
        errors.push({ kind: "overlay", key: i, reason: r.reason, line: r.line, col: r.col });
      }
    }
  }

  // Brain (cosmetic) hooks — params: self, world, dt
  if (visualBlock.brains && typeof visualBlock.brains === "object") {
    for (const [key, src] of Object.entries(visualBlock.brains)) {
      const r = compileDraw(src, ["self", "world", "dt"]);
      if (r.ok) {
        compiled.brains[key] = r.source;
      } else {
        errors.push({ kind: "brain", key, reason: r.reason, line: r.line, col: r.col });
      }
    }
  }

  return { ok: errors.length === 0, compiled, errors };
}
