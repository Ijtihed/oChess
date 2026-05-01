import { describe, it, expect } from "vitest";
import { injectLoopGuard } from "./inject-loop-guard";

/**
 * Verify the injected code by actually EXECUTING it with a stub
 * guard helper that throws after N calls. If the injection
 * worked, the user's loop should never iterate more than N
 * times.
 *
 * This is the key correctness test: not just "is the source
 * structurally correct" but "does it actually catch infinite
 * loops at runtime."
 */
function executeWithGuard(injected, params, maxIters, ...args) {
  // The wrapper takes (guardCtx, ...userParams).
  // We pass a guardCtx + a guard fn that increments + throws
  // after maxIters.
  const guardCtx = { count: 0 };
  const guard = (ctx) => {
    ctx.count += 1;
    if (ctx.count > maxIters) throw new Error("MAX_ITERS");
  };
  // The injected source defines `__draw__`. We need to make
  // `__arenaGuard__` resolvable inside it. Easiest: pass it
  // through an enclosing wrapper.
  const wrapper = new Function(
    "__arenaGuard__",
    "args",
    `${injected}; return __draw__(args[0], ...args.slice(1));`,
  );
  return wrapper(guard, [guardCtx, ...args]);
}

describe("injectLoopGuard - source rewriting", () => {
  it("wraps the body in a __draw__ function with the guard ctx as the first param", () => {
    const r = injectLoopGuard(`ctx.fillRect(0, 0, 1, 1);`, ["ctx"]);
    expect(r.ok).toBe(true);
    expect(r.source).toMatch(/^function __draw__\(__arenaGuardCtx__, ctx\)/);
  });

  it("injects a guard call into a for loop's block body", () => {
    const r = injectLoopGuard(`for (let i = 0; i < 3; i++) { ctx.fillRect(0, 0, 1, 1); }`, ["ctx"]);
    expect(r.ok).toBe(true);
    expect(r.source).toMatch(/__arenaGuard__\(__arenaGuardCtx__\);/);
  });

  it("injects a guard call into a while loop", () => {
    const r = injectLoopGuard(`let i = 0; while (i < 3) { i++; }`, []);
    expect(r.ok).toBe(true);
    // Count of guard calls in output should match number of loops.
    expect((r.source.match(/__arenaGuard__/g) || []).length).toBe(1);
  });

  it("wraps a bare-statement loop body in a block + guard", () => {
    // `for (let i = 0; i < 3; i++) ctx.fillRect(0,0,1,1);`
    // becomes `for (...) { __arenaGuard__(...); ctx.fillRect(...); }`
    const r = injectLoopGuard(`for (let i = 0; i < 3; i++) ctx.fillRect(0, 0, 1, 1);`, ["ctx"]);
    expect(r.ok).toBe(true);
    expect(r.source).toMatch(/__arenaGuard__/);
  });

  it("handles do-while", () => {
    const r = injectLoopGuard(`let i = 0; do { i++; } while (i < 3);`, []);
    expect(r.ok).toBe(true);
    expect((r.source.match(/__arenaGuard__/g) || []).length).toBe(1);
  });

  it("handles for-in and for-of", () => {
    const r1 = injectLoopGuard(`for (const k in {a:1, b:2}) { k.toString(); }`, []);
    expect(r1.ok).toBe(true);
    expect((r1.source.match(/__arenaGuard__/g) || []).length).toBe(1);

    const r2 = injectLoopGuard(`for (const v of [1,2,3]) { v.toString(); }`, []);
    expect(r2.ok).toBe(true);
    expect((r2.source.match(/__arenaGuard__/g) || []).length).toBe(1);
  });

  it("injects into nested loops independently", () => {
    const r = injectLoopGuard(
      `for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { ctx.fillRect(i, j, 1, 1); } }`,
      ["ctx"],
    );
    expect(r.ok).toBe(true);
    expect((r.source.match(/__arenaGuard__/g) || []).length).toBe(2);
  });

  it("doesn't inject for non-loop blocks", () => {
    const r = injectLoopGuard(`if (true) { ctx.fillRect(0, 0, 1, 1); } else { ctx.fillRect(2, 2, 1, 1); }`, ["ctx"]);
    expect(r.ok).toBe(true);
    expect(r.source).not.toMatch(/__arenaGuard__/);
  });

  it("handles inner functions with their own loops", () => {
    const r = injectLoopGuard(
      `function inner() { for (let i = 0; i < 5; i++) { i; } } inner();`,
      [],
    );
    expect(r.ok).toBe(true);
    expect((r.source.match(/__arenaGuard__/g) || []).length).toBe(1);
  });
});

describe("injectLoopGuard - runtime behaviour (the actual safety check)", () => {
  it("a loop with 5 iterations runs cleanly when guard cap is 10", () => {
    const { source } = injectLoopGuard(
      `for (let i = 0; i < 5; i++) {}`,
      [],
    );
    // No throw expected.
    expect(() => executeWithGuard(source, [], 10)).not.toThrow();
  });

  it("an infinite loop is killed by the guard", () => {
    const { source } = injectLoopGuard(
      `let i = 0; while (true) { i++; }`,
      [],
    );
    expect(() => executeWithGuard(source, [], 50)).toThrow("MAX_ITERS");
  });

  it("a tight 100k-iter loop is killed at the cap", () => {
    const { source } = injectLoopGuard(
      `for (let i = 0; i < 100000; i++) {}`,
      [],
    );
    expect(() => executeWithGuard(source, [], 1000)).toThrow("MAX_ITERS");
  });

  it("a nested infinite loop is killed", () => {
    const { source } = injectLoopGuard(
      `for (let i = 0; i < 10; i++) { while (true) { i; } }`,
      [],
    );
    expect(() => executeWithGuard(source, [], 100)).toThrow("MAX_ITERS");
  });

  it("a do-while infinite loop is killed", () => {
    const { source } = injectLoopGuard(
      `let i = 0; do { i++; } while (true);`,
      [],
    );
    expect(() => executeWithGuard(source, [], 100)).toThrow("MAX_ITERS");
  });

  it("a bare-statement infinite loop body is still killed", () => {
    const { source } = injectLoopGuard(
      `for (;;) ctx.fillStyle = "red";`,
      ["ctx"],
    );
    expect(() => executeWithGuard(source, [], 50, { fillStyle: null })).toThrow("MAX_ITERS");
  });

  it("a typical bounded particle loop runs without tripping the guard", () => {
    const { source } = injectLoopGuard(`
      for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4;
        ctx.fillRect(x + Math.cos(angle) * 10, y + Math.sin(angle) * 10, 2, 2);
      }
    `, ["ctx", "x", "y"]);
    const ctxStub = { fillRect: () => {} };
    // Cap is 100; loop runs 8 iterations. Should NOT throw.
    expect(() => executeWithGuard(source, ["ctx", "x", "y"], 100, ctxStub, 0, 0)).not.toThrow();
  });
});
