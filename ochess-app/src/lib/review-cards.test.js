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
  serializeCardForShare,
  deserializeSharedCard,
  buildShareUrl,
  addCardIfNew,
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

  // Regression: a corrupted entry (null, missing fen, or a primitive)
  // used to crash the .map() in loadCards because it spread through
  // `{ ...c, ts: c.ts || i }` - reading `.ts` on null throws. The
  // recovery path keeps the rest of the deck intact.
  it("drops malformed entries (null / non-object / missing fen) without crashing", () => {
    localStorage.setItem(
      "ochess_review_cards",
      JSON.stringify([
        null,
        "not-an-object",
        { fen: "ok-1", type: "puzzle" },
        { type: "puzzle" }, // missing fen
        { fen: "ok-2", type: "analysis" },
      ])
    );
    const out = loadCards();
    expect(out.map((c) => c.fen)).toEqual(["ok-1", "ok-2"]);
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

  // Regression: a schedule with a corrupted/missing dueAt used to
  // make isCardDue return false (because new Date(undefined) >=
  // anything is false). The card would silently fall out of the
  // queue and the user could never review it again.
  it("treats a schedule with missing/corrupted dueAt as due", () => {
    expect(isCardDue({ x: {} }, "x")).toBe(true);
    expect(isCardDue({ x: { dueAt: null } }, "x")).toBe(true);
    expect(isCardDue({ x: { dueAt: "not a date" } }, "x")).toBe(true);
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

describe("serializeCardForShare / deserializeSharedCard", () => {
  it("round-trips a typical mistake card through a URL-safe payload", () => {
    const card = {
      fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
      type: "mistake",
      played_san: "Bg5",
      best_san: "Nxe5",
      eval_loss_cp: 250,
      themes: ["mistake", "missed_capture"],
      phase: "middlegame",
      opening: "Italian Game",
    };
    const payload = serializeCardForShare(card);
    expect(typeof payload).toBe("string");
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe alphabet
    const decoded = deserializeSharedCard(payload);
    expect(decoded).not.toBeNull();
    expect(decoded.fen).toBe(card.fen);
    expect(decoded.played_san).toBe("Bg5");
    expect(decoded.best_san).toBe("Nxe5");
    expect(decoded.themes).toEqual(["mistake", "missed_capture"]);
    expect(decoded.opening).toBe("Italian Game");
    // The recipient's copy should have its own fresh id + ts.
    expect(decoded.id).toMatch(/^shared-/);
    expect(typeof decoded.ts).toBe("number");
  });

  it("returns null on missing FEN (the only required field)", () => {
    expect(serializeCardForShare({ type: "puzzle" })).toBeNull();
    expect(serializeCardForShare(null)).toBeNull();
  });

  it("returns null on a malformed payload string", () => {
    expect(deserializeSharedCard(null)).toBeNull();
    expect(deserializeSharedCard("")).toBeNull();
    expect(deserializeSharedCard("not-base64")).toBeNull();
    expect(deserializeSharedCard("eyJ4Ijoxfff")).toBeNull(); // bad b64
  });

  it("rejects payloads without the v=1 schema marker", () => {
    const noMarker = btoa(JSON.stringify({ fen: "x" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(deserializeSharedCard(noMarker)).toBeNull();
  });
});

describe("buildShareUrl", () => {
  it("appends the encoded card to /review?import= against the given origin", () => {
    const url = buildShareUrl({ fen: "x", type: "shared" }, "https://example.com");
    expect(url).toMatch(/^https:\/\/example\.com\/review\?import=[A-Za-z0-9_-]+$/);
  });

  it("returns null on a card with no FEN", () => {
    expect(buildShareUrl({ type: "shared" }, "https://example.com")).toBeNull();
  });
});

describe("addCardIfNew", () => {
  it("appends a card when no signature collision exists", () => {
    const out = addCardIfNew([], { fen: "f1", type: "shared" });
    expect(out).toHaveLength(1);
  });

  it("dedupes cards with the same fen + type + played_san + best_san", () => {
    const existing = [{ fen: "f1", type: "shared", played_san: "Bg5", best_san: "Nxe5" }];
    const out = addCardIfNew(existing, { fen: "f1", type: "shared", played_san: "Bg5", best_san: "Nxe5" });
    expect(out).toBe(existing); // unchanged reference
    expect(out).toHaveLength(1);
  });

  it("treats a different played_san as a new card", () => {
    const existing = [{ fen: "f1", type: "shared", played_san: "Bg5" }];
    const out = addCardIfNew(existing, { fen: "f1", type: "shared", played_san: "Nf3" });
    expect(out).toHaveLength(2);
  });
});
