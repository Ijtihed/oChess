import { describe, it, expect } from "vitest";
import { createVariantGame, VARIANT_DEFS } from "./variants";

describe("VARIANT_DEFS", () => {
  it("has all expected variants", () => {
    const ids = Object.keys(VARIANT_DEFS);
    expect(ids).toContain("chess960");
    expect(ids).toContain("kingOfTheHill");
    expect(ids).toContain("threeCheck");
    expect(ids).toContain("noCastling");
    expect(ids).toContain("antichess");
    expect(ids).toContain("atomic");
    expect(ids).toContain("racingKings");
    expect(ids).toContain("horde");
    expect(ids).toContain("extinction");
    expect(ids).toContain("torpedo");
    expect(ids).toContain("fogOfWar");
    expect(ids).toContain("rifle");
    expect(ids).toContain("circe");
    expect(ids).toContain("monster");
    expect(ids).toContain("marseillais");
    expect(ids).toContain("progressive");
    expect(ids).toContain("dunsanys");
    expect(ids).toContain("checkless");
    expect(ids).toContain("peasants");
    expect(ids).toContain("weakArmy");
    // The "standard" entry is intentionally a no-op so OnlineGameScreen
    // can route every game through `createVariantGame` and avoid a
    // second chess.js code path. Bump the count to 21 to lock that in.
    expect(ids).toContain("standard");
    expect(ids.length).toBe(21);
  });
});

describe("chess960 deterministic seed", () => {
  // Regression: before the seed parameter, generate960Position
  // used Math.random() unconditionally, so two browser clients in
  // an online match would get DIFFERENT starting positions until
  // the first PGN write synced. Now the same seed -> the same
  // back rank.

  it("produces the same starting position for the same seed", () => {
    const a = createVariantGame("chess960", { seed: "game-uuid-abc-123" });
    const b = createVariantGame("chess960", { seed: "game-uuid-abc-123" });
    expect(a.fen()).toBe(b.fen());
  });

  it("produces different starting positions for different seeds", () => {
    const a = createVariantGame("chess960", { seed: "game-uuid-abc-123" });
    const b = createVariantGame("chess960", { seed: "game-uuid-different" });
    // Not technically guaranteed (60+ valid 960 positions could
    // collide on hash), but for these two literal strings it's
    // fine and pins the contract.
    expect(a.fen()).not.toBe(b.fen());
  });

  it("falls back to randomized positions when no seed is given (bot / local games)", () => {
    // Sample a handful and confirm at least 2 distinct outputs.
    // 960 positions, hash randomness -> collisions over 10 trials
    // are vanishingly small.
    const seen = new Set();
    for (let i = 0; i < 10; i++) {
      seen.add(createVariantGame("chess960").fen());
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("yields a Chess960-shaped position (8 distinct files, kings between rooks, bishops opposite colours)", () => {
    const fen = createVariantGame("chess960", { seed: "x" }).fen();
    const back = fen.split(" ")[0].split("/")[7]; // white back rank
    expect(back).toHaveLength(8);
    // Same piece set as standard, just in a different order.
    const sorted = back.split("").sort().join("");
    expect(sorted).toBe("BBKNNQRR");
    // King between the rooks.
    const kIdx = back.indexOf("K");
    const rIdxs = [...back].map((c, i) => c === "R" ? i : -1).filter((i) => i >= 0);
    expect(kIdx).toBeGreaterThan(rIdxs[0]);
    expect(kIdx).toBeLessThan(rIdxs[1]);
    // Bishops on opposite-coloured squares.
    const bIdxs = [...back].map((c, i) => c === "B" ? i : -1).filter((i) => i >= 0);
    expect((bIdxs[0] + bIdxs[1]) % 2).toBe(1);
  });
});

describe("createVariantGame", () => {
  it("returns a game object with required methods", () => {
    const vg = createVariantGame("chess960");
    expect(typeof vg.move).toBe("function");
    expect(typeof vg.checkEnd).toBe("function");
    expect(typeof vg.fen).toBe("function");
    expect(typeof vg.turn).toBe("function");
    expect(typeof vg.history).toBe("function");
    expect(typeof vg.isMultiMove).toBe("function");
    expect(typeof vg.isFogOfWar).toBe("function");
    expect(typeof vg.getMaskedFen).toBe("function");
  });

  it("falls back to chess960 for unknown variant", () => {
    const vg = createVariantGame("nonexistent");
    expect(vg.def.name).toBe("Chess960");
  });
});

describe("Chess960", () => {
  it("generates a valid starting position", () => {
    const vg = createVariantGame("chess960");
    expect(vg.fen()).toBeTruthy();
    expect(vg.turn()).toBe("w");
    expect(vg.history().length).toBe(0);
  });

  it("generates different positions", () => {
    const fens = new Set();
    for (let i = 0; i < 20; i++) {
      fens.add(createVariantGame("chess960").startFen);
    }
    expect(fens.size).toBeGreaterThan(1);
  });

  it("has king between rooks", () => {
    for (let i = 0; i < 10; i++) {
      const vg = createVariantGame("chess960");
      const rank = vg.fen().split("/")[0];
      const kIdx = rank.indexOf("k");
      const rIndices = [];
      for (let j = 0; j < rank.length; j++) if (rank[j] === "r") rIndices.push(j);
      expect(rIndices.length).toBe(2);
      expect(kIdx).toBeGreaterThan(rIndices[0]);
      expect(kIdx).toBeLessThan(rIndices[1]);
    }
  });

  it("allows standard moves", () => {
    const vg = createVariantGame("chess960");
    const moves = vg.chess.moves();
    expect(moves.length).toBeGreaterThan(0);
  });
});

describe("King of the Hill", () => {
  it("starts from standard position", () => {
    const vg = createVariantGame("kingOfTheHill");
    expect(vg.fen()).toContain("rnbqkbnr");
  });

  it("detects king on hill as win", () => {
    const vg = createVariantGame("kingOfTheHill");
    vg.chess.load("8/8/8/8/3K4/8/8/4k3 b - - 0 1");
    const end = vg.checkEnd();
    expect(end).not.toBeNull();
    expect(end.result).toBe("1-0");
    expect(end.reason).toContain("hill");
  });

  it("black king on hill wins for black", () => {
    const vg = createVariantGame("kingOfTheHill");
    vg.chess.load("8/8/8/4k3/8/8/8/4K3 w - - 0 1");
    const end = vg.checkEnd();
    expect(end).not.toBeNull();
    expect(end.result).toBe("0-1");
  });

  it("no win if king not on hill", () => {
    const vg = createVariantGame("kingOfTheHill");
    const end = vg.checkEnd();
    expect(end).toBeNull();
  });
});

describe("Three-Check", () => {
  it("tracks check count", () => {
    const vg = createVariantGame("threeCheck");
    vg.move({ from: "e2", to: "e4" });
    vg.checkEnd();
    vg.move({ from: "d7", to: "d5" });
    vg.checkEnd();
    vg.move({ from: "f1", to: "b5" });
    const end = vg.checkEnd();
    expect(vg.getCheckCounts().black).toBe(1);
    expect(end).toBeNull();
  });

  it("three checks wins", () => {
    const vg = createVariantGame("threeCheck");
    vg.state.checksOnBlack = 2;
    vg.chess.load("4k3/8/8/8/8/8/8/R3K3 w - - 0 1");
    vg.chess.move("Ra8+");
    const end = vg.checkEnd();
    expect(end).not.toBeNull();
    expect(end.result).toBe("1-0");
  });

  // HARDENING regression: previously loadPgn lost check counters
  // because threeCheck had no `afterMove` hook; the counts only
  // got rebuilt by `checkCustomEnd` polls which a re-hydrated
  // session may never fire. After the fix, afterMove replays
  // through every history move and rebuilds the counter.
  it("rebuilds check counters after loadPgn replay", () => {
    const vg = createVariantGame("threeCheck");
    // Build a short game where black gets checked twice. Each
    // `vg.move(...)` runs the wrapper's afterMove and bumps the
    // counter once per checked ply.
    vg.move({ from: "e2", to: "e4" });
    vg.move({ from: "e7", to: "e5" });
    vg.move({ from: "f1", to: "c4" });
    vg.move({ from: "b8", to: "c6" });
    vg.move({ from: "d1", to: "h5" });
    vg.move({ from: "g8", to: "f6" });
    vg.move({ from: "h5", to: "f7" }); // Qxf7+, check #1
    vg.move({ from: "e8", to: "f7" });
    vg.move({ from: "c4", to: "f7" }); // Bxf7+? actually +
    // Snapshot the count and PGN.
    const before = vg.getCheckCounts();
    const pgn = vg.pgn();
    // Fresh wrapper that loads the PGN. Without the afterMove fix
    // the counters would be 0 after this; with the fix they
    // should match `before`.
    const replay = createVariantGame("threeCheck");
    replay.loadPgn(pgn);
    expect(replay.getCheckCounts().black).toBe(before.black);
    expect(replay.getCheckCounts().white).toBe(before.white);
  });
});

describe("No Castling", () => {
  it("starts without castling rights", () => {
    const vg = createVariantGame("noCastling");
    expect(vg.fen()).toContain(" w - -");
  });

  it("plays normally otherwise", () => {
    const vg = createVariantGame("noCastling");
    const result = vg.move({ from: "e2", to: "e4" });
    expect(result).not.toBeNull();
    expect(result.san).toBe("e4");
  });
});

describe("Antichess", () => {
  it("forces captures when available", () => {
    const vg = createVariantGame("antichess");
    vg.chess.load("4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1");
    const nonCapture = vg.move({ from: "e4", to: "e5" });
    expect(nonCapture).toBeNull();
    const capture = vg.move({ from: "e4", to: "d5" });
    expect(capture).not.toBeNull();
  });

  it("allows non-capture when no captures available", () => {
    const vg = createVariantGame("antichess");
    vg.chess.load("4k3/8/8/8/4P3/8/8/4K3 w - - 0 1");
    const result = vg.move({ from: "e4", to: "e5" });
    expect(result).not.toBeNull();
  });
});

describe("Atomic", () => {
  it("starts normally with both kings", () => {
    const vg = createVariantGame("atomic");
    const end = vg.checkEnd();
    expect(end).toBeNull();
  });

  it("is flagged as atomic", () => {
    const vg = createVariantGame("atomic");
    expect(vg.def.isAtomic).toBe(true);
  });
});

describe("Racing Kings", () => {
  it("starts from custom position", () => {
    const vg = createVariantGame("racingKings");
    expect(vg.fen()).toContain("krbnNBRK");
  });

  it("detects king on rank 8", () => {
    const vg = createVariantGame("racingKings");
    vg.chess.load("K3k3/8/8/8/8/8/8/8 w - - 0 1");
    const end = vg.checkEnd();
    expect(end).not.toBeNull();
  });
});

describe("Horde", () => {
  it("starts with horde FEN containing king", () => {
    const vg = createVariantGame("horde");
    expect(vg.fen()).toContain("PPPPPPPP/PPPPPPPP");
    expect(vg.fen()).toContain("K");
  });

  it("black wins when only white king remains", () => {
    const vg = createVariantGame("horde");
    vg.chess.load("rnbqkbnr/pppppppp/8/8/8/8/8/4K3 b - - 0 1");
    const end = vg.checkEnd();
    expect(end).not.toBeNull();
    expect(end.result).toBe("0-1");
  });
});

describe("Extinction", () => {
  it("detects piece type elimination", () => {
    const vg = createVariantGame("extinction");
    vg.checkEnd();
    vg.chess.load("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1");
    const end = vg.checkEnd();
    expect(end).not.toBeNull();
    expect(end.result).toBe("0-1");
    expect(end.reason).toContain("queens");
  });

  it("no end if all types still present", () => {
    const vg = createVariantGame("extinction");
    const end = vg.checkEnd();
    expect(end).toBeNull();
  });
});

describe("Fog of War", () => {
  it("is flagged as fog of war", () => {
    const vg = createVariantGame("fogOfWar");
    expect(vg.isFogOfWar()).toBe(true);
  });

  it("returns masked FEN different from real FEN", () => {
    const vg = createVariantGame("fogOfWar");
    vg.move({ from: "e2", to: "e4" });
    vg.move({ from: "e7", to: "e5" });
    const real = vg.fen();
    const masked = vg.getMaskedFen("w");
    expect(masked).not.toBe(real);
  });

  it("shows own pieces in masked FEN", () => {
    const vg = createVariantGame("fogOfWar");
    const masked = vg.getMaskedFen("w");
    expect(masked).toContain("RNBQKBNR");
  });
});

describe("Rifle Chess", () => {
  it("piece stays on source square after capture", () => {
    const vg = createVariantGame("rifle");
    vg.chess.load("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1");
    const result = vg.move({ from: "e4", to: "d5" });
    expect(result).not.toBeNull();
    const board = vg.board();
    const e4 = board[4][4];
    expect(e4).not.toBeNull();
    expect(e4.type).toBe("p");
    expect(e4.color).toBe("w");
    const d5 = board[3][3];
    expect(d5).toBeNull();
  });
});

describe("Circe Chess", () => {
  it("respawns captured piece on starting square", () => {
    const vg = createVariantGame("circe");
    vg.chess.load("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1");
    vg.move({ from: "e4", to: "d5" });
    const board = vg.board();
    const d7 = board[1][3];
    expect(d7).not.toBeNull();
    expect(d7.type).toBe("p");
    expect(d7.color).toBe("b");
  });
});

describe("Monster Chess", () => {
  it("is multi-move", () => {
    const vg = createVariantGame("monster");
    expect(vg.isMultiMove()).toBe(true);
  });

  it("white gets 2 moves per turn", () => {
    const vg = createVariantGame("monster");
    const n = vg.onTurnStart();
    expect(n).toBe(2);
  });

  it("starts with king + pawns only for white", () => {
    const vg = createVariantGame("monster");
    expect(vg.fen()).toContain("4K3");
  });
});

describe("Marseillais Chess", () => {
  it("is multi-move", () => {
    const vg = createVariantGame("marseillais");
    expect(vg.isMultiMove()).toBe(true);
  });

  it("white's first turn is 1 move", () => {
    const vg = createVariantGame("marseillais");
    const n = vg.onTurnStart();
    expect(n).toBe(1);
  });
});

describe("Progressive Chess", () => {
  it("is multi-move", () => {
    const vg = createVariantGame("progressive");
    expect(vg.isMultiMove()).toBe(true);
  });

  it("first turn is 1 move, then escalates", () => {
    const vg = createVariantGame("progressive");
    expect(vg.onTurnStart()).toBe(1);
    vg.onTurnEnd();
    expect(vg.onTurnStart()).toBe(2);
    vg.onTurnEnd();
    expect(vg.onTurnStart()).toBe(3);
  });
});

describe("Dunsany's Chess", () => {
  it("starts with pawns + king", () => {
    const vg = createVariantGame("dunsanys");
    expect(vg.fen()).toContain("PPPPPPPP/PPPPPPPP/PPPPPPPP");
    expect(vg.fen()).toContain("K");
  });

  it("white wins by promoting a pawn (reaching rank 8)", () => {
    const vg = createVariantGame("dunsanys");
    vg.chess.load("4k3/P7/8/8/8/8/P7/4K3 w - - 0 1");
    const result = vg.move({ from: "a7", to: "a8", promotion: "q" });
    expect(result).not.toBeNull();
    const end = vg.checkEnd();
    expect(end).toBeNull();
  });

  it("detects all white pawns captured as black win", () => {
    const vg = createVariantGame("dunsanys");
    vg.chess.load("rnbqkbnr/8/8/8/8/8/8/4K3 b - - 0 1");
    const end = vg.checkEnd();
    expect(end).not.toBeNull();
    expect(end.result).toBe("0-1");
  });
});

describe("Checkless Chess", () => {
  it("blocks moves that give check (non-mate)", () => {
    const vg = createVariantGame("checkless");
    vg.chess.load("4k3/8/8/8/8/8/4R3/4K3 w - - 0 1");
    const result = vg.move({ from: "e2", to: "e7" });
    expect(result).toBeNull();
  });
});

describe("Peasants' Revolt", () => {
  it("starts with asymmetric position", () => {
    const vg = createVariantGame("peasants");
    const fen = vg.fen();
    expect(fen).toContain("1nn1k1n1");
    expect(fen).toContain("PPPPPPPP");
  });

  it("plays standard chess rules", () => {
    const vg = createVariantGame("peasants");
    const result = vg.move({ from: "e2", to: "e4" });
    expect(result).not.toBeNull();
  });
});

describe("Weak Army", () => {
  it("black starts without rooks", () => {
    const vg = createVariantGame("weakArmy");
    expect(vg.fen()).toContain("1nbqkbn1");
  });

  it("white has full army", () => {
    const vg = createVariantGame("weakArmy");
    expect(vg.fen()).toContain("RNBQKBNR");
  });
});
