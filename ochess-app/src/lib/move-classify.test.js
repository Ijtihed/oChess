import { describe, it, expect } from "vitest";
import { classifyMove, ANNOTATIONS } from "./move-classify";

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

describe("classifyMove - centipawn loss thresholds (white to move)", () => {
  it("classifies a 300+ cp loss as a blunder", () => {
    expect(classifyMove({ cp: 100 }, { cp: -250 }, "w")).toBe(ANNOTATIONS.blunder);
    // Boundary: exactly 300 still fires
    expect(classifyMove({ cp: 0 }, { cp: -300 }, "w")).toBe(ANNOTATIONS.blunder);
  });

  it("classifies a 100-299 cp loss as a mistake", () => {
    expect(classifyMove({ cp: 0 }, { cp: -100 }, "w")).toBe(ANNOTATIONS.mistake);
    expect(classifyMove({ cp: 0 }, { cp: -250 }, "w")).toBe(ANNOTATIONS.mistake);
  });

  it("classifies a 50-99 cp loss as an inaccuracy", () => {
    expect(classifyMove({ cp: 0 }, { cp: -50 }, "w")).toBe(ANNOTATIONS.inaccuracy);
    expect(classifyMove({ cp: 0 }, { cp: -90 }, "w")).toBe(ANNOTATIONS.inaccuracy);
  });

  it("returns null for moves under 50 cp loss with no best-move flag", () => {
    expect(classifyMove({ cp: 0 }, { cp: -25 }, "w")).toBeNull();
  });

  it("upgrades a near-zero-loss move to 'best' when isBestMove is true", () => {
    const a = classifyMove({ cp: 0 }, { cp: -10 }, "w", { isBestMove: true });
    expect(a).toBe(ANNOTATIONS.best);
  });

  it("treats a non-losing best move as 'brilliant' (loss <= 0)", () => {
    const a = classifyMove({ cp: 0 }, { cp: 50 }, "w", { isBestMove: true });
    expect(a).toBe(ANNOTATIONS.brilliant);
  });

  it("treats a large gain (loss <= -50) as 'great'", () => {
    expect(classifyMove({ cp: 0 }, { cp: 100 }, "w")).toBe(ANNOTATIONS.great);
    expect(classifyMove({ cp: 0 }, { cp: 200 }, "w")).toBe(ANNOTATIONS.great);
  });
});

describe("classifyMove - perspective flip for black", () => {
  it("a position dropping from +0 to -300 (in white units) is a blunder for white but a great move for black", () => {
    // Same numeric eval drop, different moving color -> sign flips loss.
    expect(classifyMove({ cp: 0 }, { cp: -300 }, "w")).toBe(ANNOTATIONS.blunder);
    expect(classifyMove({ cp: 0 }, { cp: -300 }, "b")).toBe(ANNOTATIONS.great);
  });
});

describe("classifyMove - mate-to-mate transitions", () => {
  it("going from +mate to -mate is a blunder", () => {
    // Mate-in-3 for white -> mate-in-2 for black
    const a = classifyMove({ mate: 3 }, { mate: -2 }, "w");
    expect(a).toBe(ANNOTATIONS.blunder);
  });

  it("escaping from getting mated to mating is brilliant", () => {
    const a = classifyMove({ mate: -3 }, { mate: 2 }, "w");
    expect(a).toBe(ANNOTATIONS.brilliant);
  });

  it("delaying your own mate by more than 3 is an inaccuracy", () => {
    // White had mate-in-3 (+3), now white has mate-in-7 (+7) -> delayed by 4
    const a = classifyMove({ mate: 3 }, { mate: 7 }, "w");
    expect(a).toBe(ANNOTATIONS.inaccuracy);
  });

  it("staying mated but pushing the mate further out is an inaccuracy when shrunk by 3+", () => {
    // White was getting mated in 8, now mated in 4 -> shrank by 4
    const a = classifyMove({ mate: -8 }, { mate: -4 }, "w");
    expect(a).toBe(ANNOTATIONS.inaccuracy);
  });
});
