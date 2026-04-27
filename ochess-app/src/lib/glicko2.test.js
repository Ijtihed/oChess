import { describe, it, expect } from "vitest";
import { categoryFromTimeControl, computeGlicko2 } from "./glicko2";

describe("categoryFromTimeControl", () => {
  it("returns 'blitz' as the safe default for null / undefined / unparseable input", () => {
    expect(categoryFromTimeControl(null)).toBe("blitz");
    expect(categoryFromTimeControl(undefined)).toBe("blitz");
    expect(categoryFromTimeControl("")).toBe("blitz");
    expect(categoryFromTimeControl("∞")).toBe("blitz");
    expect(categoryFromTimeControl("not a tc")).toBe("blitz");
  });

  it("classifies sub-180s estimated total as bullet (1+0 = 60s)", () => {
    expect(categoryFromTimeControl("1+0")).toBe("bullet");
    expect(categoryFromTimeControl("2+0")).toBe("bullet");
  });

  it("classifies 3-7 minute (estimated) games as blitz", () => {
    // 3+0 -> 180 (boundary, blitz)
    expect(categoryFromTimeControl("3+0")).toBe("blitz");
    expect(categoryFromTimeControl("3+2")).toBe("blitz");
    expect(categoryFromTimeControl("5+0")).toBe("blitz");
    expect(categoryFromTimeControl("5+3")).toBe("blitz");
  });

  it("classifies ~8-24 minute games as rapid", () => {
    // 8+0 -> 480 (boundary, rapid)
    expect(categoryFromTimeControl("8+0")).toBe("rapid");
    expect(categoryFromTimeControl("10+0")).toBe("rapid");
    expect(categoryFromTimeControl("10+5")).toBe("rapid");
    expect(categoryFromTimeControl("15+10")).toBe("rapid");
  });

  it("classifies 25+ minute games as classical", () => {
    // 25+0 -> 1500 (boundary, classical)
    expect(categoryFromTimeControl("25+0")).toBe("classical");
    expect(categoryFromTimeControl("30+0")).toBe("classical");
    expect(categoryFromTimeControl("60+30")).toBe("classical");
  });

  it("uses the increment * 40 weighting consistent with the SQL accept_challenge RPC", () => {
    // 2+5 -> 2*60 + 5*40 = 320 -> blitz, NOT bullet
    expect(categoryFromTimeControl("2+5")).toBe("blitz");
    // 1+10 -> 1*60 + 10*40 = 460 -> blitz, NOT bullet
    expect(categoryFromTimeControl("1+10")).toBe("blitz");
  });
});

describe("computeGlicko2", () => {
  it("increases rating after a win against an equal opponent", () => {
    const r = computeGlicko2(1500, 350, 0.06, 1500, 350, 1);
    expect(r.rating).toBeGreaterThan(1500);
    expect(r.change).toBeGreaterThan(0);
  });

  it("decreases rating after a loss against an equal opponent", () => {
    const r = computeGlicko2(1500, 350, 0.06, 1500, 350, 0);
    expect(r.rating).toBeLessThan(1500);
    expect(r.change).toBeLessThan(0);
  });

  it("draw against equal opponent leaves rating roughly unchanged (small RD shrink ok)", () => {
    const r = computeGlicko2(1500, 350, 0.06, 1500, 350, 0.5);
    expect(Math.abs(r.change)).toBeLessThan(1);
  });

  it("rounds rating and rd to one decimal and volatility to six decimals", () => {
    const r = computeGlicko2(1500, 350, 0.06, 1500, 350, 1);
    // Using *10 then round-trip - verify at most one decimal place.
    expect(Math.abs(r.rating - Math.round(r.rating * 10) / 10)).toBeLessThan(1e-9);
    expect(Math.abs(r.rd - Math.round(r.rd * 10) / 10)).toBeLessThan(1e-9);
    expect(Math.abs(r.volatility - Math.round(r.volatility * 1e6) / 1e6)).toBeLessThan(1e-12);
  });

  it("a win against a much stronger opponent is rewarded more than against a much weaker one", () => {
    const winVsStrong = computeGlicko2(1500, 100, 0.06, 1900, 100, 1);
    const winVsWeak   = computeGlicko2(1500, 100, 0.06, 1100, 100, 1);
    expect(winVsStrong.change).toBeGreaterThan(winVsWeak.change);
  });

  it("rating deviation tightens (drops) after any played game", () => {
    const r = computeGlicko2(1500, 350, 0.06, 1500, 350, 0.5);
    expect(r.rd).toBeLessThan(350);
  });
});
