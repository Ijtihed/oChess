import { describe, it, expect } from "vitest";
import { classifyMove, ANNOTATIONS } from "./move-classify";

// These tests pin classifyMove against Lichess's published
// algorithm: judgements come from *winning-chances* delta, not
// raw centipawn loss. Bands (server-side server analysis):
//
//   inaccuracy: wc loss >= 0.10  (≈  75-130 cp from equal)
//   mistake:    wc loss >= 0.20  (≈ 130-185 cp from equal)
//   blunder:    wc loss >= 0.30  (≈ 185+   cp from equal)
//
// The cp ranges shift with starting eval - that's the whole point
// of the wc-based system: a 100 cp swing from equal is a real
// mistake, the same 100 cp swing from -600 to -700 is noise.

describe("classifyMove - book / no-data short circuits", () => {
  it("returns the book annotation when isBook is true (no eval needed)", () => {
    const a = classifyMove(null, null, "w", { isBook: true });
    expect(a).toBe(ANNOTATIONS.book);
  });

  it("returns null when either eval is missing and not in book", () => {
    expect(classifyMove(null, { cp: 0 }, "w")).toBeNull();
    expect(classifyMove({ cp: 0 }, null, "w")).toBeNull();
  });
});

describe("classifyMove - Lichess winning-chances bands (white to move)", () => {
  it("classifies a swing from equal to clearly losing as a blunder", () => {
    // 0 cp -> -300 cp = wc loss ≈ 0.50 (over the 0.30 cutoff).
    expect(classifyMove({ cp: 0 }, { cp: -300 }, "w")).toBe(ANNOTATIONS.blunder);
    // Even a 50 -> -250 swing is clearly a blunder by wc.
    expect(classifyMove({ cp: 50 }, { cp: -250 }, "w")).toBe(ANNOTATIONS.blunder);
  });

  it("classifies a moderate swing as a mistake (wc loss in 0.20-0.30)", () => {
    // 0 cp -> -150 cp = wc loss ≈ 0.27 -> mistake.
    expect(classifyMove({ cp: 0 }, { cp: -150 }, "w")).toBe(ANNOTATIONS.mistake);
  });

  it("classifies a small swing near equal as an inaccuracy", () => {
    // 0 cp -> -80 cp = wc loss ≈ 0.15 -> inaccuracy.
    expect(classifyMove({ cp: 0 }, { cp: -80 }, "w")).toBe(ANNOTATIONS.inaccuracy);
  });

  it("returns null for tiny swings under the inaccuracy threshold", () => {
    // 0 cp -> -25 cp = wc loss ≈ 0.046 -> below 0.10 cutoff.
    expect(classifyMove({ cp: 0 }, { cp: -25 }, "w")).toBeNull();
  });

  it("does NOT punish small swings in already-decided positions (the wc-based promise)", () => {
    // -600 cp -> -700 cp would have been an inaccuracy under the
    // old raw-cp system (100 cp loss). Under wc, the player was
    // already crushed; the swing barely registers. Lichess's whole
    // motivation for switching to wc was to stop calling these
    // mistakes.
    expect(classifyMove({ cp: -600 }, { cp: -700 }, "w")).toBeNull();
  });

  it("upgrades a near-zero-loss best move to 'best'", () => {
    const a = classifyMove({ cp: 0 }, { cp: -10 }, "w", { isBestMove: true });
    expect(a).toBe(ANNOTATIONS.best);
  });

  it("calls a clearly-improving best move 'brilliant'", () => {
    const a = classifyMove({ cp: 0 }, { cp: 50 }, "w", { isBestMove: true });
    expect(a).toBe(ANNOTATIONS.brilliant);
  });

  it("calls a notable positive swing 'great' even without isBestMove", () => {
    // 0 cp -> +200 cp = wc gain of ≈ 0.36 -> great.
    expect(classifyMove({ cp: 0 }, { cp: 200 }, "w")).toBe(ANNOTATIONS.great);
  });
});

describe("classifyMove - perspective flip for black", () => {
  it("a position dropping from +0 to -300 is a blunder for white but a great move for black", () => {
    expect(classifyMove({ cp: 0 }, { cp: -300 }, "w")).toBe(ANNOTATIONS.blunder);
    expect(classifyMove({ cp: 0 }, { cp: -300 }, "b")).toBe(ANNOTATIONS.great);
  });
});

describe("classifyMove - mate-to-mate transitions", () => {
  it("going from +mate to -mate is a blunder", () => {
    // White had mate-in-3, walked into mate-in-2 for the opponent.
    const a = classifyMove({ mate: 3 }, { mate: -2 }, "w");
    expect(a).toBe(ANNOTATIONS.blunder);
  });

  it("escaping from getting mated to mating is brilliant", () => {
    const a = classifyMove({ mate: -3 }, { mate: 2 }, "w");
    expect(a).toBe(ANNOTATIONS.brilliant);
  });

  it("missing a mate (had +mate, now equal) is a blunder", () => {
    const a = classifyMove({ mate: 3 }, { cp: 0 }, "w");
    expect(a).toBe(ANNOTATIONS.blunder);
  });
});
