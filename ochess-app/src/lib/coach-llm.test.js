import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted state shared between the supabase mock and the test bodies.
const { invokeMock, supabaseShape } = vi.hoisted(() => ({
  invokeMock: { fn: null },
  supabaseShape: { mode: "online" },
}));

vi.mock("./supabase", () => ({
  get supabase() {
    if (supabaseShape.mode === "offline") return null;
    return {
      functions: {
        invoke: (...args) => invokeMock.fn(...args),
      },
    };
  },
}));

beforeEach(() => {
  supabaseShape.mode = "online";
  invokeMock.fn = vi.fn();
});

import { generateAIDecks, isAIAvailable, callCoach, isCoachAvailable } from "./coach-llm";

describe("isAIAvailable / isCoachAvailable (legacy alias)", () => {
  it("returns true when the supabase client is configured", () => {
    expect(isAIAvailable()).toBe(true);
    expect(isCoachAvailable()).toBe(true); // legacy export still works
  });

  it("returns false when supabase is null (offline mode)", () => {
    supabaseShape.mode = "offline";
    expect(isAIAvailable()).toBe(false);
  });
});

describe("generateAIDecks - basic input handling", () => {
  it("returns a clean error when supabase is offline", async () => {
    supabaseShape.mode = "offline";
    const out = await generateAIDecks({ mistakes: [{ played_san: "Bg5" }] });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not configured/i);
  });

  it("returns a clean error when no mistakes are provided", async () => {
    const out = await generateAIDecks({ mistakes: [] });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/at least one mistake/i);
  });

  it("forwards a slimmed down mistake corpus to the function and returns its data", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({
      data: {
        ok: true,
        summary: "You drop pieces in the middlegame.",
        decks: [
          { name: "Hanging knights", query: "middlegame hanging_knight", summary: "You drop knights in the middlegame on f3/f6 outposts." },
        ],
        model: "llama-3.3-70b",
      },
      error: null,
    });

    const out = await generateAIDecks({
      mistakes: [
        { played_san: "Bg5", best_san: "Nxe5", eval_loss_cp: 200, phase: "middlegame", themes: ["mistake", "missed_capture"], opening: "Italian", source: "chesscom", ply: 12, game_id: "abc", fen: "should-be-stripped" },
      ],
      query: "middlegame",
    });

    expect(out.ok).toBe(true);
    expect(out.summary).toMatch(/middlegame/i);
    expect(out.decks).toHaveLength(1);
    expect(out.decks[0].name).toBe("Hanging knights");
    expect(out.decks[0].query).toBe("middlegame hanging_knight");
    expect(out.decks[0].summary).toMatch(/middlegame/i);
    // Confirm the FEN was NOT forwarded - privacy + token budget.
    const forwarded = invokeMock.fn.mock.calls[0][1].body.mistakes[0];
    expect(forwarded.fen).toBeUndefined();
    expect(forwarded.played_san).toBe("Bg5");
  });

  it("clamps the corpus to at most 30 mistakes per call", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({ data: { ok: true, decks: [] }, error: null });
    const mistakes = Array.from({ length: 100 }, (_, i) => ({
      played_san: `m${i}`,
      eval_loss_cp: 100 + i,
      phase: "middlegame",
    }));
    await generateAIDecks({ mistakes });
    const sentMistakes = invokeMock.fn.mock.calls[0][1].body.mistakes;
    expect(sentMistakes).toHaveLength(30);
  });

  it("forwards the user's free-text query to the function", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({ data: { ok: true, decks: [] }, error: null });
    await generateAIDecks({ mistakes: [{ played_san: "e4" }], query: "endgame fork" });
    expect(invokeMock.fn.mock.calls[0][1].body.query).toBe("endgame fork");
  });

  it("surfaces the function-level error when invoke returns an error", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "AI unavailable" },
    });
    const out = await generateAIDecks({ mistakes: [{ played_san: "e4" }] });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/AI unavailable/i);
  });

  it("preserves a structured error payload from the function body", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({
      data: { ok: false, error: "GROQ_API_KEY not configured" },
      error: null,
    });
    const out = await generateAIDecks({ mistakes: [{ played_san: "e4" }] });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/GROQ_API_KEY/);
  });
});

describe("generateAIDecks - response normalisation", () => {
  it("filters out malformed deck rows (missing name or query)", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({
      data: {
        ok: true,
        decks: [
          { name: "Good deck", query: "blunder middlegame", summary: "fine" },
          { name: "", query: "endgame" },          // missing name -> dropped
          { name: "No query", query: "", summary: "fine" }, // missing query -> dropped
          { name: "Both empty", query: "" },       // dropped
        ],
      },
      error: null,
    });
    const out = await generateAIDecks({ mistakes: [{ played_san: "e4" }] });
    expect(out.decks).toHaveLength(1);
    expect(out.decks[0].name).toBe("Good deck");
  });

  it("returns an empty decks array when the function returns no decks", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({
      data: { ok: true, summary: "Couldn't pick decks." },
      error: null,
    });
    const out = await generateAIDecks({ mistakes: [{ played_san: "e4" }] });
    expect(out.ok).toBe(true);
    expect(out.decks).toEqual([]);
  });

  it("trims wrapper whitespace from name + query + summary", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({
      data: {
        ok: true,
        decks: [{ name: "  Hanging queens  ", query: "  hanging_queen  ", summary: "  Drops queens.  " }],
      },
      error: null,
    });
    const out = await generateAIDecks({ mistakes: [{ played_san: "e4" }] });
    expect(out.decks[0].name).toBe("Hanging queens");
    expect(out.decks[0].query).toBe("hanging_queen");
    expect(out.decks[0].summary).toBe("Drops queens.");
  });
});

describe("generateAIDecks - server-side rate limit", () => {
  it("flags rate-limit responses with retryAfterSeconds + usage counters", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({
      data: {
        ok: false,
        error: "You're generating decks a lot. Try again in 42s.",
        retry_after_seconds: 42,
        calls_in_window: 3,
        max_calls: 3,
        window_seconds: 300,
      },
      error: { context: { status: 429 }, message: "rate limited" },
    });
    const out = await generateAIDecks({ mistakes: [{ played_san: "e4" }] });
    expect(out.ok).toBe(false);
    expect(out.rateLimited).toBe(true);
    expect(out.retryAfterSeconds).toBe(42);
    expect(out.maxCalls).toBe(3);
  });

  it("surfaces rate_limit usage on a successful response", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({
      data: {
        ok: true,
        summary: "...",
        decks: [],
        model: "llama-3.3-70b",
        rate_limit: { calls_in_window: 2, max_calls: 3, window_seconds: 300 },
      },
      error: null,
    });
    const out = await generateAIDecks({ mistakes: [{ played_san: "e4" }] });
    expect(out.ok).toBe(true);
    expect(out.rateLimit).toEqual({ callsInWindow: 2, maxCalls: 3, windowSeconds: 300 });
  });
});

describe("legacy callCoach alias", () => {
  it("is the same function as generateAIDecks (backward compat)", () => {
    expect(callCoach).toBe(generateAIDecks);
  });
});
