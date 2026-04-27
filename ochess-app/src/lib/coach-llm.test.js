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

  // ── Server-side rate-limit handling ──
  // The Edge Function returns 429 with a structured body when the
  // user has spent their quota. The client wrapper detects this and
  // surfaces all the fields the UI countdown needs.

  it("flags rate-limit responses with retryAfterSeconds + usage counters", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({
      data: {
        ok: false,
        error: "You're using the AI coach a lot. Try again in 42s.",
        retry_after_seconds: 42,
        calls_in_window: 3,
        max_calls: 3,
        window_seconds: 300,
      },
      error: { context: { status: 429 }, message: "rate limited" },
    });
    const out = await callCoach({ mistakes: [{ played_san: "e4" }] });
    expect(out.ok).toBe(false);
    expect(out.rateLimited).toBe(true);
    expect(out.retryAfterSeconds).toBe(42);
    expect(out.callsInWindow).toBe(3);
    expect(out.maxCalls).toBe(3);
    expect(out.windowSeconds).toBe(300);
    expect(out.error).toMatch(/Try again in 42s/);
  });

  it("propagates rate-limit fields even when supabase-js wraps the error differently", async () => {
    // Some supabase-js versions surface 429s as a successful invoke
    // with the structured 4xx body in `data`. Make sure we still
    // detect it.
    invokeMock.fn = vi.fn().mockResolvedValue({
      data: {
        ok: false,
        error: "Try again in 7s.",
        retry_after_seconds: 7,
        calls_in_window: 3,
        max_calls: 3,
        window_seconds: 300,
      },
      error: null,
    });
    const out = await callCoach({ mistakes: [{ played_san: "e4" }] });
    expect(out.rateLimited).toBe(true);
    expect(out.retryAfterSeconds).toBe(7);
  });

  it("surfaces rate_limit usage on a successful response", async () => {
    invokeMock.fn = vi.fn().mockResolvedValue({
      data: {
        ok: true,
        summary: "...",
        plan: [],
        insights: [],
        model: "llama-3.3-70b",
        rate_limit: { calls_in_window: 2, max_calls: 3, window_seconds: 300 },
      },
      error: null,
    });
    const out = await callCoach({ mistakes: [{ played_san: "e4" }] });
    expect(out.ok).toBe(true);
    expect(out.rateLimit).toEqual({ callsInWindow: 2, maxCalls: 3, windowSeconds: 300 });
  });
});
