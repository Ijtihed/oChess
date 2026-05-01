import { describe, it, expect } from "vitest";
import { buildVisualRepairs, repairVisualsForRules } from "./visual-repair";
import { compileVisuals } from "./visual-sandbox/compile-draws";

function rulesWithAbility(id, label, effect = { kind: "destroy" }, piece = "q") {
  return {
    extends: "vanilla",
    name: label,
    pieces: {
      [piece]: {
        abilities: [{
          id,
          label,
          target: { kind: "ranged", offsets: [[1, 0]], requireEnemy: true },
          effect,
          gating: { charges: 3 },
        }],
      },
    },
  };
}

describe("visual repair", () => {
  it("synthesizes concrete fireball visuals for a fireball ability", () => {
    const rules = rulesWithAbility("fireball", "Fireball", { kind: "aoe_wrap", radius: 1, inner: { kind: "destroy" } });
    const repaired = repairVisualsForRules(rules);
    expect(repaired.visuals.slots["q.aura"]).toBeTruthy();
    expect(repaired.visuals.slots["q.weapon_R"]).toBeTruthy();
    expect(repaired.visuals.projectiles.fireball).toBeTruthy();
    expect(repaired.visuals.effects.fire_ember).toBeTruthy();
    expect(repaired.visuals.brains.q).toBeTruthy();
    expect(repaired.visuals.overlays.length).toBeGreaterThan(0);
    const compiled = compileVisuals(repaired.visuals);
    expect(compiled.errors).toEqual([]);
  });

  it("synthesizes ice visuals for a freeze ability", () => {
    const rules = rulesWithAbility("freeze", "Freeze", { kind: "mark", tag: "frozen", duration: 2 }, "b");
    const repaired = repairVisualsForRules(rules);
    expect(repaired.visuals.slots["b.aura"]).toBeTruthy();
    expect(repaired.visuals.slots["b.back"]).toBeTruthy();
    expect(repaired.visuals.projectiles.freeze).toBeTruthy();
    expect(repaired.visuals.effects.ice_spark).toBeTruthy();
    const compiled = compileVisuals(repaired.visuals);
    expect(compiled.errors).toEqual([]);
  });

  it("preserves AI-provided visual keys and only fills missing ones", () => {
    const rules = rulesWithAbility("fireball", "Fireball");
    rules.visuals = {
      slots: { "q.aura": "ctx.fillRect(0,0,1,1);" },
      projectiles: { fireball: "ctx.fillRect(p.x,p.y,1,1);" },
    };
    const repaired = repairVisualsForRules(rules);
    expect(repaired.visuals.slots["q.aura"]).toBe("ctx.fillRect(0,0,1,1);");
    expect(repaired.visuals.projectiles.fireball).toBe("ctx.fillRect(p.x,p.y,1,1);");
    expect(repaired.visuals.slots["q.weapon_R"]).toBeTruthy();
  });

  it("collects byColor abilities too", () => {
    const rules = {
      extends: "vanilla",
      byColor: {
        b: {
          q: {
            abilities: [{
              id: "shadow_bolt",
              label: "Shadow Bolt",
              target: { kind: "ranged", offsets: [[1, 0]], requireEnemy: true },
              effect: { kind: "destroy" },
            }],
          },
        },
      },
    };
    const visuals = buildVisualRepairs(rules);
    expect(visuals.projectiles.shadow_bolt).toBeTruthy();
    expect(visuals.slots["q.aura"]).toBeTruthy();
    expect(compileVisuals(visuals).errors).toEqual([]);
  });

  it("does nothing for variants with no abilities", () => {
    const rules = { extends: "vanilla", name: "Plain" };
    expect(repairVisualsForRules(rules)).toBe(rules);
  });
});
