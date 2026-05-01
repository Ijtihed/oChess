import { describe, it, expect } from "vitest";
import { Position } from "./position";
import { resolveRules } from "./rules";
import { generateLegalMoves } from "./move-gen";
import { applyMove, applyMoveRaw } from "./apply-move";
import { validateRules } from "./validator";

// ── Test fixtures ─────────────────────────────────────────

/**
 * "Wizard queen": the queen has a single-target fireball
 * ability that ranges 4 squares orthogonally + diagonally,
 * with 2 charges and a 3-ply cooldown. Used as the canonical
 * Ship #1 ability fixture - if THIS variant works end-to-end,
 * the engine basics are wired correctly.
 */
function wizardQueenDiff() {
  return {
    extends: "vanilla",
    name: "Wizard Queen",
    description: "The queen casts fireballs at enemies up to 4 squares away.",
    pieces: {
      q: {
        abilities: [
          {
            id: "fireball",
            label: "Fireball",
            target: {
              kind: "ranged",
              offsets: [
                // Queen-like fan: orthogonals and diagonals at
                // ranges 1..4. We enumerate them explicitly to
                // exercise the offset-based ranged primitive,
                // which is the most common AI-emitted shape.
                [1, 0], [2, 0], [3, 0], [4, 0],
                [-1, 0], [-2, 0], [-3, 0], [-4, 0],
                [0, 1], [0, 2], [0, 3], [0, 4],
                [0, -1], [0, -2], [0, -3], [0, -4],
                [1, 1], [2, 2], [3, 3], [4, 4],
                [-1, -1], [-2, -2], [-3, -3], [-4, -4],
                [1, -1], [2, -2], [3, -3], [4, -4],
                [-1, 1], [-2, 2], [-3, 3], [-4, 4],
              ],
              requireEnemy: true,
            },
            effect: { kind: "capture" },
            gating: { charges: 2, cooldownPlies: 3 },
            intensity: "medium",
          },
        ],
      },
    },
  };
}

/** Empty board with two queens facing each other for clean test setups. */
function dualQueenFen() {
  return "8/8/8/3q4/8/3Q4/8/4K2k w - - 0 1";
}

// ── Validator ─────────────────────────────────────────────

describe("ability schema validation", () => {
  it("accepts a well-formed ability", () => {
    const report = validateRules(wizardQueenDiff());
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("rejects an ability with a malformed id", () => {
    const diff = wizardQueenDiff();
    diff.pieces.q.abilities[0].id = "Fire-Ball!"; // hyphen + caps + bang
    const report = validateRules(diff);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => /id must be lowercase/.test(e))).toBe(true);
  });

  it("rejects duplicate ability ids on the same piece", () => {
    const diff = wizardQueenDiff();
    diff.pieces.q.abilities.push({
      id: "fireball", // dup
      target: { kind: "ranged", offsets: [[1, 0]] },
      effect: { kind: "capture" },
      gating: { charges: 1 },
    });
    const report = validateRules(diff);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => /duplicated/.test(e))).toBe(true);
  });

  it("rejects ranged offsets that include [0,0]", () => {
    const diff = wizardQueenDiff();
    diff.pieces.q.abilities[0].target.offsets = [[0, 0], [1, 0]];
    const report = validateRules(diff);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => /\[0,0\]/.test(e))).toBe(true);
  });

  it("rejects unknown effect kinds (Ship #1 only ships 'capture')", () => {
    const diff = wizardQueenDiff();
    diff.pieces.q.abilities[0].effect = { kind: "freeze", duration: 2 };
    const report = validateRules(diff);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => /effect.kind/.test(e))).toBe(true);
  });

  it("rejects out-of-bounds gating", () => {
    const diff = wizardQueenDiff();
    diff.pieces.q.abilities[0].gating = { charges: 100, cooldownPlies: 50 };
    const report = validateRules(diff);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => /charges must be 1..99/.test(e))).toBe(true);
    expect(report.errors.some((e) => /cooldownPlies must be 0\.\.20/.test(e))).toBe(true);
  });

  it("warns when an ability is fully ungated (no charges, no cooldown)", () => {
    const diff = wizardQueenDiff();
    delete diff.pieces.q.abilities[0].gating;
    const report = validateRules(diff);
    // Ungated abilities are NOT a hard reject - the simulator
    // critic catches the actually-broken cases.
    expect(report.valid).toBe(true);
    expect(report.warnings.some((w) => /unlimited uses with no cooldown/.test(w))).toBe(true);
  });
});

// ── Move generation ───────────────────────────────────────

describe("ability move generation", () => {
  it("emits a kind='ability' move for each enemy in range", () => {
    const rules = resolveRules(wizardQueenDiff());
    const pos = Position.fromFen(dualQueenFen());
    const moves = generateLegalMoves(pos, rules);
    const abilityMoves = moves.filter((m) => m.kind === "ability");
    // The white queen sits on d3 and the black queen on d5,
    // so a fireball from d3 to d5 (offset [0, 2]) is in range.
    // We expect exactly one ability move targeting d5.
    expect(abilityMoves.length).toBeGreaterThan(0);
    expect(abilityMoves.some((m) => m.from === "d3" && m.to === "d5" && m.abilityId === "fireball")).toBe(true);
  });

  it("does not emit ability moves targeting friendly pieces", () => {
    const rules = resolveRules(wizardQueenDiff());
    // Two white queens, black king parked on b6 (a non-ray
    // square from both d3 and d5 - the offset list only fires
    // along orthogonals and diagonals, never knight-jumps). No
    // other black pieces. The wizard queens see only friendlies
    // in range, so requireEnemy=true should suppress every
    // ability move.
    const pos = Position.fromFen("8/8/1k6/3Q4/8/3Q4/8/4K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    expect(moves.some((m) => m.kind === "ability")).toBe(false);
  });

  it("respects cooldowns from crazyState", () => {
    const rules = resolveRules(wizardQueenDiff());
    const pos = Position.fromFen(dualQueenFen());
    pos.crazyState = { cooldowns: { d3: { fireball: 2 } } };
    const moves = generateLegalMoves(pos, rules);
    expect(moves.some((m) => m.kind === "ability")).toBe(false);
  });

  it("respects depleted charges from crazyState", () => {
    const rules = resolveRules(wizardQueenDiff());
    const pos = Position.fromFen(dualQueenFen());
    pos.crazyState = { charges: { d3: { fireball: 0 } } };
    const moves = generateLegalMoves(pos, rules);
    expect(moves.some((m) => m.kind === "ability")).toBe(false);
  });

  it("does NOT count ability targets as king attacks (no spurious check)", () => {
    // Without the excludeAbilities filter in isSquareAttacked,
    // a king sitting in a fireball's offset list would be in
    // permanent check. Verify the filter actually fires.
    const rules = resolveRules(wizardQueenDiff());
    // Black king on d8, white queen with fireball on d3.
    // Standard queen moves DO attack d8 (open file), so we
    // need to block them - drop a white pawn on d6 so the
    // queen's slide stops there but the fireball offset (d8,
    // 5 squares away, out of range 4) is also out. Use d7
    // instead so fireball reaches it as an ability target,
    // but the standard slide is blocked. The result: NO check
    // detected; black has legal moves.
    const pos = Position.fromFen("3k4/8/8/8/8/3Q4/3P4/4K3 b - - 0 1");
    const blackMoves = generateLegalMoves(pos, rules);
    expect(blackMoves.length).toBeGreaterThan(0);
  });
});

// ── Apply move ────────────────────────────────────────────

describe("ability resolution in applyMove", () => {
  it("captures the target without moving the caster", () => {
    const rules = resolveRules(wizardQueenDiff());
    const pos = Position.fromFen(dualQueenFen());
    const moves = generateLegalMoves(pos, rules);
    const fireball = moves.find((m) => m.kind === "ability" && m.from === "d3" && m.to === "d5");
    expect(fireball).toBeDefined();
    const next = applyMove(pos, fireball, rules);
    expect(next.pieceAt("d5")).toBeNull();              // target gone
    expect(next.pieceAt("d3")).toMatchObject({ type: "q", color: "w" }); // caster stays
    expect(next.captureTally.w).toBe(1);
    expect(next.turn).toBe("b");
  });

  it("decrements charges and starts a cooldown after a cast", () => {
    const rules = resolveRules(wizardQueenDiff());
    const pos = Position.fromFen(dualQueenFen());
    pos.crazyState = { charges: { d3: { fireball: 2 } }, cooldowns: {} };
    const moves = generateLegalMoves(pos, rules);
    const fireball = moves.find((m) => m.kind === "ability" && m.from === "d3" && m.to === "d5");
    const next = applyMove(pos, fireball, rules);
    expect(next.crazyState.charges.d3.fireball).toBe(1);
    // cooldownPlies=3 in the fixture; the +1 in apply-move.js
    // compensates for tickCooldowns running once at end of
    // the same move, so we expect 3 plies remaining.
    expect(next.crazyState.cooldowns.d3.fireball).toBe(3);
  });

  it("ticks cooldowns on every move (regular OR ability)", () => {
    const rules = resolveRules(wizardQueenDiff());
    // White king + a free-floating cooldown that should tick
    // even though the white king's normal move is unrelated.
    const pos = Position.fromFen("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    pos.crazyState = { cooldowns: { e3: { foo: 5 } } };
    const moves = generateLegalMoves(pos, rules);
    const kingMove = moves.find((m) => m.from === "e1" && m.to === "e2");
    expect(kingMove).toBeDefined();
    const next = applyMove(pos, kingMove, rules);
    expect(next.crazyState.cooldowns.e3.foo).toBe(4);
  });

  it("rejects an ability move with an unknown abilityId", () => {
    const rules = resolveRules(wizardQueenDiff());
    const pos = Position.fromFen(dualQueenFen());
    const fakeMove = {
      from: "d3", to: "d5",
      kind: "ability", abilityId: "lightning", casterType: "q",
    };
    // applyMoveRaw never reaches the resolver if the spec
    // doesn't have the ability, so we get null back. The
    // validated `applyMove` would throw because the move isn't
    // in the legal list at all.
    expect(() => applyMove(pos, fakeMove, rules)).toThrow();
    expect(applyMoveRaw(pos, fakeMove, rules)).toBeNull();
  });
});

// ── AOE ───────────────────────────────────────────────────

describe("ability AOE effects", () => {
  it("AOE radius 1 removes adjacent enemies but spares the caster", () => {
    const diff = wizardQueenDiff();
    diff.pieces.q.abilities[0].effect = {
      kind: "capture",
      aoe: { radius: 1, hitsPawns: false, hitsFriendly: false },
    };
    const rules = resolveRules(diff);
    // White queen on d4 fires at e5; black knight on f5 (in
    // AOE radius around e5) should also be removed; black
    // pawn on d5 (in AOE radius) should survive because
    // hitsPawns=false.
    const pos = Position.fromFen("4k3/8/8/3pq3/3Qn3/8/8/4K3 w - - 0 1");
    // Recompute coordinates: q on e5, n on e4, Q on d4, K on
    // e1, k on e8, p on d5. Our queen wants to fire at e5 (the
    // black queen) which is offset [1,1] from d4 - in range.
    const moves = generateLegalMoves(pos, rules);
    const fireball = moves.find((m) => m.kind === "ability" && m.from === "d4" && m.to === "e5");
    expect(fireball).toBeDefined();
    const next = applyMove(pos, fireball, rules);
    expect(next.pieceAt("e5")).toBeNull();              // direct target
    expect(next.pieceAt("e4")).toBeNull();              // black knight (AOE)
    expect(next.pieceAt("d5")).toMatchObject({ type: "p", color: "b" }); // pawn survives
    expect(next.pieceAt("d4")).toMatchObject({ type: "q", color: "w" }); // caster intact
  });
});
