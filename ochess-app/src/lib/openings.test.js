import { describe, it, expect, vi, beforeEach } from "vitest";

const FAKE_DB = {
  "e2e4": "King's Pawn Opening",
  "e2e4,e7e5": "Open Game",
  "e2e4,e7e5,g1f3": "King's Knight Opening",
  "e2e4,e7e5,g1f3,b8c6": "King's Knight: Normal Variation",
  "e2e4,e7e5,g1f3,b8c6,f1b5": "Ruy Lopez",
};

beforeEach(() => {
  vi.resetModules();
  globalThis.fetch = vi.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(FAKE_DB),
  }));
});

describe("openings.getOpeningName", () => {
  it("returns null for an empty history", async () => {
    const { getOpeningName } = await import("./openings");
    expect(await getOpeningName([])).toBeNull();
  });

  it("returns the exact match when the full move list is in the book", async () => {
    const { getOpeningName } = await import("./openings");
    const history = [
      { from: "e2", to: "e4" },
      { from: "e7", to: "e5" },
      { from: "g1", to: "f3" },
    ];
    expect(await getOpeningName(history)).toBe("King's Knight Opening");
  });

  it("falls back to the longest known prefix when the full line is unknown", async () => {
    const { getOpeningName } = await import("./openings");
    const history = [
      { from: "e2", to: "e4" },
      { from: "e7", to: "e5" },
      { from: "g1", to: "f3" },
      { from: "b8", to: "c6" },
      { from: "f1", to: "b5" },
      { from: "a7", to: "a6" }, // Morphy defense - unknown to our fake db
    ];
    expect(await getOpeningName(history)).toBe("Ruy Lopez");
  });

  it("remembers the lastKnown name across calls until reset", async () => {
    const { getOpeningName, resetOpeningCache } = await import("./openings");
    // First, walk into Ruy Lopez
    await getOpeningName([
      { from: "e2", to: "e4" }, { from: "e7", to: "e5" },
      { from: "g1", to: "f3" }, { from: "b8", to: "c6" }, { from: "f1", to: "b5" },
    ]);
    // Now an unknown line - getOpeningName should fall back to lastKnown.
    const out = await getOpeningName([
      { from: "h2", to: "h4" }, // unknown from move 1
    ]);
    expect(out).toBe("Ruy Lopez");
    resetOpeningCache();
  });

  it("handles a UCI move with promotion in the key", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ "a7a8q": "Promotion line" }),
    }));
    vi.resetModules();
    const { getOpeningName } = await import("./openings");
    const out = await getOpeningName([{ from: "a7", to: "a8", promotion: "q" }]);
    expect(out).toBe("Promotion line");
  });
});

describe("openings.isBookMove", () => {
  it("returns true when the prefix-of-length-n is a key", async () => {
    const { isBookMove } = await import("./openings");
    const history = [
      { from: "e2", to: "e4" },
      { from: "e7", to: "e5" },
    ];
    expect(await isBookMove(history, 2)).toBe(true);
  });

  it("returns false beyond the book", async () => {
    const { isBookMove } = await import("./openings");
    const history = [
      { from: "e2", to: "e4" },
      { from: "e7", to: "e5" },
      { from: "h2", to: "h4" }, // unknown
    ];
    expect(await isBookMove(history, 3)).toBe(false);
  });

  it("returns false for plyUpTo <= 0", async () => {
    const { isBookMove } = await import("./openings");
    expect(await isBookMove([{ from: "e2", to: "e4" }], 0)).toBe(false);
  });
});
