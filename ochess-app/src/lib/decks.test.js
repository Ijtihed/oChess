import { describe, it, expect } from "vitest";
import { listDecks, getDeckById, deckQueryForInsight } from "./decks";

describe("listDecks - empty / no input", () => {
  it("returns an empty array when there are no cards", () => {
    expect(listDecks([], [], {})).toEqual([]);
  });

  it("tolerates non-array inputs without throwing", () => {
    expect(listDecks(null, null, null)).toEqual([]);
    expect(listDecks(undefined, undefined, undefined)).toEqual([]);
  });
});

describe("listDecks - built-in type decks", () => {
  it("creates a Puzzles deck when there's at least one puzzle card", () => {
    const decks = listDecks(
      [
        { id: "p1", type: "puzzle", fen: "8/8/8/8/8/8/8/8 w - - 0 1" },
      ],
      [],
      {}
    );
    const puzzles = decks.find((d) => d.id === "builtin:puzzles");
    expect(puzzles).toBeDefined();
    expect(puzzles.kind).toBe("builtin");
    expect(puzzles.counts.total).toBe(1);
  });

  it("hides built-in decks for types that have zero cards", () => {
    const decks = listDecks(
      [{ id: "p1", type: "puzzle", fen: "x" }],
      [],
      {}
    );
    expect(decks.find((d) => d.id === "builtin:analysis")).toBeUndefined();
    expect(decks.find((d) => d.id === "builtin:shared")).toBeUndefined();
  });

  it("groups game + mistake cards into the same Game-mistakes deck", () => {
    const decks = listDecks(
      [
        { id: "g1", type: "game", fen: "x" },
        { id: "m1", type: "mistake", fen: "y" },
      ],
      [],
      {}
    );
    const gm = decks.find((d) => d.id === "builtin:mistakes");
    expect(gm).toBeDefined();
    expect(gm.counts.total).toBe(2);
  });

  it("always emits an 'All cards' deck last when the collection has any cards", () => {
    const decks = listDecks(
      [{ id: "p", type: "puzzle", fen: "x" }],
      [],
      {}
    );
    expect(decks[decks.length - 1].id).toBe("builtin:all");
  });
});

describe("listDecks - user drill sets", () => {
  it("emits one deck per saved drill set", () => {
    const cards = [
      { id: "m1", type: "mistake", fen: "x", themes: ["hanging_queen"] },
    ];
    const drills = [
      { id: "d1", name: "Hanging queens", query: "hanging_queen", chipId: null },
      { id: "d2", name: "All blunders", query: "blunder", chipId: null },
    ];
    const decks = listDecks(cards, drills, {});
    expect(decks.find((d) => d.id === "drill:d1")).toBeDefined();
    expect(decks.find((d) => d.id === "drill:d2")).toBeDefined();
    // Drill sets keep their saved name as the deck name.
    expect(decks.find((d) => d.id === "drill:d1").name).toBe("Hanging queens");
  });

  it("flags AI-coach drill sets with isAICoach=true", () => {
    const decks = listDecks(
      [{ id: "m1", type: "mistake", fen: "x", themes: ["blunder"] }],
      [{ id: "d1", name: "Day 1", query: "blunder", chipId: null, source: "coach" }],
      {}
    );
    const aiDeck = decks.find((d) => d.id === "drill:d1");
    expect(aiDeck.isAICoach).toBe(true);
  });

  it("does NOT flag manually-saved drill sets as AI", () => {
    const decks = listDecks(
      [{ id: "m1", type: "mistake", fen: "x", themes: ["blunder"] }],
      [{ id: "d1", name: "My drill", query: "blunder", chipId: null, source: "manual" }],
      {}
    );
    const deck = decks.find((d) => d.id === "drill:d1");
    expect(deck.isAICoach).toBe(false);
  });
});

describe("listDecks - per-deck counts", () => {
  it("counts only the cards a deck's predicate matches", () => {
    const cards = [
      { id: "p1", type: "puzzle", fen: "x" },
      { id: "p2", type: "puzzle", fen: "y" },
      { id: "m1", type: "mistake", fen: "z" },
    ];
    const decks = listDecks(cards, [], {});
    expect(decks.find((d) => d.id === "builtin:puzzles").counts.total).toBe(2);
    expect(decks.find((d) => d.id === "builtin:mistakes").counts.total).toBe(1);
    expect(decks.find((d) => d.id === "builtin:all").counts.total).toBe(3);
  });

  it("counts due / new / learning / review state per deck", () => {
    const cards = [
      { id: "p1", type: "puzzle", fen: "x" },
      { id: "p2", type: "puzzle", fen: "y" },
    ];
    const future = new Date(Date.now() + 86400_000).toISOString();
    const schedules = {
      p1: { state: "review", intervalDays: 3, dueAt: future }, // not due
      // p2 has no schedule -> NEW + due
    };
    const decks = listDecks(cards, [], schedules);
    const puzzles = decks.find((d) => d.id === "builtin:puzzles");
    expect(puzzles.counts.total).toBe(2);
    expect(puzzles.counts.due).toBe(1);
    expect(puzzles.counts.new).toBe(1);
    expect(puzzles.counts.review).toBe(1);
  });
});

describe("getDeckById", () => {
  it("returns the deck with the matching id", () => {
    const decks = listDecks(
      [{ id: "p", type: "puzzle", fen: "x" }],
      [],
      {}
    );
    const found = getDeckById(decks, "builtin:puzzles");
    expect(found).toBeDefined();
    expect(found.name).toBe("Puzzles");
  });

  it("returns null for an unknown id", () => {
    expect(getDeckById([], "missing")).toBeNull();
    expect(getDeckById(null, "x")).toBeNull();
  });
});

describe("deckQueryForInsight", () => {
  it("builds a phase + theme + played_san filter from a single mistake card", () => {
    const out = deckQueryForInsight({
      phase: "endgame",
      themes: ["hanging_queen"],
      played_san: "Qa1",
    });
    expect(out).toContain("endgame");
    expect(out).toContain("hanging_queen");
    expect(out).toContain("Qa1");
  });

  it("returns empty for an empty card", () => {
    expect(deckQueryForInsight(null)).toBe("");
    expect(deckQueryForInsight({})).toBe("");
  });
});
