import { describe, it, expect } from "vitest";
import { translateValidatorErrors, checkPromptSanity } from "./error-messages";

describe("translateValidatorErrors", () => {
  it("uses the fallback when given no errors", () => {
    const r = translateValidatorErrors([]);
    expect(r.headline).toMatch(/couldn't produce/i);
    expect(r.hint).toMatch(/example/i);
    expect(r.raw).toEqual([]);
  });

  it("uses the fallback for unrecognized errors", () => {
    const r = translateValidatorErrors(["something we don't know about"]);
    expect(r.headline).toMatch(/couldn't produce/i);
    expect(r.raw).toEqual(["something we don't know about"]);
  });

  it("translates king-in-check messages", () => {
    const r = translateValidatorErrors([
      "starting position is illegal: white king starts in check",
    ]);
    expect(r.headline).toMatch(/already in check/i);
    expect(r.hint).toMatch(/away from each other/i);
  });

  it("translates missing-king messages", () => {
    const r = translateValidatorErrors([
      "starting position is missing the white king (required by checkmate rules)",
    ]);
    expect(r.headline).toMatch(/missing a king/i);
  });

  it("translates bad-FEN messages", () => {
    const r = translateValidatorErrors([
      "startingFen is not a valid FEN: ranks must have exactly 8 squares",
    ]);
    expect(r.headline).toMatch(/valid chess position/i);
  });

  it("translates zero-legal-moves messages", () => {
    const r = translateValidatorErrors([
      "starting position has zero legal moves for the first mover",
    ]);
    expect(r.headline).toMatch(/no legal moves/i);
    expect(r.hint).toMatch(/restrictive/i);
  });

  it("translates one-sided / asymmetric mobility messages", () => {
    const r = translateValidatorErrors([
      "mobility is severely one-sided: white has 24 legal moves, black has 1 (24.0:1)",
    ]);
    expect(r.headline).toMatch(/one-sided/i);
  });

  it("translates [0,0] direction messages", () => {
    const r = translateValidatorErrors([
      "pieces.n.moves[0]: dirs cannot include [0,0]",
    ]);
    expect(r.headline).toMatch(/loop forever/i);
  });

  it("translates bad-range messages", () => {
    const r = translateValidatorErrors([
      "pieces.r.moves[0]: maxRange must be in 1..8",
    ]);
    expect(r.headline).toMatch(/range/i);
  });

  it("translates missing-array messages", () => {
    const r = translateValidatorErrors([
      "pieces.b.moves[0]: requires a dirs array",
    ]);
    expect(r.headline).toMatch(/missing the directions/i);
  });

  it("translates unknown-primitive messages", () => {
    const r = translateValidatorErrors([
      "pieces.q.moves[0]: invalid kind 'jump'",
    ]);
    expect(r.headline).toMatch(/movement type/i);
  });

  it("translates unknown win-condition messages", () => {
    const r = translateValidatorErrors([
      "winCondition[1]: type 'destroy_castle' is unrecognized",
    ]);
    expect(r.headline).toMatch(/win condition/i);
  });

  it("translates bad-capture-target messages", () => {
    const r = translateValidatorErrors([
      "first_to_n_captures.target out of range: 100",
    ]);
    expect(r.headline).toMatch(/target.*out of range/i);
  });

  it("includes the raw errors in the result for the disclosure", () => {
    const r = translateValidatorErrors([
      "pieces.n.moves[0]: dirs cannot include [0,0]",
      "and another one",
    ]);
    expect(r.raw).toEqual([
      "pieces.n.moves[0]: dirs cannot include [0,0]",
      "and another one",
    ]);
  });

  it("first matched pattern wins (more specific patterns first)", () => {
    const r = translateValidatorErrors([
      "starting position has zero legal moves for the first mover",
      "white has zero legal moves from the starting position",
    ]);
    // The first one matches the no-legal-moves pattern.
    expect(r.headline).toMatch(/no legal moves/i);
  });

  it("accepts a string instead of an array", () => {
    const r = translateValidatorErrors(
      "starting position is illegal: white king starts in check"
    );
    expect(r.headline).toMatch(/already in check/i);
  });

  it("safe on null input", () => {
    const r = translateValidatorErrors(null);
    expect(r.headline).toBeDefined();
    expect(r.hint).toBeDefined();
  });
});

describe("checkPromptSanity", () => {
  it("rejects empty / whitespace-only", () => {
    expect(checkPromptSanity("")).toMatch(/type a description/i);
    expect(checkPromptSanity("    \n\t")).toMatch(/type a description/i);
  });

  it("rejects undefined / non-string", () => {
    expect(checkPromptSanity(undefined)).toMatch(/type a description/i);
    expect(checkPromptSanity(null)).toMatch(/type a description/i);
    expect(checkPromptSanity(42)).toMatch(/type a description/i);
  });

  it("rejects ultra-short prompts (<6 content chars)", () => {
    expect(checkPromptSanity("ok")).toMatch(/too short/i);
    expect(checkPromptSanity("yes")).toMatch(/too short/i);
  });

  it("rejects emoji-only / punctuation-only prompts", () => {
    expect(checkPromptSanity("\ud83d\ude04\ud83d\ude04\ud83d\ude04\ud83d\ude04")).toMatch(/too short/i);
    expect(checkPromptSanity(".... !!!! ?? ##")).toMatch(/too short/i);
  });

  it("rejects single-word prompts", () => {
    // "kings" is 5 letters but only ONE word-shaped token. We
    // want at least a couple of real words.
    expect(checkPromptSanity("kingschess")).toMatch(/real words/i);
  });

  it("accepts a short but reasonable prompt", () => {
    expect(checkPromptSanity("kings start middle")).toBeNull();
    expect(checkPromptSanity("pawns move backward")).toBeNull();
  });

  it("accepts a normal-length prompt", () => {
    expect(checkPromptSanity("Both kings start in the middle of the board, surrounded by their pieces.")).toBeNull();
  });

  it("rejects prompts over 600 chars", () => {
    const long = "a ".repeat(400);
    expect(checkPromptSanity(long)).toMatch(/too long/i);
  });

  it("treats accented latin letters as content (not punctuation)", () => {
    expect(checkPromptSanity("Reines bougent comme cavaliers")).toBeNull();
  });
});
