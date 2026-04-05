import { describe, it, expect } from "vitest";
import { getBotChatMessage } from "./bot-chat";

describe("getBotChatMessage", () => {
  it("returns null for level >= 6", () => {
    expect(getBotChatMessage(6, { san: "e4" })).toBeNull();
    expect(getBotChatMessage(7, { san: "e4" })).toBeNull();
  });

  it("returns a string for valid levels on a normal move", () => {
    for (let level = 0; level <= 5; level++) {
      const msg = getBotChatMessage(level, { san: "e4", moveCount: 1 });
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it("returns a capture line when captured is set", () => {
    const msg = getBotChatMessage(0, { san: "Nxe5", captured: "pawn", moveCount: 3 });
    expect(typeof msg).toBe("string");
  });

  it("returns a check line when check is true", () => {
    const msg = getBotChatMessage(1, { san: "Qh5+", check: true, moveCount: 5 });
    expect(typeof msg).toBe("string");
  });

  it("returns a mate line when mate is true", () => {
    const msg = getBotChatMessage(2, { san: "Qxf7#", mate: true, moveCount: 10 });
    expect(typeof msg).toBe("string");
  });

  it("returns a takeback line for takeback san", () => {
    const msg = getBotChatMessage(3, { san: "takeback", moveCount: 7 });
    expect(typeof msg).toBe("string");
  });

  it("falls back to level 3 lines for unknown levels (below 6)", () => {
    const msg = getBotChatMessage(99, { san: "e4", moveCount: 1 });
    expect(msg).toBeNull();
  });
});
