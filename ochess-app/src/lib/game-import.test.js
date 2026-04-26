import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchLichessGames, fetchChesscomGames, MAX_IMPORT_GAMES, parsePgnFile } from "./game-import";

describe("MAX_IMPORT_GAMES", () => {
  it("is a sane positive number", () => {
    expect(MAX_IMPORT_GAMES).toBeGreaterThan(100);
    expect(MAX_IMPORT_GAMES).toBeLessThan(50_000);
  });
});

function makeNdjsonResponse(lines) {
  const body = lines.map((g) => JSON.stringify(g)).join("\n");
  return {
    ok: true,
    status: 200,
    body: null, // forces the no-reader branch
    text: () => Promise.resolve(body),
  };
}

describe("fetchLichessGames", () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it("caps the result at MAX_IMPORT_GAMES and reports truncation", async () => {
    const huge = Array.from({ length: MAX_IMPORT_GAMES + 50 }, (_, i) => ({
      pgn: `[Result "1-0"] 1. e4 1-0`,
      id: String(i),
      players: { white: { user: { name: "a" } }, black: { user: { name: "b" } } },
      winner: "white",
      createdAt: 0,
    }));
    global.fetch = vi.fn(() => Promise.resolve(makeNdjsonResponse(huge)));
    const games = await fetchLichessGames("anyone", { max: MAX_IMPORT_GAMES });
    expect(games.length).toBe(MAX_IMPORT_GAMES);
    expect(games.truncated).toBe(true);
  });

  it("does not flag truncation when the result fits under the cap", async () => {
    const small = Array.from({ length: 5 }, (_, i) => ({
      pgn: `[Result "0-1"] 1. e4 e5 0-1`,
      id: String(i),
      players: {},
      winner: "black",
      createdAt: 0,
    }));
    global.fetch = vi.fn(() => Promise.resolve(makeNdjsonResponse(small)));
    const games = await fetchLichessGames("anyone");
    expect(games.length).toBe(5);
    expect(games.truncated).toBe(false);
  });

  it("throws a friendly error on 404", async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404 }));
    await expect(fetchLichessGames("nobody")).rejects.toThrow(/not found/i);
  });
});

describe("fetchChesscomGames", () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it("respects the cap across archives and reports truncation", async () => {
    const archiveUrls = ["a", "b"];
    const archivesRes = { ok: true, status: 200, json: () => Promise.resolve({ archives: archiveUrls }) };
    const archive = { ok: true, status: 200, json: () => Promise.resolve({
      games: Array.from({ length: 100 }, (_, i) => ({ pgn: "1. e4", url: `g${i}`, white: {}, black: {}, end_time: 0 })),
    }) };
    global.fetch = vi.fn((url) => {
      if (url.endsWith("/archives")) return Promise.resolve(archivesRes);
      return Promise.resolve(archive);
    });
    const games = await fetchChesscomGames("nobody", { max: 50 });
    expect(games.length).toBeLessThanOrEqual(50);
    expect(games.truncated).toBe(true);
  });
});

describe("parsePgnFile", () => {
  it("parses a single-game PGN", () => {
    const pgn = `[Event "?"]\n[White "a"]\n[Black "b"]\n[Result "1-0"]\n\n1. e4 e5 1-0`;
    const games = parsePgnFile(pgn);
    expect(games.length).toBe(1);
    expect(games[0].white).toBe("a");
    expect(games[0].result).toBe("1-0");
  });
});
