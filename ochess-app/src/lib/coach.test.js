import { describe, it, expect, vi, beforeEach } from "vitest";

const { engineState } = vi.hoisted(() => ({
  engineState: { evalResult: null },
}));

vi.mock("./engine", () => ({
  init: vi.fn(() => Promise.resolve()),
  evaluate: vi.fn(() => Promise.resolve(engineState.evalResult)),
  formatEval: (v) => String(v),
}));

import { explainPuzzle, explainMove, evaluatePosition } from "./coach";

beforeEach(() => {
  engineState.evalResult = null;
});

describe("evaluatePosition", () => {
  it("returns null when the engine fails to produce a result", async () => {
    engineState.evalResult = null;
    const out = await evaluatePosition("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    expect(out).toBeNull();
  });

  it("normalises an engine result into the public shape", async () => {
    engineState.evalResult = { eval_cp: 50, eval_mate: null, bestMove: "e2e4", pv: ["e2e4"], depth: 14 };
    const out = await evaluatePosition("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    expect(out).toEqual({ cp: 50, mate: null, bestMove: "e2e4", pv: ["e2e4"], depth: 14 });
  });
});

describe("explainPuzzle", () => {
  const PUZZLE_FEN = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";

  it("falls back to a generic line when nothing useful can be said", async () => {
    engineState.evalResult = null;
    const out = await explainPuzzle(PUZZLE_FEN, ["b1c3", "g8f6"]);
    expect(typeof out.text).toBe("string");
    expect(out.text.length).toBeGreaterThan(0);
  });

  it("includes a 'forced mate' phrasing when the engine reports mate", async () => {
    engineState.evalResult = { eval_cp: null, eval_mate: 3, pv: [], depth: 14 };
    const out = await explainPuzzle(PUZZLE_FEN, ["b1c3", "g8f6"]);
    expect(out.text.toLowerCase()).toMatch(/mate in 3|forced mate/);
  });

  it("returns barPct in [5, 95] regardless of how extreme the eval is", async () => {
    engineState.evalResult = { eval_cp: 99999, eval_mate: null, pv: [], depth: 14 };
    const out = await explainPuzzle(PUZZLE_FEN, ["b1c3", "g8f6"]);
    expect(out.barPct).toBeLessThanOrEqual(95);
    expect(out.barPct).toBeGreaterThanOrEqual(5);
  });

  it("appends a sequence-length note for puzzles that need 3+ player moves", async () => {
    engineState.evalResult = null;
    // Five plies = ceil(4/2) = 2 player moves. Use 7 plies for >2.
    const out = await explainPuzzle(PUZZLE_FEN, ["b1c3", "g8f6", "f1c4", "f8c5", "c4f7", "e8e7", "d2d4"]);
    expect(out.text).toMatch(/sequence/);
  });

  it("attaches a theme hint when one is provided", async () => {
    engineState.evalResult = null;
    const out = await explainPuzzle(PUZZLE_FEN, ["b1c3", "g8f6"], ["fork"]);
    expect(out.text.toLowerCase()).toMatch(/fork|attacks two|piece attacks/);
  });
});

describe("explainMove", () => {
  it("returns the static fallback string when nothing notable happens", async () => {
    engineState.evalResult = null;
    const out = await explainMove("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "Nf3");
    expect(out).toMatch(/Interesting move|Even position|Eval/);
  });

  it("calls out a checkmate move", async () => {
    engineState.evalResult = null;
    // Position where Qxh7 is mate: Qh5 vs an exposed king isn't easy to
    // construct mid-game. Instead use a fool's-mate-style ending.
    const matedFen = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    // Black to play Qxh4# isn't valid; let's use a textbook scholar's mate:
    const sm = "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4";
    const out = await explainMove(sm, "Qxf7#");
    expect(out).toMatch(/Checkmate/i);
  });
});
