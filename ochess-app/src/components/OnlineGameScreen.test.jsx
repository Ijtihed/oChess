import { describe, it, expect } from "vitest";
import { computeGameOver, normalizeChat } from "./OnlineGameScreen";

describe("normalizeChat", () => {
  const me = "user-me";
  const opp = "user-opp";

  it("preserves messages stored with explicit user ids", () => {
    expect(normalizeChat({ from: me, text: "hi" }, opp, me).fromId).toBe(me);
    expect(normalizeChat({ from: opp, text: "hi" }, opp, me).fromId).toBe(opp);
  });

  it("rehydrates legacy 'opp' senders to the actual opponent id", () => {
    // Older rows persisted opponent messages as { from: "opp" }.
    // Hard-refreshing should still attribute them to the opponent.
    const out = normalizeChat({ from: "opp", text: "hi" }, opp, me);
    expect(out.fromId).toBe(opp);
  });

  it("rehydrates legacy 'you' senders to my id", () => {
    const out = normalizeChat({ from: "you", text: "hi" }, opp, me);
    expect(out.fromId).toBe(me);
  });

  it("falls back to a sensible name when one isn't stored", () => {
    expect(normalizeChat({ from: me, text: "hi" }, opp, me).name).toBe("You");
    expect(normalizeChat({ from: opp, text: "hi" }, opp, me).name).toBe("Opponent");
    expect(normalizeChat({ from: opp, text: "hi", name: "Bob" }, opp, me).name).toBe("Bob");
  });
});

describe("computeGameOver", () => {
  it("maps a 1-0 result to a win for white and a loss for black", () => {
    expect(computeGameOver("1-0", "w", "checkmate").won).toBe(true);
    expect(computeGameOver("1-0", "b", "checkmate").won).toBe(false);
  });

  it("maps a 0-1 result to a loss for white and a win for black", () => {
    expect(computeGameOver("0-1", "w", "resignation").won).toBe(false);
    expect(computeGameOver("0-1", "b", "resignation").won).toBe(true);
  });

  it("treats a 1/2-1/2 draw as neutral for both sides", () => {
    expect(computeGameOver("1/2-1/2", "w", "draw by agreement").won).toBeNull();
    expect(computeGameOver("1/2-1/2", "b", "stalemate").won).toBeNull();
  });

  it("treats an aborted (*) result as neutral, not a loss", () => {
    // Regression: previously rendered as 'You lost' for both players
    // because the won field defaulted to false on any non-draw.
    expect(computeGameOver("*", "w", "aborted").won).toBeNull();
    expect(computeGameOver("*", "b", "aborted").won).toBeNull();
  });

  it("preserves the result and reason passed in", () => {
    const go = computeGameOver("1-0", "w", "timeout");
    expect(go.result).toBe("1-0");
    expect(go.reason).toBe("timeout");
  });
});
