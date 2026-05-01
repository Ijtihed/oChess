/**
 * Test the filterValidVisuals roundtrip:
 *   raw AI output -> validated/dropped -> cleaned shape stored on rules
 *
 * This is the most important Ship #3 boundary test. If
 * filterValidVisuals returns garbage, every downstream consumer
 * (the iframe overlay, the debug panel, the per-room cache)
 * inherits the bug.
 */

import { describe, it, expect } from "vitest";
import { filterValidVisuals } from "./ai-rules";

describe("filterValidVisuals - roundtrip cleaning of AI-emitted visuals", () => {
  it("returns { cleaned: undefined, errors: [] } for an empty input", () => {
    const r = filterValidVisuals({});
    expect(r.cleaned).toBeUndefined();
    expect(r.errors).toEqual([]);
  });

  it("preserves a single clean slot draw", () => {
    const raw = {
      slots: {
        "q.aura": `ctx.fillStyle = "red"; ctx.fillRect(-4, -4, 8, 8);`,
      },
    };
    const r = filterValidVisuals(raw);
    expect(r.errors).toEqual([]);
    expect(r.cleaned.slots["q.aura"]).toBe(raw.slots["q.aura"]);
    // Stored as RAW source (not the compiled function decl).
    expect(r.cleaned.slots["q.aura"]).not.toContain("function __draw__");
  });

  it("drops invalid slots, keeps valid ones", () => {
    const raw = {
      slots: {
        "q.aura": `ctx.fillRect(0, 0, 1, 1);`,           // ok
        "n.body": `fetch("//x"); ctx.fillRect(0, 0, 1, 1);`, // banned: fetch
        "p.aura": `eval("alert(1)");`,                      // banned: eval
        "k.aura": `ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI*2); ctx.fill();`, // ok
      },
    };
    const r = filterValidVisuals(raw);
    expect(Object.keys(r.cleaned.slots).sort()).toEqual(["k.aura", "q.aura"]);
    expect(r.errors.length).toBe(2);
    expect(r.errors.map((e) => e.key).sort()).toEqual(["n.body", "p.aura"]);
  });

  it("preserves a clean projectile draw", () => {
    const raw = {
      projectiles: {
        fireball: `ctx.fillStyle = "orange"; ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI*2); ctx.fill();`,
      },
    };
    const r = filterValidVisuals(raw);
    expect(r.errors).toEqual([]);
    expect(r.cleaned.projectiles.fireball).toBe(raw.projectiles.fireball);
  });

  it("drops projectiles using forbidden APIs", () => {
    const raw = {
      projectiles: {
        good: `ctx.fillRect(p.x, p.y, 4, 4);`,
        evil: `ctx.fillText("hax", p.x, p.y);`,        // ctx.fillText is banned
        unknown: `someGlobal.thing();`,                  // identifier not on allowlist
      },
    };
    const r = filterValidVisuals(raw);
    expect(Object.keys(r.cleaned.projectiles)).toEqual(["good"]);
    expect(r.errors.map((e) => e.key).sort()).toEqual(["evil", "unknown"]);
  });

  it("preserves overlays positionally and drops invalid ones", () => {
    const raw = {
      overlays: [
        `ctx.fillStyle = "rgba(0,0,0,0.1)"; ctx.fillRect(0, 0, scene.width, scene.height);`, // 0: ok
        `localStorage.setItem("k", "v");`,                                                    // 1: banned
        `ctx.beginPath(); ctx.arc(scene.width/2, scene.height/2, 50, 0, Math.PI*2); ctx.stroke();`, // 2: ok
      ],
    };
    const r = filterValidVisuals(raw);
    // Only entries 0 and 2 survive.
    expect(r.cleaned.overlays.length).toBe(2);
    expect(r.cleaned.overlays[0]).toBe(raw.overlays[0]);
    expect(r.cleaned.overlays[1]).toBe(raw.overlays[2]);
    expect(r.errors.length).toBe(1);
  });

  it("preserves brain (cosmetic) draws", () => {
    const raw = {
      brains: {
        q: `self.x;`,
        k: `world.spawnEffect; self.color;`,
      },
    };
    const r = filterValidVisuals(raw);
    expect(r.errors).toEqual([]);
    expect(Object.keys(r.cleaned.brains).sort()).toEqual(["k", "q"]);
  });

  it("drops a brain that touches forbidden APIs", () => {
    const raw = {
      brains: {
        q: `setTimeout(() => self.x, 100);`,
      },
    };
    const r = filterValidVisuals(raw);
    expect(r.cleaned).toBeUndefined();
    expect(r.errors.length).toBe(1);
  });

  it("returns cleaned: undefined when EVERYTHING was bad", () => {
    const raw = {
      slots: { "q.aura": `eval("1");` },
      projectiles: { x: `fetch("/y");` },
      overlays: [`document.body.innerHTML = "x";`],
      brains: { k: `requestAnimationFrame(() => 1);` },
    };
    const r = filterValidVisuals(raw);
    expect(r.cleaned).toBeUndefined();
    expect(r.errors.length).toBe(4);
  });

  it("returns cleaned: undefined when input was just empty containers", () => {
    const raw = { slots: {}, projectiles: {}, overlays: [], brains: {} };
    const r = filterValidVisuals(raw);
    expect(r.cleaned).toBeUndefined();
    expect(r.errors).toEqual([]);
  });

  it("strips empty containers from the cleaned shape", () => {
    // If the AI emits valid slots but empty everything else, the
    // cleaned shape should only have the slots key (not empty
    // projectiles/overlays/brains keys).
    const raw = {
      slots: { "q.aura": `ctx.fillRect(0, 0, 1, 1);` },
      projectiles: {},
      overlays: [],
      brains: {},
    };
    const r = filterValidVisuals(raw);
    expect(Object.keys(r.cleaned).sort()).toEqual(["slots"]);
  });

  it("is deterministic across runs (no Date / Math.random side effects)", () => {
    const raw = {
      slots: {
        "q.aura": `ctx.fillRect(0, 0, 1, 1);`,
        "n.body": `eval("nope");`,
      },
      projectiles: {
        fb: `ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI*2); ctx.fill();`,
      },
    };
    const a = filterValidVisuals(JSON.parse(JSON.stringify(raw)));
    const b = filterValidVisuals(JSON.parse(JSON.stringify(raw)));
    expect(a.cleaned).toEqual(b.cleaned);
    expect(a.errors).toEqual(b.errors);
  });

  it("reports the right `kind` field on each error so the debug panel can route them", () => {
    const raw = {
      slots:       { "q.aura": `eval("x");` },
      projectiles: { fb: `eval("y");` },
      overlays:    [`eval("z");`],
      brains:      { q: `eval("w");` },
    };
    const r = filterValidVisuals(raw);
    const kinds = r.errors.map((e) => e.kind).sort();
    expect(kinds).toEqual(["brain", "overlay", "projectile", "slot"]);
  });
});
