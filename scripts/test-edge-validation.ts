/**
 * Smoke-test the Edge Function's structural validator + new
 * validateVisualsBlock against a hand-rolled "what Gemini might
 * return" payload. Runs entirely in Deno - no Supabase, no
 * Gemini, no network. Purely exercises the parsing/validation
 * code path that runs server-side in production.
 *
 * Run with:
 *   deno run --allow-net --allow-env --allow-read scripts/test-edge-validation.ts
 *
 * (--allow-net is required because the module loads supabase-js
 * at top level which may bind sockets.)
 *
 * This is a sanity check: does the Edge Function's validator
 * actually accept what we want it to accept and reject what we
 * want it to reject? Confirms the new visuals validator works
 * before we deploy.
 */

import { validateStructure, validateVisualsBlock } from "../supabase/functions/arena_rules/index.ts";

let passed = 0;
let failed = 0;

function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log("  PASS  " + label);
  } else {
    failed++;
    console.log("  FAIL  " + label + (detail ? "  " + detail : ""));
  }
}

console.log("\n=== validateStructure ===\n");

// 1. Vanilla extension with no changes - should be valid in
//    both lab and non-lab modes.
{
  const errs = validateStructure({ extends: "vanilla" });
  assert("vanilla-only is valid", errs.length === 0, errs.join("; "));
}

// 2. Wrong extends value rejects.
{
  const errs = validateStructure({ extends: "antichess" });
  assert("non-vanilla extends rejects", errs.length > 0 && errs[0].includes("extends"));
}

// 3. A composable-primitives ability is allowed in lab mode,
//    rejected in non-lab.
{
  const variant = {
    extends: "vanilla",
    pieces: {
      q: {
        abilities: [{
          id: "blink",
          target: { kind: "leap", offsets: [[2, 0], [-2, 0]], requireEnemy: false, requireEmpty: true },
          effect: { kind: "relocate_self", destination: "target" },
          gating: { charges: 1 },
        }],
      },
    },
  };
  assert("relocate_self ability accepted in lab mode", validateStructure(variant, true).length === 0);
  const errs = validateStructure(variant, false);
  assert("relocate_self ability rejected in non-lab mode", errs.length > 0 && errs.some((e) => /lab|relocate|composable/i.test(e)));
}

console.log("\n=== validateVisualsBlock ===\n");

// 1. Empty visuals block is fine.
{
  const errs: string[] = [];
  validateVisualsBlock({}, errs);
  assert("empty visuals block accepts", errs.length === 0, errs.join("; "));
}

// 2. Slot key with valid format passes.
{
  const errs: string[] = [];
  validateVisualsBlock({
    slots: { "q.aura": "ctx.fillRect(0,0,1,1);" },
  }, errs);
  assert("valid slot key 'q.aura' accepts", errs.length === 0, errs.join("; "));
}

// 3. Slot with bogus key rejects.
{
  const errs: string[] = [];
  validateVisualsBlock({
    slots: { "queen.body": "ctx.fillRect(0,0,1,1);" },  // queen not q
  }, errs);
  assert("invalid slot key 'queen.body' rejects", errs.length > 0 && errs.some((e) => /queen\.body/.test(e)));
}

// 4. Empty draw source rejects.
{
  const errs: string[] = [];
  validateVisualsBlock({
    slots: { "q.aura": "" },
  }, errs);
  assert("empty draw source rejects", errs.length > 0);
}

// 5. Oversized draw source rejects.
{
  const errs: string[] = [];
  validateVisualsBlock({
    slots: { "q.aura": "x".repeat(8200) },
  }, errs);
  assert("oversized draw source rejects (>8192)", errs.length > 0 && errs.some((e) => /too long/.test(e)));
}

// 6. Too many slots rejects.
{
  const errs: string[] = [];
  const slots: Record<string, string> = {};
  // 28 max; insert 30 unique keys spanning all 7 slot names
  // across 5 piece types. (We only have 6 piece types so this
  // is the max we can do with valid keys.)
  const slotNames = ["body", "head", "back", "weapon_R", "weapon_L", "feet", "aura"];
  const pieces = ["p", "n", "b", "r", "q", "k"];
  for (const p of pieces) {
    for (const s of slotNames) {
      slots[`${p}.${s}`] = "ctx.fillRect(0,0,1,1);";
    }
  }
  // 6 * 7 = 42 slots; cap is 28.
  validateVisualsBlock({ slots }, errs);
  assert("too many slots (42 > 28) rejects", errs.length > 0 && errs.some((e) => /too many/.test(e)));
}

// 7. Projectile id with valid format passes.
{
  const errs: string[] = [];
  validateVisualsBlock({
    projectiles: { fireball: "ctx.fillRect(p.x,p.y,1,1);" },
  }, errs);
  assert("valid projectile id 'fireball' accepts", errs.length === 0, errs.join("; "));
}

// 8. Projectile id with invalid format rejects.
{
  const errs: string[] = [];
  validateVisualsBlock({
    projectiles: { "Fire-Ball!": "ctx.fillRect(p.x,p.y,1,1);" },
  }, errs);
  assert("invalid projectile id rejects", errs.length > 0);
}

// 9. Overlay accepts an array.
{
  const errs: string[] = [];
  validateVisualsBlock({
    overlays: ["ctx.fillRect(0,0,scene.width,1);"],
  }, errs);
  assert("overlays array accepts", errs.length === 0);
}

// 10. Overlay rejects non-array.
{
  const errs: string[] = [];
  validateVisualsBlock({
    overlays: "ctx.fillRect(0,0,1,1);",
  }, errs);
  assert("overlays as string rejects", errs.length > 0 && errs.some((e) => /array/.test(e)));
}

// 11. Brains accepts an object with brain keys.
{
  const errs: string[] = [];
  validateVisualsBlock({
    brains: { q: "self.x;" },
  }, errs);
  assert("brains object accepts", errs.length === 0);
}

// 12. Realistic full-block scenario: a "fireball queen" variant.
{
  const errs: string[] = [];
  validateVisualsBlock({
    slots: {
      "q.aura": `const r = 22 + Math.sin(t * 0.003) * 4; ctx.fillStyle = "rgba(255,140,0,0.4)"; ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.fill();`,
      "q.body": `ctx.fillStyle = "rgba(255,80,0,0.6)"; ctx.beginPath(); ctx.arc(0,0,12,0,Math.PI*2); ctx.fill();`,
    },
    projectiles: {
      fireball: `ctx.fillStyle = "orange"; for (let i = 0; i < 5; i++) { const back = i / 5; ctx.beginPath(); ctx.arc(p.x - (p.toX - p.fromX) * back * 0.2, p.y - (p.toY - p.fromY) * back * 0.2, 6 - i, 0, Math.PI*2); ctx.fill(); }`,
    },
    overlays: [
      `ctx.fillStyle = "rgba(0,0,0,0.05)"; ctx.fillRect(0, 0, scene.width, scene.height);`,
    ],
  }, errs);
  assert("realistic 'fireball queen' visuals block validates", errs.length === 0, errs.join("; "));
}

// 13. Whole-rules integration: full variant + visuals.
{
  const variant = {
    extends: "vanilla",
    name: "Fireball Queens",
    description: "Queens shoot fireballs and have a glowing aura.",
    pieces: {
      q: {
        abilities: [{
          id: "fireball",
          target: { kind: "ranged", offsets: [[1,0],[2,0],[-1,0],[-2,0],[0,1],[0,2],[0,-1],[0,-2]] },
          effect: { kind: "destroy" },
          gating: { charges: 3, cooldownPlies: 2 },
        }],
      },
    },
    visuals: {
      slots: { "q.aura": `ctx.fillStyle = "orange"; ctx.fillRect(-5,-5,10,10);` },
      projectiles: { fireball: `ctx.fillStyle = "red"; ctx.beginPath(); ctx.arc(p.x,p.y,5,0,Math.PI*2); ctx.fill();` },
    },
  };
  const errs = validateStructure(variant, true);
  assert("full variant + visuals passes structural validation in lab mode", errs.length === 0, errs.join("; "));
}

// 14. Same variant in non-lab mode accepts visuals. Mechanics
//     stay gated, but visual JS is sandboxed/client-validated
//     and should be available for every prompt user.
{
  const variant = {
    extends: "vanilla",
    name: "Fireball Queens",
    pieces: {
      q: {
        abilities: [{
          id: "fireball",
          target: { kind: "ranged", offsets: [[1,0]] },
          effect: { kind: "destroy" },
          gating: { charges: 3 },
        }],
      },
    },
    visuals: {
      slots: { "q.aura": `ctx.fillRect(0,0,1,1);` },
    },
  };
  const errs = validateStructure(variant, false);
  assert("visuals accepted in non-lab mode", errs.length === 0, errs.join("; "));
}

console.log(`\n=== Results ===\n  ${passed} passed, ${failed} failed\n`);
// Deno.serve in the imported module starts a background listener
// that prevents the process from exiting naturally. Force exit
// with the right status.
Deno.exit(failed > 0 ? 1 : 0);
