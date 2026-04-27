import { describe, it, expect, beforeEach } from "vitest";
import {
  loadDrillSets,
  saveDrillSets,
  addDrillSet,
  removeDrillSet,
  countDrillSetCards,
} from "./drill-sets";
import { COMMON_WEAKNESS_CHIPS, filterCardsByQuery } from "./study-plan";

beforeEach(() => {
  localStorage.clear();
});

describe("loadDrillSets / saveDrillSets", () => {
  it("returns an empty array when nothing's been saved", () => {
    expect(loadDrillSets()).toEqual([]);
  });

  it("round-trips a saved collection", () => {
    saveDrillSets([
      { id: "x", name: "n", query: "q", chipId: null, createdAt: 1, updatedAt: 1 },
    ]);
    const out = loadDrillSets();
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("x");
  });

  it("ignores non-array storage", () => {
    localStorage.setItem("ochess_drill_sets", JSON.stringify({ not: "array" }));
    expect(loadDrillSets()).toEqual([]);
  });

  it("drops malformed entries (missing id, missing query/chip, junk)", () => {
    localStorage.setItem(
      "ochess_drill_sets",
      JSON.stringify([
        null,
        "string",
        { name: "no id" },
        { id: "empty-filter", query: "", chipId: null }, // both empty - dropped
        { id: "valid-1", query: "fork", createdAt: 1, updatedAt: 1 },
        { id: "valid-2", chipId: "blunders" },
      ])
    );
    const out = loadDrillSets();
    expect(out.map((s) => s.id)).toEqual(["valid-1", "valid-2"]);
  });

  it("recovers from corrupted JSON without throwing", () => {
    localStorage.setItem("ochess_drill_sets", "{not json");
    expect(loadDrillSets()).toEqual([]);
  });
});

describe("addDrillSet", () => {
  it("creates a new set with a generated id when none is given", () => {
    const { sets, id } = addDrillSet([], { name: "n", query: "fork" });
    expect(sets).toHaveLength(1);
    expect(id).toMatch(/^drill-/);
    expect(sets[0].name).toBe("n");
    expect(sets[0].query).toBe("fork");
    expect(sets[0].createdAt).toBeGreaterThan(0);
    expect(sets[0].updatedAt).toBeGreaterThan(0);
  });

  it("auto-names with the query/chip when name is empty", () => {
    const { sets } = addDrillSet([], { name: "", query: "hanging queen" });
    expect(sets[0].name).toContain("hanging queen");

    const { sets: s2 } = addDrillSet([], { name: "  ", chipId: "blunders" });
    expect(s2[0].name).toContain("blunders");

    const { sets: s3 } = addDrillSet([], { query: "x" });
    expect(s3[0].name).toContain("x");
  });

  it("rejects a set with neither query nor chipId", () => {
    const { sets, id } = addDrillSet([{ id: "existing" }], { name: "empty" });
    expect(id).toBeNull();
    // Existing collection is returned untouched.
    expect(sets).toHaveLength(1);
    expect(sets[0].id).toBe("existing");
  });

  it("updates an existing set when the same id is provided", () => {
    const initial = addDrillSet([], { name: "v1", query: "fork" });
    const { sets, id } = addDrillSet(initial.sets, {
      id: initial.id,
      name: "v2",
      query: "endgame fork",
    });
    expect(id).toBe(initial.id);
    expect(sets).toHaveLength(1);
    expect(sets[0].name).toBe("v2");
    expect(sets[0].query).toBe("endgame fork");
    // updatedAt is bumped, createdAt is preserved.
    expect(sets[0].updatedAt).toBeGreaterThanOrEqual(sets[0].createdAt);
  });

  it("trims long names to 60 chars", () => {
    const long = "x".repeat(200);
    const { sets } = addDrillSet([], { name: long, query: "q" });
    expect(sets[0].name.length).toBeLessThanOrEqual(60);
  });
});

describe("removeDrillSet", () => {
  it("removes the set with the matching id", () => {
    const initial = [
      { id: "a", name: "A", query: "x" },
      { id: "b", name: "B", query: "y" },
    ];
    expect(removeDrillSet(initial, "a").map((s) => s.id)).toEqual(["b"]);
  });

  it("is a no-op when id doesn't match", () => {
    const initial = [{ id: "a" }];
    expect(removeDrillSet(initial, "missing")).toEqual(initial);
  });
});

describe("countDrillSetCards", () => {
  const chipFor = (id) => COMMON_WEAKNESS_CHIPS.find((c) => c.id === id);
  const queryFilter = filterCardsByQuery;
  const cards = [
    { type: "mistake", phase: "endgame",    themes: ["hanging_queen", "blunder"], played_san: "Qa1", eval_loss_cp: 500 },
    { type: "mistake", phase: "middlegame", themes: ["mistake"], played_san: "Nb5", eval_loss_cp: 150 },
    { type: "puzzle",  phase: "endgame",    themes: ["fork"], played_san: "Bc4", eval_loss_cp: 0 },
    { type: "analysis", phase: "endgame",   themes: [] }, // ignored - not mistake/puzzle
  ];

  it("counts only mistake/puzzle cards", () => {
    const set = { query: "endgame", chipId: null };
    expect(countDrillSetCards(set, cards, { chipFor, queryFilter })).toBe(2);
  });

  it("respects a chip filter", () => {
    const set = { query: "", chipId: "hanging_q" };
    expect(countDrillSetCards(set, cards, { chipFor, queryFilter })).toBe(1);
  });

  it("intersects chip + query when both are set", () => {
    // chip "endgame" matches phase==="endgame"; query "fork" only
    // hits the puzzle. Both must hit.
    const set = { query: "fork", chipId: "endgame" };
    expect(countDrillSetCards(set, cards, { chipFor, queryFilter })).toBe(1);
  });

  it("returns 0 when nothing matches", () => {
    const set = { query: "nonexistent", chipId: null };
    expect(countDrillSetCards(set, cards, { chipFor, queryFilter })).toBe(0);
  });
});
