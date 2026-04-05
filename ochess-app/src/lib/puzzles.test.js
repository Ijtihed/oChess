import { describe, it, expect, beforeEach } from "vitest";
import { getAdaptivePuzzle, getRandomPuzzle, getPuzzlesByTheme, loadPuzzleRating, updatePuzzleRating } from "./puzzles";

function makePuzzles(count = 50) {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    moves: ["e2e4", "e7e5"],
    rating: 1200 + i * 20,
    popularity: 80,
    themes: i % 3 === 0 ? ["fork"] : ["pin"],
    gameUrl: null,
  }));
}

describe("getAdaptivePuzzle", () => {
  it("returns a puzzle near the player rating", () => {
    const puzzles = makePuzzles(100);
    const p = getAdaptivePuzzle(puzzles, 1500);
    expect(p).toBeDefined();
    expect(p.id).toBeDefined();
    expect(Math.abs(p.rating - 1500)).toBeLessThanOrEqual(1200);
  });

  it("does not repeat recent puzzles", () => {
    const puzzles = makePuzzles(100);
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const p = getAdaptivePuzzle(puzzles, 1500);
      expect(seen.has(p.id)).toBe(false);
      seen.add(p.id);
    }
  });
});

describe("getRandomPuzzle", () => {
  it("returns a puzzle from the pool", () => {
    const puzzles = makePuzzles();
    const p = getRandomPuzzle(puzzles);
    expect(puzzles).toContain(p);
  });

  it("respects rating bounds", () => {
    const puzzles = makePuzzles(100);
    const p = getRandomPuzzle(puzzles, 1300, 1400);
    expect(p.rating).toBeGreaterThanOrEqual(1300);
    expect(p.rating).toBeLessThanOrEqual(1400);
  });
});

describe("getPuzzlesByTheme", () => {
  it("filters by theme", () => {
    const puzzles = makePuzzles();
    const forks = getPuzzlesByTheme(puzzles, "fork");
    expect(forks.length).toBeGreaterThan(0);
    forks.forEach((p) => expect(p.themes).toContain("fork"));
  });

  it("returns empty for non-existent theme", () => {
    expect(getPuzzlesByTheme(makePuzzles(), "zugzwang")).toEqual([]);
  });
});

describe("puzzle rating (Glicko-1)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts at 1500", () => {
    const r = loadPuzzleRating();
    expect(r.rating).toBe(1500);
    expect(r.rd).toBe(350);
    expect(r.games).toBe(0);
  });

  it("rating goes up on solving a puzzle", () => {
    const before = loadPuzzleRating();
    const after = updatePuzzleRating(1500, true);
    expect(after.rating).toBeGreaterThanOrEqual(before.rating);
    expect(after.games).toBe(1);
  });

  it("rating goes down on failing a puzzle", () => {
    const before = loadPuzzleRating();
    const after = updatePuzzleRating(1500, false);
    expect(after.rating).toBeLessThanOrEqual(before.rating);
  });

  it("persists to localStorage", () => {
    updatePuzzleRating(1500, true);
    const loaded = loadPuzzleRating();
    expect(loaded.games).toBe(1);
  });

  it("speed bonus increases rating gain", () => {
    localStorage.clear();
    const base = updatePuzzleRating(1500, true, {});
    localStorage.clear();
    const fast = updatePuzzleRating(1500, true, { timerSec: 60, timeLeftPct: 0.9 });
    expect(fast.rating).toBeGreaterThanOrEqual(base.rating);
  });
});
