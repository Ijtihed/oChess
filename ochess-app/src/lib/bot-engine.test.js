import { describe, it, expect } from "vitest";
import { BOT_CONFIG } from "./bot-engine";

describe("BOT_CONFIG", () => {
  it("has 8 levels (0-7)", () => {
    expect(BOT_CONFIG).toHaveLength(8);
    BOT_CONFIG.forEach((c, i) => expect(c.level).toBe(i));
  });

  it("levels 0 uses random engine", () => {
    expect(BOT_CONFIG[0].engine).toBe("random");
  });

  it("levels 1-3 use jce engine", () => {
    for (let i = 1; i <= 3; i++) {
      expect(BOT_CONFIG[i].engine).toBe("jce");
      expect(typeof BOT_CONFIG[i].jceLevel).toBe("number");
    }
  });

  it("levels 4-7 use sf engine", () => {
    for (let i = 4; i <= 7; i++) {
      expect(BOT_CONFIG[i].engine).toBe("sf");
      expect(typeof BOT_CONFIG[i].sfElo).toBe("number");
    }
  });

  it("each config has name and desc", () => {
    BOT_CONFIG.forEach((c) => {
      expect(c.name).toBeTruthy();
      expect(c.desc).toBeTruthy();
    });
  });

  it("stockfish level 7 has sfElo 0 (unlimited)", () => {
    expect(BOT_CONFIG[7].sfElo).toBe(0);
  });
});
