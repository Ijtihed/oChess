import { describe, it, expect } from "vitest";
import { Position } from "./position";
import { resolveRules } from "./rules";
import { generateLegalMoves } from "./move-gen";
import { applyMove } from "./apply-move";
import { validateRules } from "./validator";
import { checkGameStatus } from "./win-check";

// ── Helpers ───────────────────────────────────────────────

/**
 * Build a minimal variant where one piece has one named ability with the
 * given `effect`. Everything else stays vanilla. Used to probe each
 * primitive in isolation.
 */
function variant(pieceType, effect, opts = {}) {
  return {
    extends: "vanilla",
    name: "test variant",
    pieces: {
      [pieceType]: {
        abilities: [
          {
            id: opts.id || "spell",
            label: opts.label || "Spell",
            target: opts.target || {
              kind: "ranged",
              offsets: queenFan4(),
              requireEnemy: opts.requireEnemy ?? true,
              requireEmpty: opts.requireEmpty ?? false,
            },
            effect,
            gating: opts.gating ?? { charges: 1 },
            intensity: "medium",
          },
        ],
      },
    },
  };
}

/**
 * Queen-shaped fan reaching 4 squares in 8 directions. Covers most test
 * fixtures so we don't have to hand-build offset lists per case.
 */
function queenFan4() {
  const out = [];
  for (let n = 1; n <= 4; n++) {
    out.push([n, 0], [-n, 0], [0, n], [0, -n]);
    out.push([n, n], [-n, n], [n, -n], [-n, -n]);
  }
  return out;
}

function abilityMove(moves, from, to) {
  return moves.find((m) => m.kind === "ability" && m.from === from && m.to === to);
}

// ── destroy (back-compat with Ship #1's "capture") ──────

describe("primitive: destroy", () => {
  // Standard test board: white queen on d3, black pawn on d4, kings far
  // apart and not attacked. Avoids king-safety checks interfering with
  // ability move generation.
  const TEST_FEN = "4k3/8/8/8/3p4/3Q4/8/4K3 w - - 0 1";

  it("legacy {kind:'capture'} still removes the target piece", () => {
    const rules = resolveRules(variant("q", { kind: "capture" }));
    const pos = Position.fromFen(TEST_FEN);
    const moves = generateLegalMoves(pos, rules);
    const cast = abilityMove(moves, "d3", "d4");
    expect(cast).toBeDefined();
    const next = applyMove(pos, cast, rules);
    expect(next.pieceAt("d4")).toBeNull();
    expect(next.pieceAt("d3")).toMatchObject({ type: "q", color: "w" });
  });

  it("kind:'destroy' is the new canonical name", () => {
    const rules = resolveRules(variant("q", { kind: "destroy" }));
    const pos = Position.fromFen(TEST_FEN);
    const moves = generateLegalMoves(pos, rules);
    const cast = abilityMove(moves, "d3", "d4");
    expect(cast).toBeDefined();
    const next = applyMove(pos, cast, rules);
    expect(next.pieceAt("d4")).toBeNull();
    expect(next.captureTally.w).toBe(1);
  });

  it("does not emit direct destroy abilities targeting kings", () => {
    const rules = resolveRules(variant("q", { kind: "destroy" }));
    const pos = Position.fromFen("8/8/8/8/3k4/3Q4/8/4K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const cast = abilityMove(moves, "d3", "d4");
    expect(cast).toBeUndefined();
  });

  it("AOE destroy removes adjacent pieces but never removes kings", () => {
    const rules = resolveRules(variant("q", {
      kind: "aoe_wrap",
      radius: 1,
      inner: { kind: "destroy" },
    }));
    // White queen targets black queen on d4; the blast also hits
    // the adjacent black king on d5.
    const pos = Position.fromFen("8/8/8/3k4/3q4/3Q4/8/4K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const cast = abilityMove(moves, "d3", "d4");
    expect(cast).toBeDefined();
    const next = applyMove(pos, cast, rules);
    expect(next.pieceAt("d4")).toBeNull();
    expect(next.findKing("b")).toBe("d5");
    expect(checkGameStatus(next, rules).ended).toBe(false);
  });
});

// ── displace ──────────────────────────────────────────────

describe("primitive: displace", () => {
  it("pushes target by a fixed delta", () => {
    const rules = resolveRules(variant("r", {
      kind: "displace",
      delta: [0, 2], // push 2 squares forward (relative to caster's color)
      onCollision: "stop",
    }));
    const pos = Position.fromFen("4k3/8/8/8/4p3/8/4R3/4K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const cast = abilityMove(moves, "e2", "e4");
    expect(cast).toBeDefined();
    const next = applyMove(pos, cast, rules);
    // Pawn was at e4, pushed [0, 2] forward = e6 (white-relative).
    expect(next.pieceAt("e4")).toBeNull();
    expect(next.pieceAt("e6")).toMatchObject({ type: "p", color: "b" });
    // Caster stays put.
    expect(next.pieceAt("e2")).toMatchObject({ type: "r", color: "w" });
  });

  it("bowls through colliders (destroy_collider)", () => {
    // Knight ability that bowls the target friendly pawn down a file,
    // destroying anything in its path. Demonstrates the canonical
    // "knights bowl pawns" pattern.
    const rules = resolveRules(variant("n", {
      kind: "displace",
      delta: [0, 4],
      onCollision: "destroy_collider",
    }, { requireEnemy: false, target: { kind: "ranged", offsets: [[0, 1]], requireEnemy: false } }));
    // White knight on d3, white pawn on d4 (the bowling ball), enemy
    // queen on d5, enemy bishop on d6, empty d7+.
    const pos = Position.fromFen("4k3/8/3b4/3q4/3P4/3N4/8/4K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const cast = abilityMove(moves, "d3", "d4");
    expect(cast).toBeDefined();
    const next = applyMove(pos, cast, rules);
    // Pawn bowled from d4 toward d8: hit q on d5 (destroy), then b on
    // d6 (destroy), then empty d7, then empty d8 - lands on d8.
    expect(next.pieceAt("d5")).toBeNull();
    expect(next.pieceAt("d6")).toBeNull();
    expect(next.pieceAt("d4")).toBeNull();
    expect(next.pieceAt("d8")).toMatchObject({ type: "p", color: "w" });
    expect(next.captureTally.w).toBeGreaterThanOrEqual(2);
  });

  it("destroys target when pushed off the edge", () => {
    const rules = resolveRules(variant("q", {
      kind: "displace",
      direction: "from_caster",
      distance: 5,
    }));
    // Black knight on a1, white queen on c3 - "from_caster" pushes
    // away from c3 along the line c3->a1, which goes off the board
    // after a1.
    const pos = Position.fromFen("4k3/8/8/8/8/2Q5/8/n3K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const cast = abilityMove(moves, "c3", "a1");
    expect(cast).toBeDefined();
    const next = applyMove(pos, cast, rules);
    expect(next.pieceAt("a1")).toBeNull();
    expect(next.captureTally.w).toBe(1);
  });
});

// ── relocate_self ─────────────────────────────────────────

describe("primitive: relocate_self", () => {
  it("blinks the caster onto an empty target square", () => {
    const rules = resolveRules(variant("b", {
      kind: "relocate_self",
      destination: "target",
    }, {
      requireEnemy: false,
      requireEmpty: true,
      target: {
        kind: "leap",
        offsets: [[2, 2], [-2, 2], [2, -2], [-2, -2], [4, 0], [-4, 0], [0, 4], [0, -4]],
        requireEnemy: false,
        requireEmpty: true,
      },
    }));
    const pos = Position.fromFen("4k3/8/8/8/8/8/8/2B1K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const blink = abilityMove(moves, "c1", "c5");
    expect(blink).toBeDefined();
    const next = applyMove(pos, blink, rules);
    expect(next.pieceAt("c1")).toBeNull();
    expect(next.pieceAt("c5")).toMatchObject({ type: "b", color: "w" });
  });
});

// ── spawn ─────────────────────────────────────────────────

describe("primitive: spawn", () => {
  it("conjures a friendly pawn on an empty target square", () => {
    const rules = resolveRules(variant("q", {
      kind: "spawn",
      pieceType: "p",
      color: "caster",
    }, {
      target: {
        kind: "leap",
        offsets: [[1, 0], [-1, 0], [0, 1], [0, -1]],
        requireEnemy: false,
        requireEmpty: true,
      },
    }));
    const pos = Position.fromFen("4k3/8/8/8/8/8/8/3QK3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const summon = abilityMove(moves, "d1", "d2");
    expect(summon).toBeDefined();
    const next = applyMove(pos, summon, rules);
    expect(next.pieceAt("d2")).toMatchObject({ type: "p", color: "w" });
    // Caster stays.
    expect(next.pieceAt("d1")).toMatchObject({ type: "q", color: "w" });
  });

  it("only emits spawn moves for empty target squares (move-gen filter)", () => {
    // The sane way to use spawn: set `requireEmpty: true` on the
    // target so move-gen never emits spawn at an occupied square.
    // The resolver's "target not empty" rejection is a defense in
    // depth - it kicks in only if a malformed variant tries to
    // bypass move-gen.
    const rules = resolveRules(variant("q", {
      kind: "spawn",
      pieceType: "p",
    }, {
      target: {
        kind: "leap",
        offsets: [[0, 1], [-2, 1]],
        requireEnemy: false,
        requireEmpty: true,
      },
    }));
    const pos = Position.fromFen("4k3/8/8/8/8/8/1p6/3Q3K w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    // d1+[0,1]=d2 empty -> emitted. d1+[-2,1]=b2 occupied -> filtered.
    expect(abilityMove(moves, "d1", "d2")).toBeDefined();
    expect(abilityMove(moves, "d1", "b2")).toBeUndefined();
  });
});

// ── transform ─────────────────────────────────────────────

describe("primitive: transform", () => {
  it("flips an enemy piece's color (mind control / charm)", () => {
    const rules = resolveRules(variant("b", {
      kind: "transform",
      color: "flip",
      duration: 3,
    }));
    const pos = Position.fromFen("4k3/8/8/8/3q4/8/2B5/4K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const charm = abilityMove(moves, "c2", "d4");
    // d4 is offset [1, 2] from c2 - actually that's a knight jump,
    // not in king-offsets. Let me try b3 instead (offset [-1, 1]).
    // ...actually the queen is at d4 from caster c2 - offset [1, 2]
    // is NOT a king offset. Set up the position so charm CAN reach.
    const rules2 = resolveRules(variant("b", {
      kind: "transform",
      color: "flip",
      duration: 3,
    }));
    const pos2 = Position.fromFen("4k3/8/8/8/8/2q5/2B5/4K3 w - - 0 1");
    const moves2 = generateLegalMoves(pos2, rules2);
    const charm2 = abilityMove(moves2, "c2", "c3");
    expect(charm2).toBeDefined();
    const next = applyMove(pos2, charm2, rules2);
    expect(next.pieceAt("c3")).toMatchObject({ type: "q", color: "w" });
    expect(charm).toBeUndefined(); // d4 is unreachable - sanity check
  });

  it("reverts after duration plies elapse", () => {
    const rules = resolveRules(variant("b", {
      kind: "transform",
      color: "flip",
      duration: 2,
    }));
    const pos = Position.fromFen("4k3/8/8/8/8/2q5/2B5/4K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const charm = abilityMove(moves, "c2", "c3");
    let state = applyMove(pos, charm, rules);
    // Charmed piece starts on white side. tickMarks ran once already
    // at end of cast = duration is now 1. Make a black pawn move
    // (any legal move) - state.turn flipped to black; let's find it.
    const blackMoves = generateLegalMoves(state, rules);
    state = applyMove(state, blackMoves[0], rules);
    // After this: duration was 1 -> 0 -> revert.
    expect(state.pieceAt("c3")).toMatchObject({ type: "q", color: "b" });
  });
});

// ── mark ──────────────────────────────────────────────────

describe("primitive: mark (status effects)", () => {
  it("freeze-style mark (skipTurns) suppresses target's moves while active", () => {
    const rules = resolveRules(variant("q", {
      kind: "mark",
      tag: "frost",
      duration: 2,
      skipTurns: true,
    }));
    // Black knight on d4 (offset [0,1] from caster d3, in queenFan4),
    // white queen on d3, kings tucked safely on the back ranks far
    // from any check.
    const pos = Position.fromFen("4k3/8/8/8/3n4/3Q4/8/4K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const freeze = abilityMove(moves, "d3", "d4");
    expect(freeze).toBeDefined();
    const next = applyMove(pos, freeze, rules);
    const blackMoves = generateLegalMoves(next, rules);
    const knightMoves = blackMoves.filter((m) => m.from === "d4");
    expect(knightMoves.length).toBe(0);
  });

  it("burn-style mark (destroyOnExpire) kills the target when timer hits 0", () => {
    const rules = resolveRules(variant("q", {
      kind: "mark",
      tag: "burning",
      duration: 1,
      destroyOnExpire: true,
    }));
    const pos = Position.fromFen("4k3/8/8/8/3n4/3Q4/8/4K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const burn = abilityMove(moves, "d3", "d4");
    expect(burn).toBeDefined();
    const next = applyMove(pos, burn, rules);
    // Mark applied with duration=1; tickMarks at end of cast = 1->0,
    // destroy fires immediately. Knight should be gone.
    expect(next.pieceAt("d4")).toBeNull();
  });

  it("shield-style mark (absorbCaptures) blocks the next regular capture", () => {
    const rules = resolveRules(variant("b", {
      kind: "mark",
      tag: "ward",
      absorbCaptures: 1,
    }, {
      target: {
        kind: "leap",
        offsets: [[0, 1], [1, 0], [-1, 0], [0, -1]],
        requireEnemy: false,
      },
    }));
    // White bishop on c1 shields the friendly knight on c2. Black
    // queen on c8 attacks down the c-file and would capture knight.
    const pos = Position.fromFen("2q1k3/8/8/8/8/8/2N5/2B1K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const ward = abilityMove(moves, "c1", "c2");
    expect(ward).toBeDefined();
    let state = applyMove(pos, ward, rules);
    // Now black moves. Find Qxc2 - the queen can slide to c2 and
    // would capture the knight, except for the shield.
    const blackMoves = generateLegalMoves(state, rules);
    const qxc2 = blackMoves.find((m) => m.from === "c8" && m.to === "c2" && m.kind !== "ability");
    expect(qxc2).toBeDefined();
    state = applyMove(state, qxc2, rules);
    // Shield absorbed; knight still on c2; queen still on c8 (the
    // attack bounced).
    expect(state.pieceAt("c2")).toMatchObject({ type: "n", color: "w" });
    expect(state.pieceAt("c8")).toMatchObject({ type: "q", color: "b" });
    // Shield mark consumed.
    expect(state.crazyState?.effects?.c2 || []).toEqual([]);
  });
});

// ── aoe_wrap ──────────────────────────────────────────────

describe("primitive: aoe_wrap", () => {
  it("freezes everything in a radius around the target (frost mage)", () => {
    const rules = resolveRules(variant("q", {
      kind: "aoe_wrap",
      radius: 1,
      hitsPawns: true,
      inner: { kind: "mark", tag: "frost", duration: 3, skipTurns: true },
    }));
    // White queen on d3 targets d5 (the knight - default
    // requireEnemy=true means we need an enemy at the target). AOE
    // radius 1 around d5 covers c4-e4 and c5-e5 and c6-e6. Pieces in
    // range: knight on d5 (target), pawn on c4 (in radius). Pawn at
    // g7 is far away and stays mobile.
    const pos = Position.fromFen("4k3/6p1/8/3n4/2p5/3Q4/8/4K3 w - - 0 1");
    const moves = generateLegalMoves(pos, rules);
    const cast = abilityMove(moves, "d3", "d5");
    expect(cast).toBeDefined();
    const next = applyMove(pos, cast, rules);
    const blackMoves = generateLegalMoves(next, rules);
    expect(blackMoves.some((m) => m.from === "c4")).toBe(false);
    expect(blackMoves.some((m) => m.from === "d5")).toBe(false);
    expect(blackMoves.some((m) => m.from === "g7")).toBe(true);
  });
});

// ── Validator coverage ───────────────────────────────────

describe("validator: composable primitives", () => {
  it("accepts every primitive kind", () => {
    const cases = [
      { kind: "destroy" },
      { kind: "displace", delta: [1, 0] },
      { kind: "relocate_self", destination: "target" },
      { kind: "spawn", pieceType: "p" },
      { kind: "transform", color: "flip" },
      { kind: "mark", tag: "test", duration: 3, skipTurns: true },
      { kind: "aoe_wrap", radius: 1, inner: { kind: "destroy" } },
    ];
    for (const eff of cases) {
      const report = validateRules(variant("q", eff));
      expect(report.valid, `effect ${eff.kind} should be valid: ${JSON.stringify(report.errors)}`).toBe(true);
    }
  });

  it("rejects nested aoe_wrap", () => {
    const report = validateRules(variant("q", {
      kind: "aoe_wrap",
      radius: 1,
      inner: { kind: "aoe_wrap", radius: 1, inner: { kind: "destroy" } },
    }));
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => /aoe_wrap.*nested/.test(e))).toBe(true);
  });

  it("rejects spawn of a king", () => {
    const report = validateRules(variant("q", { kind: "spawn", pieceType: "k" }));
    expect(report.valid).toBe(false);
  });

  it("rejects malformed mark.tag", () => {
    const report = validateRules(variant("q", {
      kind: "mark",
      tag: "Bad-Tag!",
      duration: 2,
    }));
    expect(report.valid).toBe(false);
  });

  it("rejects displace without delta or direction", () => {
    const report = validateRules(variant("q", { kind: "displace" }));
    expect(report.valid).toBe(false);
  });
});
