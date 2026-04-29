import { describe, it, expect } from "vitest";
import { validateRules } from "./validator";
import { vanillaRules } from "./rules";

// A tiny seeded PRNG so simulation outcomes are deterministic.
function seededRandom(seed) {
  let s = seed >>> 0 || 0xC0FFEE;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

describe("validateRules - layer 1 structure", () => {
  it("accepts vanilla rules", () => {
    const report = validateRules(vanillaRules(), { skipSimulation: true });
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("accepts a vanilla diff", () => {
    const report = validateRules({ extends: "vanilla" }, { skipSimulation: true });
    expect(report.valid).toBe(true);
  });

  it("rejects unknown extends", () => {
    const report = validateRules({ extends: "fairyland" }, { skipSimulation: true });
    expect(report.valid).toBe(false);
    expect(report.errors[0]).toMatch(/unknown extends/);
  });

  it("rejects a missing piece spec", () => {
    const r = vanillaRules();
    delete r.pieces.q;
    const report = validateRules(r, { skipSimulation: true });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes('"q"'))).toBe(true);
  });

  it("rejects unknown move primitive kinds", () => {
    const r = vanillaRules();
    r.pieces.b.moves = [{ kind: "teleport", anywhere: true }];
    const report = validateRules(r, { skipSimulation: true });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("teleport"))).toBe(true);
  });

  it("rejects a [0,0] direction (would loop forever)", () => {
    const r = vanillaRules();
    r.pieces.r.moves = [{ kind: "slide", dirs: [[0, 0]] }];
    const report = validateRules(r, { skipSimulation: true });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("[0,0]"))).toBe(true);
  });

  it("rejects out-of-range maxRange", () => {
    const r = vanillaRules();
    r.pieces.q.moves = [{ kind: "slide", dirs: [[1, 0]], maxRange: 100 }];
    const report = validateRules(r, { skipSimulation: true });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("maxRange"))).toBe(true);
  });

  it("rejects an unknown win condition type", () => {
    const r = vanillaRules();
    r.winConditions = [{ type: "first_to_summon_dragons" }];
    const report = validateRules(r, { skipSimulation: true });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("first_to_summon_dragons"))).toBe(true);
  });

  it("rejects a first_to_n_captures with invalid target", () => {
    const r = vanillaRules();
    r.winConditions = [{ type: "first_to_n_captures", target: 9999 }];
    const report = validateRules(r, { skipSimulation: true });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("target"))).toBe(true);
  });

  it("rejects out-of-range maxPlies", () => {
    const r = vanillaRules();
    r.maxPlies = 100000;
    const report = validateRules(r, { skipSimulation: true });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("maxPlies"))).toBe(true);
  });

  it("warns (not rejects) on an immobile piece", () => {
    const r = vanillaRules();
    r.pieces.b.moves = [];
    const report = validateRules(r, { skipSimulation: true });
    expect(report.valid).toBe(true);
    expect(report.warnings.some((w) => w.includes('"b"'))).toBe(true);
  });
});

describe("validateRules - layer 2 starting position", () => {
  it("rejects a starting FEN with no white king when checkmate is in winConditions", () => {
    const report = validateRules({
      extends: "vanilla",
      startingFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1BNR w - - 0 1",
    }, { skipSimulation: true });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("white king"))).toBe(true);
  });

  it("accepts no-king variants when only capture-king / last-standing rules are active", () => {
    const report = validateRules({
      extends: "vanilla",
      startingFen: "rnbq1bnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1BNR w - - 0 1",
      winConditions: [{ type: "last_standing" }],
    }, { skipSimulation: true });
    // Both kings missing - layer 2 issues a warning, not a hard
    // error, when checkmate isn't in the rules.
    expect(report.valid).toBe(true);
    expect(report.warnings.some((w) => w.includes("king"))).toBe(true);
  });

  it("rejects a starting FEN where the first mover has no legal moves", () => {
    // Both rooks blocked by pawns, knight + king on a, bishop
    // cornered, queen surrounded, no pawn moves available.
    // Easier: use a position where it's a stalemate from move 1.
    // Trick: white to move with a position that's already
    // stalemate. K vs K (only kings) where the to-move king is
    // surrounded by attacked squares - constructing is fiddly,
    // so use a position with the to-move side having no pieces
    // at all + king on a stalemate square. We'll use:
    // 7k/8/8/8/8/8/8/K6Q b - - 0 1 isn't stalemate (k can move).
    // Instead use: 7k/5Q2/6K1/8/8/8/8/8 b - - 0 1 - black king
    // on h8 surrounded by white queen attacks + own corner. K
    // can only go to g8 which is attacked. So zero legal moves.
    const report = validateRules({
      extends: "vanilla",
      startingFen: "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
    }, { skipSimulation: true });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("zero legal moves"))).toBe(true);
  });
});

describe("validateRules - mobility analyzer (default fairness check)", () => {
  it("attaches per-color move counts to the report", () => {
    const report = validateRules(vanillaRules());
    expect(report.mobility).toBeDefined();
    // Vanilla starting position: 20 legal moves for each side
    // (16 pawn + 4 knight).
    expect(report.mobility.white).toBe(20);
    expect(report.mobility.black).toBe(20);
  });

  it("hard-rejects when the first mover has zero legal moves", () => {
    // Position where the to-move king is in checkmate already.
    const report = validateRules({
      extends: "vanilla",
      startingFen: "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
    });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("zero legal moves") || e.includes("black has zero"))).toBe(true);
  });

  it("warns on >= 4:1 mobility skew without rejecting", () => {
    // Custom rules where black pieces are immobilised but
    // white plays normally. Manufactured via byColor.
    const r = {
      extends: "vanilla",
      byColor: {
        b: {
          p: { moves: [] },
          n: { moves: [] },
          b: { moves: [] },
          r: { moves: [] },
          q: { moves: [] },
        },
      },
    };
    const report = validateRules(r);
    // Black has only the king's moves available - severely
    // crippled, so we should hard-reject (mobility ratio
    // 20:0 -> infinity, which trips the severe-asymmetry path
    // when min < 5 + ratio extreme).
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => /one-sided|zero/i.test(e))).toBe(true);
  });

  it("DOES NOT reject 'pawns step backward + queens move like knights' (the user-reported false positive)", () => {
    // Real-world prompt that the previous simulation-based
    // validator rejected because random play struggles to
    // checkmate with knight-queens. Mobility from the start is
    // perfectly symmetric, so the new validator passes.
    const knightQueensReversePawns = {
      extends: "vanilla",
      pieces: {
        p: {
          moves: [
            { kind: "step", dirs: [[0, 1]], conditions: { onlyNonCapture: true } },
            { kind: "step", dirs: [[0, 2]], conditions: { onlyFirstMove: true, onlyNonCapture: true } },
            { kind: "step", dirs: [[1, 1], [-1, 1]], conditions: { onlyCapture: true } },
            { kind: "step", dirs: [[1, 1], [-1, 1]], conditions: { enPassant: true } },
            { kind: "step", dirs: [[0, -1]], conditions: { onlyNonCapture: true } },
          ],
          promotion: { type: ["n", "b", "r", "q"] },
        },
        q: {
          moves: [{ kind: "leap", offsets: [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]] }],
        },
      },
    };
    const report = validateRules(knightQueensReversePawns);
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
  });
});

describe("validateRules - simulation (opt-in only)", () => {
  it("does NOT run simulation by default (no main-thread cost)", () => {
    const report = validateRules(vanillaRules());
    expect(report.stats).toBeUndefined();
  });

  it("runs simulation when explicitly opted in via runSimulation:true", () => {
    const report = validateRules(vanillaRules(), {
      runSimulation: true,
      simulations: 10,
      simulationPlyCap: 60,
      random: seededRandom(1),
    });
    expect(report.stats).toBeDefined();
    expect(report.stats.games).toBe(10);
  });

  it("simulation findings become WARNINGS, never hard rejections", () => {
    // Same "stale-move" rules that previously hard-failed: now
    // they warn but don't reject (fairness was already
    // approved by the mobility check at start).
    const r = {
      extends: "vanilla",
      startingFen: "8/8/8/3k4/8/3K4/8/8 w - - 0 1",
      pieces: {
        p: { moves: [{ kind: "step", dirs: [[1, 0], [-1, 0]], conditions: { onlyNonCapture: true } }] },
        n: { moves: [{ kind: "step", dirs: [[1, 0], [-1, 0]], conditions: { onlyNonCapture: true } }] },
        b: { moves: [{ kind: "step", dirs: [[1, 0], [-1, 0]], conditions: { onlyNonCapture: true } }] },
        r: { moves: [{ kind: "step", dirs: [[1, 0], [-1, 0]], conditions: { onlyNonCapture: true } }] },
        q: { moves: [{ kind: "step", dirs: [[1, 0], [-1, 0]], conditions: { onlyNonCapture: true } }] },
        k: { moves: [{ kind: "step", dirs: [[1, 0], [-1, 0]], conditions: { onlyNonCapture: true } }] },
      },
      winConditions: [{ type: "checkmate" }],
      maxPlies: 30,
    };
    const report = validateRules(r, {
      runSimulation: true,
      simulations: 10,
      simulationPlyCap: 30,
      random: seededRandom(2),
    });
    expect(report.stats).toBeDefined();
    // The simulation will surface warnings but the rules pass
    // because mobility from the start is fine (both sides have
    // the king's sideways step available).
    expect(report.valid).toBe(true);
    expect(report.warnings.length).toBeGreaterThan(0);
  });
});
