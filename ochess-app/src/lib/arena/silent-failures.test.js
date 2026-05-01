import { describe, it, expect } from "vitest";
import { Position } from "./position";
import { resolveRules } from "./rules";
import { generateLegalMoves } from "./move-gen";
import { applyMove } from "./apply-move";

/**
 * Regression tests for "silent failure" cases the AI hits in
 * the wild: structurally-valid abilities that previously slipped
 * through move-gen and then threw VariantError mid-resolve, so
 * the user clicked a red crosshair and got a confusing red
 * error toast instead of a cast.
 *
 * The fix is in computeTargetFilter() in move-gen.js: it
 * combines the AI's explicit target.requireEnemy/requireEmpty
 * flags with the requirements implied by the EFFECT kind, so
 * a "spawn" ability never offers crosshairs on occupied
 * squares, a "displace" ability never offers crosshairs on
 * empty squares, etc. This file locks in that contract.
 */

function variant(pieceType, ability) {
  return {
    extends: "vanilla",
    pieces: { [pieceType]: { abilities: [ability] } },
  };
}

describe("silent-failure: spawn ability misses requireEmpty flag", () => {
  it("move-gen filters out occupied squares even when the AI omitted requireEmpty", () => {
    // The AI emits a spawn that should target empty squares but
    // forgets requireEmpty. Without the implicit-filter fix,
    // move-gen would emit casts on enemy squares too, and the
    // resolver would throw VariantError when the user clicked
    // one.
    const rules = resolveRules(variant("q", {
      id: "summon",
      target: {
        kind: "leap",
        offsets: [[0, 1], [1, 0], [-1, 0]],
        // requireEnemy: false (defaults true via "ranged"
        // semantics); but spawn implies empty, so the filter
        // should override.
      },
      effect: { kind: "spawn", pieceType: "p", color: "caster" },
      gating: { charges: 1 },
    }));
    // Position: white queen on d4, enemies surrounding (n on c4,
    // p on d5, n on e4). All three target offsets are occupied
    // by enemies. Expected: NO crosshairs.
    const pos = Position.fromFen("4k3/8/8/3p4/2nQn3/8/8/4K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const ab = moves.filter((m) => m.kind === "ability");
    // None of [0,1]=d5 (pawn), [1,0]=e4 (knight), [-1,0]=c4
    // (knight) are empty. Move-gen should filter ALL out.
    expect(ab).toEqual([]);
  });

  it("spawn still works when there ARE empty squares in range", () => {
    const rules = resolveRules(variant("q", {
      id: "summon",
      target: {
        kind: "leap",
        offsets: [[0, 1], [0, -1], [-1, 0]],
      },
      effect: { kind: "spawn", pieceType: "p", color: "caster" },
      gating: { charges: 1 },
    }));
    // Empty board behind/around the queen so the spawn has
    // legitimate targets.
    const pos = Position.fromFen("4k3/8/8/8/3Q4/8/8/4K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const ab = moves.filter((m) => m.kind === "ability");
    // d5, d3, c4 all empty. All three should be legal targets.
    expect(ab.length).toBe(3);
    // Each cast should resolve cleanly without VariantError.
    for (const m of ab) {
      const next = applyMove(pos, m, rules);
      expect(next).toBeDefined();
      // The new piece should be at the target square.
      expect(next.pieceAt(m.to)).toBeDefined();
    }
  });
});

describe("silent-failure: displace on empty target", () => {
  it("move-gen filters out empty squares for displace abilities", () => {
    const rules = resolveRules(variant("q", {
      id: "push",
      target: {
        kind: "ranged",
        offsets: [[0, 1], [0, 2], [0, 3]],
        requireEnemy: false, // AI explicitly disabled
      },
      effect: { kind: "displace", delta: [0, 1] },
      gating: { charges: 1 },
    }));
    // White queen on d3, enemy pawn on d5. Offsets target d4
    // (empty), d5 (pawn), d6 (empty).
    const pos = Position.fromFen("4k3/8/8/3p4/8/3Q4/8/4K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const ab = moves.filter((m) => m.kind === "ability");
    // Only d5 (the pawn) should be offered. d4 and d6 are
    // empty - displace would throw "no piece at target".
    expect(ab.length).toBe(1);
    expect(ab[0].to).toBe("d5");
    // Cast resolves cleanly.
    const next = applyMove(pos, ab[0], rules);
    expect(next).toBeDefined();
  });
});

describe("silent-failure: mark on empty target", () => {
  it("move-gen filters out empty squares for mark abilities", () => {
    const rules = resolveRules(variant("q", {
      id: "freeze",
      target: {
        kind: "ranged",
        offsets: [[0, 1], [0, 2], [0, 3]],
        requireEnemy: false,
      },
      effect: { kind: "mark", tag: "frost", duration: 2, skipTurns: true },
      gating: { charges: 1 },
    }));
    const pos = Position.fromFen("4k3/8/8/3p4/8/3Q4/8/4K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const ab = moves.filter((m) => m.kind === "ability");
    // Only d5 (pawn) - empty squares filtered out.
    expect(ab.length).toBe(1);
    expect(ab[0].to).toBe("d5");
    const next = applyMove(pos, ab[0], rules);
    expect(next.crazyState?.effects?.d5).toBeDefined();
  });
});

describe("silent-failure: AOE wrap respects inner filter", () => {
  it("AOE-wrap freeze filter inherits from inner mark requirements", () => {
    const rules = resolveRules(variant("q", {
      id: "frost_burst",
      target: {
        kind: "ranged",
        offsets: [[0, 1], [0, 2], [0, 3]],
        requireEnemy: false,
      },
      effect: {
        kind: "aoe_wrap",
        radius: 1,
        inner: { kind: "mark", tag: "frost", duration: 2, skipTurns: true },
      },
      gating: { charges: 1 },
    }));
    // Same as above - the centre target needs a piece (because
    // the inner mark needs one). Empty squares filtered out.
    const pos = Position.fromFen("4k3/8/8/3p4/8/3Q4/8/4K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const ab = moves.filter((m) => m.kind === "ability");
    expect(ab.length).toBe(1);
    expect(ab[0].to).toBe("d5");
  });
});
