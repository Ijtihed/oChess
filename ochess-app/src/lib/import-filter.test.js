import { describe, it, expect } from "vitest";
import {
  isStandardImportableGame,
  filterImportableGames,
  countPliesFromPgn,
  readPgnVariant,
  readPgnResult,
  normalizeVariantName,
  summarizeSkipped,
} from "./import-filter";

const STANDARD_PGN = `[Event "Casual game"]
[Site "lichess.org"]
[Date "2025.01.01"]
[Round "?"]
[White "alice"]
[Black "bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 1-0`;

const ATOMIC_PGN = `[Event "Atomic"]
[Variant "Atomic"]
[White "alice"]
[Black "bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 1-0`;

const CHESS960_PGN = `[Event "Casual"]
[Variant "Chess960"]
[White "alice"]
[Black "bob"]
[Result "1-0"]
[FEN "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w HFhf - 0 1"]

1. d4 d5 2. Nb3 Nb6 3. Nf3 Nf6 4. e3 e6 5. Bd3 Bd6 6. O-O O-O 1-0`;

const UNFINISHED_PGN = `[Event "Live"]
[White "alice"]
[Black "bob"]
[Result "*"]

1. e4 e5 2. Nf3`;

const SHORT_PGN = `[Event "Live"]
[White "alice"]
[Black "bob"]
[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`;

describe("readPgnVariant", () => {
  it("returns lowercased variant from header", () => {
    expect(readPgnVariant(ATOMIC_PGN)).toBe("atomic");
  });
  it("returns empty string when header is absent", () => {
    expect(readPgnVariant(STANDARD_PGN)).toBe("");
  });
  it("safe on non-string input", () => {
    expect(readPgnVariant(null)).toBe("");
    expect(readPgnVariant(undefined)).toBe("");
  });
});

describe("readPgnResult", () => {
  it("reads decisive results", () => {
    expect(readPgnResult(STANDARD_PGN)).toBe("1-0");
  });
  it("reads in-progress results", () => {
    expect(readPgnResult(UNFINISHED_PGN)).toBe("*");
  });
});

describe("normalizeVariantName", () => {
  it("strips dashes and underscores and lowercases", () => {
    expect(normalizeVariantName("King-Of-The-Hill")).toBe("kingofthehill");
    expect(normalizeVariantName("KING_OF_THE_HILL")).toBe("kingofthehill");
  });
  it("handles empty / null", () => {
    expect(normalizeVariantName(null)).toBe("");
    expect(normalizeVariantName("")).toBe("");
  });
});

describe("countPliesFromPgn", () => {
  it("counts SAN tokens for a normal opening", () => {
    expect(countPliesFromPgn(STANDARD_PGN)).toBe(14); // 7 full moves
  });
  it("returns 0 on empty input", () => {
    expect(countPliesFromPgn("")).toBe(0);
    expect(countPliesFromPgn(null)).toBe(0);
  });
  it("ignores comments + NAGs + variations", () => {
    const pgn = `[White "a"]\n[Black "b"]\n[Result "1-0"]\n\n1. e4 {good} $1 (1. d4 d5) 1... e5 2. Nf3 1-0`;
    expect(countPliesFromPgn(pgn)).toBe(3);
  });
});

describe("isStandardImportableGame", () => {
  it("accepts a standard chess game", () => {
    const r = isStandardImportableGame({ pgn: STANDARD_PGN });
    expect(r.ok).toBe(true);
  });

  it("rejects an Atomic game via PGN [Variant] header", () => {
    const r = isStandardImportableGame({ pgn: ATOMIC_PGN });
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("variant");
  });

  it("rejects a Chess960 game via PGN [Variant] header", () => {
    const r = isStandardImportableGame({ pgn: CHESS960_PGN });
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("variant");
  });

  it("rejects when caller-supplied variant says crazyhouse even if PGN tag is missing", () => {
    const r = isStandardImportableGame({
      pgn: STANDARD_PGN.replace(/\[Variant[^\]]*\]\n?/i, ""),
      variant: "crazyhouse",
    });
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("variant");
  });

  it("rejects an unfinished game (Result *)", () => {
    const r = isStandardImportableGame({ pgn: UNFINISHED_PGN });
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("incomplete");
  });

  it("rejects a too-short game", () => {
    const r = isStandardImportableGame({ pgn: SHORT_PGN });
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("too_short");
  });

  it("rejects when there's no PGN at all", () => {
    expect(isStandardImportableGame({}).skipReason).toBe("no_pgn");
    expect(isStandardImportableGame(null).skipReason).toBe("no_pgn");
  });

  it("accepts Lichess 'from position' (it's standard rules with a custom FEN)", () => {
    const pgn = STANDARD_PGN.replace("[Result", '[Variant "From Position"]\n[Result');
    const r = isStandardImportableGame({ pgn, variant: "fromPosition" });
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown variant string defensively (not an allowed alias)", () => {
    const r = isStandardImportableGame({ pgn: STANDARD_PGN, variant: "spaceChess" });
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("variant");
  });

  it("respects opts.minPlies override", () => {
    const r = isStandardImportableGame({ pgn: SHORT_PGN }, { minPlies: 4 });
    expect(r.ok).toBe(true);
  });
});

describe("filterImportableGames", () => {
  it("returns only the importable games and a skip tally", () => {
    const games = [
      { pgn: STANDARD_PGN, id: "1" },
      { pgn: ATOMIC_PGN, id: "2" },
      { pgn: UNFINISHED_PGN, id: "3" },
      { pgn: SHORT_PGN, id: "4" },
      { pgn: CHESS960_PGN, id: "5" },
    ];
    const out = filterImportableGames(games);
    expect(out.games.map((g) => g.id)).toEqual(["1"]);
    expect(out.skipped.variant).toBe(2);
    expect(out.skipped.incomplete).toBe(1);
    expect(out.skipped.too_short).toBe(1);
  });

  it("handles an empty array", () => {
    const out = filterImportableGames([]);
    expect(out.games).toEqual([]);
  });
});

describe("summarizeSkipped", () => {
  it("formats a multi-reason summary", () => {
    const s = summarizeSkipped({ variant: 3, incomplete: 1, too_short: 0, no_pgn: 0, no_user_color: 0 });
    expect(s).toMatch(/3 variant games/);
    expect(s).toMatch(/1 unfinished/);
  });
  it("returns null when nothing was skipped", () => {
    expect(summarizeSkipped({ variant: 0, incomplete: 0, too_short: 0, no_pgn: 0, no_user_color: 0 })).toBeNull();
  });
});
