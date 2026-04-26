import { describe, it, expect } from "vitest";
import { Chess } from "chess.js";
import { BOT_CONFIG, getThinkDelay, jceMoveToVerbose, uciToVerbose } from "./bot-engine";

describe("BOT_CONFIG", () => {
  it("has 8 levels (0-7)", () => {
    expect(BOT_CONFIG).toHaveLength(8);
    BOT_CONFIG.forEach((c, i) => expect(c.level).toBe(i));
  });

  it("levels 0 uses random engine", () => {
    expect(BOT_CONFIG[0].engine).toBe("random");
  });

  it("levels 1-3 use jce engine", () => {
    for (let i = 1; i <= 3; i++) {
      expect(BOT_CONFIG[i].engine).toBe("jce");
      expect(typeof BOT_CONFIG[i].jceLevel).toBe("number");
    }
  });

  it("levels 4-7 use sf engine", () => {
    for (let i = 4; i <= 7; i++) {
      expect(BOT_CONFIG[i].engine).toBe("sf");
      expect(typeof BOT_CONFIG[i].sfElo).toBe("number");
    }
  });

  it("each config has name and desc", () => {
    BOT_CONFIG.forEach((c) => {
      expect(c.name).toBeTruthy();
      expect(c.desc).toBeTruthy();
    });
  });

  it("stockfish level 7 has sfElo 0 (unlimited)", () => {
    expect(BOT_CONFIG[7].sfElo).toBe(0);
  });
});

describe("uciToVerbose", () => {
  it("returns null for empty / '(none)' input", () => {
    const c = new Chess();
    expect(uciToVerbose(c, null)).toBeNull();
    expect(uciToVerbose(c, "(none)")).toBeNull();
    expect(uciToVerbose(c, "")).toBeNull();
  });

  it("maps a 4-char UCI string to the matching verbose move", () => {
    const c = new Chess();
    const m = uciToVerbose(c, "e2e4");
    expect(m).toBeTruthy();
    expect(m.from).toBe("e2");
    expect(m.to).toBe("e4");
  });

  it("respects an explicit promotion suffix when underpromotion is legal", () => {
    // Position with a white pawn on a7 about to promote.
    const c = new Chess("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
    const queen = uciToVerbose(c, "a7a8q");
    const knight = uciToVerbose(c, "a7a8n");
    expect(queen?.promotion).toBe("q");
    expect(knight?.promotion).toBe("n");
  });

  it("falls back to ANY matching from/to when no promotion is specified", () => {
    const c = new Chess("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
    const m = uciToVerbose(c, "a7a8");
    expect(m).toBeTruthy();
    expect(m.from).toBe("a7");
    expect(m.to).toBe("a8");
  });

  it("returns null when the move isn't legal in the given position", () => {
    const c = new Chess();
    expect(uciToVerbose(c, "a1h8")).toBeNull();
  });
});

describe("jceMoveToVerbose", () => {
  it("returns null for null / empty result", () => {
    const c = new Chess();
    expect(jceMoveToVerbose(c, null)).toBeNull();
    expect(jceMoveToVerbose(c, {})).toBeNull();
  });

  it("translates the JCE { FROM: TO } object shape into a verbose move", () => {
    const c = new Chess();
    // js-chess-engine returns squares uppercase ({ E2: "E4" }).
    const m = jceMoveToVerbose(c, { E2: "E4" });
    expect(m).toBeTruthy();
    expect(m.from).toBe("e2");
    expect(m.to).toBe("e4");
  });

  it("returns null when the JCE move isn't legal in the position", () => {
    const c = new Chess();
    const m = jceMoveToVerbose(c, { A1: "H8" });
    expect(m).toBeNull();
  });
});

describe("getThinkDelay", () => {
  it("scales upward with bot level", () => {
    // Use the lower bound of each bracket so we can compare without
    // running into Math.random()'s noise.
    // Level <= 1: 200..600. Level 2-3: 300..800. Level 4-5: 500..1100.
    // Level 6-7: 700..1500.
    const samples = (level, n = 50) => {
      const xs = [];
      for (let i = 0; i < n; i++) xs.push(getThinkDelay(level));
      return Math.min(...xs);
    };
    expect(samples(0)).toBeGreaterThanOrEqual(200);
    expect(samples(0)).toBeLessThan(700);
    expect(samples(7)).toBeGreaterThanOrEqual(700);
  });

  it("returns a non-negative number for every supported level", () => {
    for (let l = 0; l <= 7; l++) {
      const d = getThinkDelay(l);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(d)).toBe(true);
    }
  });
});
