import { describe, it, expect } from "vitest";
import { compileVisuals, compileDraw } from "./compile-draws";

describe("compileDraw - single draw", () => {
  it("compiles a clean slot draw", () => {
    const r = compileDraw(
      `ctx.fillStyle = "red"; ctx.fillRect(x - 4, y - 4, 8, 8);`,
      ["ctx", "x", "y"],
    );
    expect(r.ok).toBe(true);
    // Output is a complete function decl that can be eval'd. Both
    // the guard ctx AND the guard fn are explicit parameters
    // because the iframe runtime evals via new Function which
    // breaks any closure over guard helpers.
    expect(r.source).toMatch(/^function __draw__\(__arenaGuardCtx__, __arenaGuard__, ctx, x, y\)/);
  });

  it("rejects a draw using fetch (validator catches)", () => {
    const r = compileDraw(`fetch("//x"); ctx.fillRect(0,0,1,1);`, ["ctx"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/fetch/);
  });

  it("rejects a draw using ctx.fillText (banned for safety)", () => {
    const r = compileDraw(`ctx.fillText("x", 0, 0);`, ["ctx"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/fillText/);
  });

  it("injects loop guards into validated draws", () => {
    const r = compileDraw(
      `for (let i = 0; i < 5; i++) { ctx.fillRect(i * 4, 0, 2, 2); }`,
      ["ctx"],
    );
    expect(r.ok).toBe(true);
    expect(r.source).toMatch(/__arenaGuard__/);
  });
});

describe("compileVisuals - whole visual block", () => {
  it("returns empty result for null/undefined input", () => {
    const r1 = compileVisuals(null);
    expect(r1.ok).toBe(true);
    expect(r1.compiled).toEqual({ slots: {}, projectiles: {}, effects: {}, overlays: [], brains: {} });

    const r2 = compileVisuals(undefined);
    expect(r2.ok).toBe(true);
  });

  it("compiles slot, projectile, effect, overlay, and brain draws together", () => {
    const block = {
      slots: {
        "q.aura": `ctx.fillStyle = "blue"; ctx.fillRect(-4, -4, 8, 8);`,
      },
      projectiles: {
        fireball: `ctx.fillStyle = "orange"; ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill();`,
      },
      effects: {
        impact: `ctx.fillStyle = "rgba(255,0,0," + (1 - e.progress) + ")"; ctx.fillRect(e.x, e.y, 4, 4);`,
      },
      overlays: [
        `ctx.fillStyle = "rgba(0,0,0,0.1)"; ctx.fillRect(0, 0, scene.width, scene.height);`,
      ],
      brains: {
        q: `self.x;`,
      },
    };
    const r = compileVisuals(block);
    expect(r.ok).toBe(true);
    expect(Object.keys(r.compiled.slots)).toEqual(["q.aura"]);
    expect(Object.keys(r.compiled.projectiles)).toEqual(["fireball"]);
    expect(Object.keys(r.compiled.effects)).toEqual(["impact"]);
    expect(r.compiled.overlays.length).toBe(1);
    expect(Object.keys(r.compiled.brains)).toEqual(["q"]);
  });

  it("drops invalid draws and reports them in errors", () => {
    const block = {
      slots: {
        "q.aura": `ctx.fillStyle = "blue"; ctx.fillRect(0, 0, 8, 8);`, // ok
        "n.body": `eval("alert(1)");`,                                    // banned
      },
    };
    const r = compileVisuals(block);
    expect(r.ok).toBe(false);
    expect(Object.keys(r.compiled.slots)).toEqual(["q.aura"]);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].kind).toBe("slot");
    expect(r.errors[0].key).toBe("n.body");
    expect(r.errors[0].reason).toMatch(/eval/);
  });

  it("wires the right parameter list per slot kind", () => {
    const block = {
      slots: { "q.body": `ctx.fillRect(0, 0, 1, 1);` },
      projectiles: { snap: `ctx.fillRect(p.x, p.y, 1, 1);` },
      effects: { boom: `ctx.fillRect(e.x, e.y, 1, 1);` },
      overlays: [`ctx.fillRect(0, 0, scene.width, 1);`],
      brains: { q: `self.type;` },
    };
    const r = compileVisuals(block);
    expect(r.ok).toBe(true);
    expect(r.compiled.slots["q.body"]).toContain("ctx, x, y, facing, owner, t, random, state");
    expect(r.compiled.projectiles.snap).toContain("ctx, p");
    expect(r.compiled.effects.boom).toContain("ctx, e, t");
    expect(r.compiled.overlays[0]).toContain("ctx, scene");
    expect(r.compiled.brains.q).toContain("self, world, dt, state, random");
  });
});
