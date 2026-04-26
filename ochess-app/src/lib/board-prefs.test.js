import { describe, it, expect, beforeEach } from "vitest";
import { load, save, getTheme, COLOR_THEMES, IMAGE_THEMES, ALL_THEMES, PIECE_SETS } from "./board-prefs";

beforeEach(() => {
  localStorage.clear();
});

describe("board-prefs.load / save", () => {
  it("returns sane defaults when nothing is stored", () => {
    const p = load();
    expect(p.pieceSet).toBe("cburnett");
    expect(p.boardTheme).toBe("dark");
  });

  it("round-trips a saved set of preferences", () => {
    save({ pieceSet: "alpha", boardTheme: "green" });
    const p = load();
    expect(p.pieceSet).toBe("alpha");
    expect(p.boardTheme).toBe("green");
  });

  it("falls back to defaults when stored JSON is corrupt", () => {
    localStorage.setItem("ochess_board_prefs", "{not valid json");
    const p = load();
    expect(p.pieceSet).toBe("cburnett");
    expect(p.boardTheme).toBe("dark");
  });

  it("falls back per-field when only one preference is stored", () => {
    localStorage.setItem("ochess_board_prefs", JSON.stringify({ pieceSet: "alpha" }));
    const p = load();
    expect(p.pieceSet).toBe("alpha");
    expect(p.boardTheme).toBe("dark");
  });
});

describe("board-prefs.getTheme", () => {
  it("returns the requested color theme by id", () => {
    const t = getTheme("green");
    expect(t.id).toBe("green");
    expect(t.type).toBe("color");
  });

  it("returns the requested image theme by id", () => {
    const t = getTheme("img-wood");
    expect(t.id).toBe("img-wood");
    expect(t.type).toBe("image");
  });

  it("falls back to the first color theme when the id is unknown", () => {
    const t = getTheme("does-not-exist");
    expect(t).toEqual(COLOR_THEMES[0]);
  });

  it("returns the default for null / undefined", () => {
    expect(getTheme(null).id).toBe(COLOR_THEMES[0].id);
    expect(getTheme(undefined).id).toBe(COLOR_THEMES[0].id);
  });
});

describe("board-prefs constants", () => {
  it("exposes a non-empty set of piece skins", () => {
    expect(PIECE_SETS.length).toBeGreaterThan(5);
    expect(PIECE_SETS).toContain("cburnett");
  });
  it("ALL_THEMES is the union of color + image themes", () => {
    expect(ALL_THEMES.length).toBe(COLOR_THEMES.length + IMAGE_THEMES.length);
  });
});
