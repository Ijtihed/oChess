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

import { callCoach, isCoachAvailable } from "./coach-llm";

describe("isCoachAvailable", () => {
  it("returns true when the supabase client is configured", () => {
    expect(isCoachAvailable()).toBe(true);
  });

  it("returns false when supabase is null (offline mode)", () => {
    supabaseShape.mode = "offline";
    expect(isCoachAvailable()).toBe(false);
  });
});

describe("callCoach", () => {
  it("returns a clean error when supabase is offline", async () => {
    supabaseShape.mode = "offline";
    const out = await callCoach({ mistakes: [{ played_san: "Bg5" }] });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not configured/i);
  });

  it("returns a clean error when no mistakes are provided", async () => {
    const out = await callCoach({ mistakes: [] });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/at least 1 mistake/i);
  });

  it("forwards a slimmed down mistake corpus to the function and returns its data", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({
      data: {
        ok: true,
        summary: "You drop pieces in the middlegame.",
        plan: [{ day: 1, focus: "hanging pieces", explanation: "...", card_count: 5 }],
        insights: [{ insight: "Bg5 walks into a fork." }],
        model: "llama-3.3-70b",
      },
      error: null,
    });

    const out = await callCoach({
      mistakes: [
        { played_san: "Bg5", best_san: "Nxe5", eval_loss_cp: 200, phase: "middlegame", themes: ["mistake", "missed_capture"], opening: "Italian", source: "chesscom", ply: 12, game_id: "abc", fen: "should-be-stripped" },
      ],
      query: "middlegame",
      dailyQuota: 5,
    });

    expect(out.ok).toBe(true);
    expect(out.summary).toMatch(/middlegame/i);
    // Confirm the FEN was NOT forwarded - privacy + token budget.
    const forwarded = invokeMock.fn.mock.calls[0][1].body.mistakes[0];
    expect(forwarded.fen).toBeUndefined();
    expect(forwarded.played_san).toBe("Bg5");
  });

  it("clamps the corpus to at most 30 mistakes per call", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    const mistakes = Array.from({ length: 100 }, (_, i) => ({
      played_san: `m${i}`,
      eval_loss_cp: 100 + i,
      phase: "middlegame",
    }));
    await callCoach({ mistakes });
    const sentMistakes = invokeMock.fn.mock.calls[0][1].body.mistakes;
    expect(sentMistakes).toHaveLength(30);
  });

  it("surfaces the function-level error when invoke returns an error", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "Coach unavailable" },
    });
    const out = await callCoach({ mistakes: [{ played_san: "e4" }] });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/coach unavailable/i);
  });

  it("preserves a structured error payload from the function body", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({
      data: { ok: false, error: "GROQ_API_KEY not configured" },
      error: null,
    });
    const out = await callCoach({ mistakes: [{ played_san: "e4" }] });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/GROQ_API_KEY/);
  });
});
