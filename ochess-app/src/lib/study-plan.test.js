import { describe, it, expect, vi, beforeEach } from "vitest";

// The engine pulls in Stockfish wasm; mock it cleanly so the pure
// logic in study-plan can be tested without firing up a worker.
const { evalQueue } = vi.hoisted(() => ({ evalQueue: { values: [] } }));

vi.mock("./engine", () => ({
  init: vi.fn(() => Promise.resolve()),
  evaluate: vi.fn(() => {
    const next = evalQueue.values.shift();
    return Promise.resolve(next || null);
  }),
}));

beforeEach(() => {
  evalQueue.values = [];
});

import {
  inferPhase,
  inferThemes,
  buildWeaknessProfile,
  filterCardsByQuery,
  buildDailyPlan,
  COMMON_WEAKNESS_CHIPS,
  analyzeGameForMistakes,
  MISTAKE_CP_THRESHOLD,
  BLUNDER_CP_THRESHOLD,
} from "./study-plan";
import { Chess } from "chess.js";

describe("inferPhase", () => {
  it("classifies move 1-12 as opening regardless of pieces", () => {
    const c = new Chess();
    expect(inferPhase(c, 0)).toBe("opening");
    expect(inferPhase(c, 23)).toBe("opening");
  });

  it("classifies a position with <=16 pieces past move 12 as endgame", () => {
    // Endgame FEN: kings + a few pieces.
    const c = new Chess("4k3/8/8/8/8/8/8/4K3 w - - 0 50");
    expect(inferPhase(c, 100)).toBe("endgame");
  });

  it("classifies a full-board mid-game position as middlegame", () => {
    const c = new Chess(); // starting position has 32 pieces
    expect(inferPhase(c, 30)).toBe("middlegame");
  });
});

describe("inferThemes", () => {
  it("flags blunder + missed_mate when Stockfish offered a mating move", () => {
    const themes = inferThemes(
      { san: "Bg5", piece: "b", captured: null },
      { san: "Qxh7#", captured: "p" },
      400,
    );
    expect(themes).toContain("blunder");
    expect(themes).toContain("missed_mate");
  });

  it("flags hanging_queen when the user dropped a queen with a big eval loss", () => {
    const themes = inferThemes(
      { san: "Qe5", piece: "q", captured: null },
      { san: "Qd1", captured: null },
      550,
    );
    expect(themes).toContain("hanging_queen");
    expect(themes).toContain("blunder");
  });

  it("flags missed_capture when the engine wanted to take and the user didn't", () => {
    const themes = inferThemes(
      { san: "Nf3", piece: "n", captured: null },
      { san: "Nxe5", captured: "p" },
      150,
    );
    expect(themes).toContain("missed_capture");
    expect(themes).toContain("mistake");
  });

  it("downgrades to mistake (not blunder) when eval loss is moderate", () => {
    const themes = inferThemes({ san: "h3", piece: "p" }, null, 150);
    expect(themes).toContain("mistake");
    expect(themes).not.toContain("blunder");
  });
});

describe("buildWeaknessProfile", () => {
  it("aggregates mistake/puzzle counts by phase + theme + source", () => {
    const cards = [
      { type: "mistake", phase: "opening",    themes: ["blunder", "hanging_queen"], source: "chesscom" },
      { type: "mistake", phase: "middlegame", themes: ["mistake", "missed_capture"], source: "chesscom" },
      { type: "mistake", phase: "middlegame", themes: ["blunder"], source: "lichess" },
      { type: "puzzle",  phase: "endgame",    themes: ["fork"], source: "puzzle" },
      { type: "analysis", phase: "endgame",   themes: [], source: "analysis" }, // ignored
    ];
    const w = buildWeaknessProfile(cards);
    expect(w.total).toBe(4);
    expect(w.phaseCount).toEqual({ opening: 1, middlegame: 2, endgame: 1 });
    expect(w.sourceCount.chesscom).toBe(2);
    expect(w.sourceCount.lichess).toBe(1);
    expect(w.themeCount.blunder).toBe(2);
    // topThemes are sorted by frequency.
    expect(w.topThemes[0].count).toBeGreaterThanOrEqual(w.topThemes[w.topThemes.length - 1].count);
  });
});

describe("filterCardsByQuery", () => {
  const cards = [
    { type: "mistake", phase: "endgame",    themes: ["hanging_queen"], played_san: "Qa5" },
    { type: "mistake", phase: "middlegame", themes: ["fork"],          played_san: "Nxe5" },
    { type: "puzzle",  phase: "middlegame", themes: ["pin"],           played_san: "Bb5" },
  ];

  it("returns the full list for an empty query", () => {
    expect(filterCardsByQuery(cards, "")).toHaveLength(3);
    expect(filterCardsByQuery(cards, "   ")).toHaveLength(3);
  });

  it("matches a single token against any indexed field", () => {
    expect(filterCardsByQuery(cards, "endgame")).toHaveLength(1);
    expect(filterCardsByQuery(cards, "fork")).toHaveLength(1);
    expect(filterCardsByQuery(cards, "puzzle")).toHaveLength(1);
  });

  it("AND-matches multiple tokens - all must hit", () => {
    // "middlegame fork" → both tokens match the second card.
    expect(filterCardsByQuery(cards, "middlegame fork")).toHaveLength(1);
    // "middlegame queen" → no card has both.
    expect(filterCardsByQuery(cards, "middlegame queen")).toHaveLength(0);
  });

  it("is case-insensitive", () => {
    expect(filterCardsByQuery(cards, "FORK").length).toBe(1);
    expect(filterCardsByQuery(cards, "Hanging").length).toBe(1);
  });
});

describe("COMMON_WEAKNESS_CHIPS", () => {
  it("Blunders chip catches eval_loss_cp >= BLUNDER_CP_THRESHOLD only", () => {
    const chip = COMMON_WEAKNESS_CHIPS.find((c) => c.id === "blunders");
    expect(chip.match({ eval_loss_cp: BLUNDER_CP_THRESHOLD })).toBe(true);
    expect(chip.match({ eval_loss_cp: BLUNDER_CP_THRESHOLD - 1 })).toBe(false);
    expect(chip.match({ eval_loss_cp: 0 })).toBe(false);
  });

  it("phase chips match their phase exactly", () => {
    expect(COMMON_WEAKNESS_CHIPS.find((c) => c.id === "endgame").match({ phase: "endgame" })).toBe(true);
    expect(COMMON_WEAKNESS_CHIPS.find((c) => c.id === "endgame").match({ phase: "opening" })).toBe(false);
  });
});

describe("buildDailyPlan", () => {
  const baseCards = [
    { id: "a", type: "mistake", ts: 1, phase: "opening",    themes: ["blunder"] },
    { id: "b", type: "mistake", ts: 2, phase: "middlegame", themes: ["fork"] },
    { id: "c", type: "puzzle",  ts: 3, phase: "endgame",    themes: ["pin"] },
    { id: "d", type: "analysis", ts: 4 }, // not a mistake/puzzle - excluded
  ];

  it("filters to mistake/puzzle cards only and slices to quota", () => {
    const plan = buildDailyPlan(baseCards, {}, { quota: 2 });
    expect(plan).toHaveLength(2);
    expect(plan.every((c) => c.type === "mistake" || c.type === "puzzle")).toBe(true);
  });

  it("orders due cards before scheduled-future cards", () => {
    // `c` is scheduled in the future; expect a/b first.
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const schedules = { c: { dueAt: future } };
    const plan = buildDailyPlan(baseCards, schedules, { quota: 5 });
    expect(plan.map((p) => p.id).slice(0, 2).sort()).toEqual(["a", "b"]);
  });

  it("respects a chip filter", () => {
    const plan = buildDailyPlan(baseCards, {}, { quota: 5, chipId: "endgame" });
    expect(plan).toHaveLength(1);
    expect(plan[0].id).toBe("c");
  });

  it("respects a free-text query", () => {
    const plan = buildDailyPlan(baseCards, {}, { quota: 5, query: "fork" });
    expect(plan).toHaveLength(1);
    expect(plan[0].id).toBe("b");
  });
});

describe("analyzeGameForMistakes", () => {
  it("returns an empty array when the PGN can't be parsed", async () => {
    const out = await analyzeGameForMistakes("not a real pgn", "w");
    expect(out).toEqual([]);
  });

  it("returns an empty array when no userColor is provided", async () => {
    const out = await analyzeGameForMistakes("1. e4 e5 2. Nf3 Nc6", null);
    expect(out).toEqual([]);
  });

  it("returns an empty array when the engine returns null for everything", async () => {
    evalQueue.values = []; // mocked evaluate() returns null
    const pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6";
    const out = await analyzeGameForMistakes(pgn, "w", { depth: 8 });
    expect(out).toEqual([]);
  });

  it("flags a single blunder when Stockfish swings >100cp against the user", async () => {
    // Two user moves (white's). For move 1, Stockfish says "white is +200" before, then "white is -200" after.
    //   userPovBefore = +200
    //   userPovAfter  = -(-200) = +200  ← wait: after white moves it's black to move; the engine's eval_cp is from black's POV
    //   So if black-to-move sees +200 (good for black), userPovAfter = -200 (white).
    // To get a 400cp drop for white we want before from white POV = +200, after from white POV = -200.
    // before (white to move): eval_cp = +200 → userPovBefore = +200.
    // after  (black to move): eval_cp = +200 (good for black) → userPovAfter = -200.
    // Move 2 we keep neutral so nothing fires.
    evalQueue.values = [
      { eval_cp: 200, eval_mate: null, bestMove: "g1f3", pv: ["g1f3"], depth: 8 }, // before move 1
      { eval_cp: 200, eval_mate: null, bestMove: "b8c6", pv: ["b8c6"], depth: 8 }, // after move 1 (black POV, white is losing)
      { eval_cp: 0,   eval_mate: null, bestMove: "g1f3", pv: ["g1f3"], depth: 8 }, // before move 2
      { eval_cp: 0,   eval_mate: null, bestMove: "b8c6", pv: ["b8c6"], depth: 8 }, // after move 2
    ];
    const pgn = "1. e4 e5 2. Nc3 Nc6";
    const out = await analyzeGameForMistakes(pgn, "w", { depth: 8, threshold: MISTAKE_CP_THRESHOLD });
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].type).toBe("mistake");
    expect(out[0].played_san).toBe("e4");
    expect(out[0].eval_loss_cp).toBeGreaterThanOrEqual(MISTAKE_CP_THRESHOLD);
  });
});
