import { describe, it, expect } from "vitest";
import { formatEval, evalToText, lockEval, unlockEval } from "./engine";

describe("formatEval", () => {
  it("returns '?' for null", () => {
    expect(formatEval(null)).toBe("?");
  });

  it("formats centipawn eval", () => {
    expect(formatEval({ eval_cp: 150, eval_mate: null })).toBe("1.5");
    expect(formatEval({ eval_cp: -45, eval_mate: null })).toBe("-0.5");
    expect(formatEval({ eval_cp: 0, eval_mate: null })).toBe("0.0");
  });

  it("formats mate eval", () => {
    expect(formatEval({ eval_cp: null, eval_mate: 3 })).toBe("M3");
    expect(formatEval({ eval_cp: null, eval_mate: -2 })).toBe("M-2");
  });

  it("prefers mate over cp", () => {
    expect(formatEval({ eval_cp: 100, eval_mate: 1 })).toBe("M1");
  });

  it("returns '?' when both are null", () => {
    expect(formatEval({ eval_cp: null, eval_mate: null })).toBe("?");
  });
});

describe("evalToText", () => {
  it("returns empty string for null", () => {
    expect(evalToText(null)).toBe("");
  });

  it("describes roughly equal positions", () => {
    const text = evalToText({ eval_cp: 10, eval_mate: null }, "w");
    expect(text).toContain("roughly equal");
  });

  it("describes white advantage from white side", () => {
    const text = evalToText({ eval_cp: 200, eval_mate: null }, "w");
    expect(text).toContain("White");
    expect(text).toContain("better");
  });

  it("describes black advantage from white side", () => {
    const text = evalToText({ eval_cp: -300, eval_mate: null }, "w");
    expect(text).toContain("Black");
  });

  it("describes mate eval", () => {
    const text = evalToText({ eval_cp: null, eval_mate: 3 }, "w");
    expect(text).toContain("mate");
    expect(text).toContain("White");
  });

  it("describes negative mate for opponent", () => {
    const text = evalToText({ eval_cp: null, eval_mate: -2 }, "w");
    expect(text).toContain("mate");
    expect(text).toContain("Black");
  });
});

describe("lockEval / unlockEval", () => {
  it("lock and unlock are callable without error", () => {
    expect(() => lockEval()).not.toThrow();
    expect(() => unlockEval()).not.toThrow();
  });
});
