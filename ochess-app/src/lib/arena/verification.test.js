import { describe, it, expect } from "vitest";
import { verifyRules } from "./verification";
import { repairRules } from "./repair";

// Helper: minimal-cost RNG for deterministic walks. Returns a
// function that cycles through preset values so the random walk
// is reproducible. For our purposes any deterministic RNG works -
// we're not testing randomness, we're testing that good variants
// pass and bad ones fail consistently.
function seededRandom(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// Defaults that keep tests under ~1s total. The Edge Function
// uses the production defaults (8 games × 100 plies); these
// reduced values are just for fast unit testing.
const FAST_OPTS = { simGames: 3, simPlyCap: 30, reachPlyCap: 6 };

// ── verifyRules ────────────────────────────────────────────

describe("verifyRules", () => {
  it("passes vanilla chess (no abilities, no win-condition surprises)", () => {
    const r = verifyRules({ extends: "vanilla" }, { ...FAST_OPTS, random: seededRandom() });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("flags ability whose offsets target only an unreachable corner", () => {
    // Bishop ability that targets ONLY [4, 4] - from c1 that
    // points to g5, an empty square. From f1 that's beyond the
    // board. Random walks of 4 plies can't unblock this since
    // the bishop's normal moves don't put it next to the right
    // corner.
    const r = verifyRules({
      extends: "vanilla",
      pieces: {
        b: {
          abilities: [{
            id: "snipe",
            target: {
              kind: "ranged",
              offsets: [[7, 7]],
              requireEnemy: true,
            },
            effect: { kind: "destroy" },
            gating: { charges: 1 },
          }],
        },
      },
    }, { ...FAST_OPTS, random: seededRandom() });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /too narrow|unreachable/.test(e))).toBe(true);
  });

  it("passes ability with a wide-enough offset list (turn-1 castable)", () => {
    // Offsets cover 1..7 in 8 directions. Turn-1 castable
    // since the queen on d1 can reach rank 7 enemies via dr=6
    // for example.
    const offsets = [];
    for (let n = 1; n <= 7; n++) {
      offsets.push([n, 0], [-n, 0], [0, n], [0, -n]);
      offsets.push([n, n], [-n, n], [n, -n], [-n, -n]);
    }
    const r = verifyRules({
      extends: "vanilla",
      pieces: {
        q: {
          abilities: [{
            id: "fireball",
            target: { kind: "ranged", offsets, requireEnemy: true },
            effect: { kind: "destroy" },
            gating: { charges: 3, cooldownPlies: 4 },
          }],
        },
      },
    }, { ...FAST_OPTS, random: seededRandom() });
    expect(r.ability_reach["both.q.fireball"].reachable_turn_1).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("flags race-to-squares with a piece that's not on the board", () => {
    const fenNoWhiteKnights = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/R1BQKB1R w KQkq - 0 1";
    const r = verifyRules({
      extends: "vanilla",
      overrides: { startingFen: fenNoWhiteKnights },
      winConditions: [
        { type: "race_to_squares", piece: "n", squaresWhite: ["e8"], squaresBlack: ["e1"] },
        { type: "checkmate" },
      ],
    }, { ...FAST_OPTS, random: seededRandom() });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /race_to_squares.*white/.test(e))).toBe(true);
  });

  it("returns a sim block we can inspect for asymmetric variants", () => {
    const fenWhitePawnsOnly = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1";
    const r = verifyRules({
      extends: "vanilla",
      overrides: { startingFen: fenWhitePawnsOnly },
    }, { ...FAST_OPTS, random: seededRandom() });
    expect(r.sim).toBeDefined();
    expect(r.sim.games).toBe(FAST_OPTS.simGames);
  });
});

// ── repairRules ────────────────────────────────────────────

describe("repairRules", () => {
  it("extends a too-narrow ranged ability so it becomes turn-1 castable", () => {
    // Same too-narrow corner-only fireball as above.
    const diff = {
      extends: "vanilla",
      pieces: {
        b: {
          abilities: [{
            id: "snipe",
            target: {
              kind: "ranged",
              offsets: [[7, 7]],
              requireEnemy: true,
            },
            effect: { kind: "destroy" },
            gating: { charges: 1 },
          }],
        },
      },
    };
    const before = verifyRules(diff, { ...FAST_OPTS, random: seededRandom() });
    expect(before.ok).toBe(false);

    const { repaired, applied } = repairRules(diff, before);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied[0]).toMatch(/extended/);

    // After repair, the ability should be turn-1 reachable
    // and the "too narrow" error should be gone.
    const after = verifyRules(repaired, { ...FAST_OPTS, random: seededRandom() });
    expect(after.ability_reach["both.b.snipe"].reachable_turn_1).toBe(true);
    expect(after.errors.some((e) => /too narrow|unreachable/.test(e))).toBe(false);

    // Original offset preserved, baseline added.
    const offsets = repaired.pieces.b.abilities[0].target.offsets;
    expect(offsets).toContainEqual([7, 7]);  // original kept
    expect(offsets).toContainEqual([1, 0]);  // baseline added
    expect(offsets).toContainEqual([0, 7]);  // long-range orthogonal added
  });

  it("does nothing when the input already passes verification", () => {
    const diff = { extends: "vanilla" };
    const report = verifyRules(diff, { ...FAST_OPTS, random: seededRandom() });
    expect(report.ok).toBe(true);
    const { repaired, applied } = repairRules(diff, report);
    expect(applied).toEqual([]);
    expect(repaired).toEqual(diff);
  });

  it("extends a slide ability by adding missing directions and removing maxRange caps", () => {
    const diff = {
      extends: "vanilla",
      pieces: {
        r: {
          abilities: [{
            id: "snipe",
            target: {
              kind: "slide",
              dirs: [[0, 1]],
              maxRange: 2,
              blockedByPieces: true,
            },
            effect: { kind: "destroy" },
            gating: { charges: 1 },
          }],
        },
      },
    };
    const before = verifyRules(diff, { ...FAST_OPTS, random: seededRandom() });
    expect(before.ok).toBe(false);

    const { repaired, applied } = repairRules(diff, before);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied[0]).toMatch(/missing directions|maxRange|blockedByPieces/);

    const ability = repaired.pieces.r.abilities[0];
    expect(ability.target.dirs.length).toBe(8); // 8 directions added
    expect(ability.target.maxRange).toBeUndefined(); // cap removed
    expect(ability.target.blockedByPieces).toBe(false); // flipped to false
  });
});
