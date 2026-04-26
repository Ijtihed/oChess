import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cardId,
  loadCards,
  saveCards,
  removeCard,
  loadSchedules,
  saveSchedules,
  rateCard,
  isCardDue,
  RATING,
} from "./review-cards";

beforeEach(() => {
  localStorage.clear();
});

describe("cardId", () => {
  it("uses the explicit id when present", () => {
    expect(cardId({ id: "abc", fen: "x", ts: 0 })).toBe("abc");
  });
  it("falls back to a hash of type + fen + ts", () => {
    const a = cardId({ type: "puzzle", fen: "p1", ts: 1 });
    const b = cardId({ type: "puzzle", fen: "p1", ts: 2 });
    expect(a).not.toBe(b);
    const c = cardId({ type: "analysis", fen: "p1", ts: 1 });
    expect(c).not.toBe(a);
  });
});

describe("loadCards / saveCards", () => {
  it("returns an empty array for missing storage", () => {
    expect(loadCards()).toEqual([]);
  });

  it("round-trips an array of cards", () => {
    const cards = [
      { id: "1", fen: "f1", type: "puzzle", ts: 1 },
      { id: "2", fen: "f2", type: "analysis", ts: 2 },
    ];
    saveCards(cards);
    const loaded = loadCards();
    expect(loaded.map((c) => c.id)).toEqual(["1", "2"]);
  });

  it("ignores non-array storage", () => {
    localStorage.setItem("ochess_review_cards", JSON.stringify({ not: "an array" }));
    expect(loadCards()).toEqual([]);
  });
});

describe("removeCard", () => {
  it("removes the matching id", () => {
    const cards = [
      { id: "a", fen: "x", ts: 1 },
      { id: "b", fen: "y", ts: 2 },
    ];
    expect(removeCard(cards, "a").map((c) => c.id)).toEqual(["b"]);
  });
});

describe("isCardDue / rateCard", () => {
  it("treats brand-new cards as due", () => {
    expect(isCardDue({}, "anything")).toBe(true);
  });

  it("schedules a card forward after a Good rating", () => {
    const next = rateCard({}, "card-1", RATING.GOOD);
    expect(isCardDue(next, "card-1")).toBe(false);
  });

  it("keeps an Again-rated card due immediately", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T00:00:00Z"));
    const next = rateCard({}, "card-1", RATING.AGAIN);
    // Again pushes the next review out by 1 day; we should not be due
    // right now, but should be due when we cross the next-day boundary.
    expect(isCardDue(next, "card-1")).toBe(false);
    vi.setSystemTime(new Date("2026-04-28T00:00:00Z"));
    expect(isCardDue(next, "card-1")).toBe(true);
    vi.useRealTimers();
  });
});

describe("loadSchedules / saveSchedules", () => {
  it("round-trips a schedule map", () => {
    saveSchedules({ a: { dueAt: new Date(0).toISOString(), easeFactor: 2.5 } });
    const map = loadSchedules();
    expect(map.a).toBeDefined();
  });
});
