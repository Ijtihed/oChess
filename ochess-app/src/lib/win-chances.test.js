import { describe, it, expect } from "vitest";
import {
  K,
  WC_INACCURACY,
  WC_MISTAKE,
  WC_BLUNDER,
  winningChances,
  winPercent,
  mateToCp,
  scoreToCp,
  winChancesLoss,
  classifyByWcLoss,
  lossFromScores,
} from "./win-chances";

// Tolerance for the floating-point sigmoid output. Lichess's PR
// #5337 reviewer cited the 50/100/300 cp anchors below, so we
// pin the test against those exact values to catch any
// regression in the formula or the K constant.
const EPS = 1e-3;

describe("winningChances - Lichess sigmoid formula", () => {
  it("returns 0 at exactly equal evaluation", () => {
    expect(winningChances(0)).toBe(0);
  });

  it("approaches +1 for runaway white advantage", () => {
    expect(winningChances(2000)).toBeGreaterThan(0.998);
    expect(winningChances(2000)).toBeLessThanOrEqual(1.0);
  });

  it("approaches -1 for runaway black advantage", () => {
    expect(winningChances(-2000)).toBeLessThan(-0.998);
    expect(winningChances(-2000)).toBeGreaterThanOrEqual(-1.0);
  });

  it("is symmetric around 0", () => {
    expect(winningChances(150)).toBeCloseTo(-winningChances(-150), 6);
    expect(winningChances(450)).toBeCloseTo(-winningChances(-450), 6);
  });

  it("matches the Lichess production anchor values (k = -0.00368208)", () => {
    // PR #5337's review cited 0.100 / 0.197 / 0.537 but those were
    // computed with the OLD coefficient k = -0.004. PR #11148
    // refit k to -0.00368208 against real Lichess game data,
    // which moves the anchors to the values below. Don't drift
    // off these without first re-fitting against an updated
    // dataset and updating every threshold downstream.
    expect(winningChances(50)).toBeGreaterThan(0.0918 - EPS);
    expect(winningChances(50)).toBeLessThan(0.0918 + EPS);
    expect(winningChances(100)).toBeGreaterThan(0.182 - EPS);
    expect(winningChances(100)).toBeLessThan(0.182 + EPS);
    expect(winningChances(300)).toBeGreaterThan(0.502 - EPS);
    expect(winningChances(300)).toBeLessThan(0.502 + EPS);
  });

  it("exposes the canonical Lichess regression coefficient", () => {
    // PR #11148 fitted k = -0.00368208. Don't change without
    // re-fitting against an updated dataset (and updating
    // every threshold downstream).
    expect(K).toBeCloseTo(0.00368208, 8);
  });

  it("clamps absurd cp inputs so the exponential can't blow up", () => {
    // 1e9 cp shouldn't return Infinity or NaN.
    const ridiculous = winningChances(1_000_000_000);
    expect(Number.isFinite(ridiculous)).toBe(true);
    expect(ridiculous).toBeGreaterThan(0.999);
  });
});

describe("winPercent - 0..100 white-POV percentage", () => {
  it("is 50 at equal evaluation", () => {
    expect(winPercent(0)).toBe(50);
  });

  it("matches the canonical anchors (production k = -0.00368208)", () => {
    // 50 cp ≈ 50% + 50% * 0.0918 = 54.59%
    expect(winPercent(50)).toBeGreaterThan(54.55);
    expect(winPercent(50)).toBeLessThan(54.65);
    // 100 cp ≈ 50% + 50% * 0.182 = 59.10%
    expect(winPercent(100)).toBeGreaterThan(59.05);
    expect(winPercent(100)).toBeLessThan(59.15);
  });
});

describe("mateToCp / scoreToCp", () => {
  it("converts mate-in-N into a saturated cp value", () => {
    expect(mateToCp(1)).toBeGreaterThan(900);
    expect(mateToCp(-1)).toBeLessThan(-900);
  });

  it("gives faster mates a slightly higher magnitude than slower", () => {
    expect(mateToCp(1)).toBeGreaterThan(mateToCp(20));
    expect(mateToCp(-1)).toBeLessThan(mateToCp(-20));
  });

  it("returns 0 for non-mate / non-finite", () => {
    expect(mateToCp(undefined)).toBe(0);
    expect(mateToCp(NaN)).toBe(0);
    expect(mateToCp(0)).toBe(0);
  });

  it("scoreToCp prefers mate over cp when both present", () => {
    expect(scoreToCp({ cp: 100, mate: 2 })).toBeGreaterThan(900);
  });

  it("scoreToCp falls through to cp when no mate", () => {
    expect(scoreToCp({ cp: 50 })).toBe(50);
  });

  it("scoreToCp returns null for missing/invalid input", () => {
    expect(scoreToCp(null)).toBeNull();
    expect(scoreToCp({})).toBeNull();
    expect(scoreToCp({ cp: "wat" })).toBeNull();
  });
});

describe("winChancesLoss - POV-aware delta", () => {
  it("returns positive loss when white blunders", () => {
    // White goes from +50 cp to -300 cp by playing a blunder.
    const loss = winChancesLoss(50, -300, "w");
    expect(loss).toBeGreaterThan(WC_BLUNDER);
  });

  it("returns positive loss when black blunders", () => {
    // Black blunders: cp goes from -50 (good for black) to +300 (good for white).
    const loss = winChancesLoss(-50, 300, "b");
    expect(loss).toBeGreaterThan(WC_BLUNDER);
  });

  it("returns negative (gain) when the side actually improved their position", () => {
    // White improved their position from +50 to +200.
    const loss = winChancesLoss(50, 200, "w");
    expect(loss).toBeLessThan(0);
  });

  it("returns zero for unchanged evaluation", () => {
    expect(winChancesLoss(120, 120, "w")).toBeCloseTo(0, 9);
  });

  it("returns null when either eval is missing", () => {
    expect(winChancesLoss(null, 100, "w")).toBeNull();
    expect(winChancesLoss(100, null, "w")).toBeNull();
  });

  it("treats a 100 cp swing from equal as ~0.182 winning-chances loss", () => {
    // Anchor: 0 cp -> -100 cp from white's POV. With current
    // production k, wc(0)=0 -> wc(-100)≈-0.182. From white's POV
    // (mover=w, sign=+1) loss = 0 - (-0.182) = 0.182. Sits just
    // below the 0.20 mistake cutoff = inaccuracy band.
    const loss = winChancesLoss(0, -100, "w");
    expect(loss).toBeGreaterThan(0.181);
    expect(loss).toBeLessThan(0.183);
    expect(classifyByWcLoss(loss)).toBe("inaccuracy");
  });
});

describe("classifyByWcLoss - Lichess-style judgement", () => {
  it("returns null for clean moves (loss < inaccuracy threshold)", () => {
    expect(classifyByWcLoss(0.05)).toBeNull();
    expect(classifyByWcLoss(0)).toBeNull();
    expect(classifyByWcLoss(-0.20)).toBeNull(); // gains never get a "?" tag
  });

  it("classifies inaccuracies in the [0.1, 0.2) band", () => {
    expect(classifyByWcLoss(WC_INACCURACY)).toBe("inaccuracy");
    expect(classifyByWcLoss(0.15)).toBe("inaccuracy");
    expect(classifyByWcLoss(0.199)).toBe("inaccuracy");
  });

  it("classifies mistakes in the [0.2, 0.3) band", () => {
    expect(classifyByWcLoss(WC_MISTAKE)).toBe("mistake");
    expect(classifyByWcLoss(0.25)).toBe("mistake");
    expect(classifyByWcLoss(0.299)).toBe("mistake");
  });

  it("classifies blunders for any loss >= 0.3", () => {
    expect(classifyByWcLoss(WC_BLUNDER)).toBe("blunder");
    expect(classifyByWcLoss(0.5)).toBe("blunder");
    expect(classifyByWcLoss(1.0)).toBe("blunder");
  });

  it("rejects NaN / non-finite inputs", () => {
    expect(classifyByWcLoss(NaN)).toBeNull();
    expect(classifyByWcLoss(undefined)).toBeNull();
    expect(classifyByWcLoss("0.5")).toBeNull();
  });
});

describe("lossFromScores - end-to-end from Stockfish scores", () => {
  it("classifies a 0 cp -> -150 cp white move as a mistake", () => {
    // White was equal, played a move that left them down 1.5
    // pawns. wc(0)=0 -> wc(-150)≈-0.27 -> loss ≈ 0.27 -> mistake.
    const loss = lossFromScores({ cp: 0 }, { cp: -150 }, "w");
    expect(classifyByWcLoss(loss)).toBe("mistake");
  });

  it("classifies a -50 cp -> -350 cp white move as a blunder", () => {
    // Slightly worse to clearly losing - eval went from "I have
    // a half-pawn deficit" to "I'm probably losing this". On
    // the wc curve the swing is ~0.48, well above the blunder
    // threshold.
    const loss = lossFromScores({ cp: -50 }, { cp: -350 }, "w");
    expect(classifyByWcLoss(loss)).toBe("blunder");
  });

  it("classifies missing-mate (mate-in-N -> equal) as a blunder", () => {
    // White had mate-in-3 and played a move that gave it up.
    const loss = lossFromScores({ mate: 3 }, { cp: 0 }, "w");
    expect(classifyByWcLoss(loss)).toBe("blunder");
  });

  it("classifies hanging-mate (equal -> getting mated) as a blunder", () => {
    // Position was equal, then we walked into mate-in-2.
    const loss = lossFromScores({ cp: 0 }, { mate: -2 }, "w");
    expect(classifyByWcLoss(loss)).toBe("blunder");
  });

  it("classifies a small drop (-100 -> -200 cp) as inaccuracy", () => {
    const loss = lossFromScores({ cp: -100 }, { cp: -200 }, "w");
    expect(classifyByWcLoss(loss)).toBe("inaccuracy");
  });

  it("does not punish making the eval slightly worse in an already-lost position", () => {
    // Already losing -600 cp, now -800 cp. Lichess weights
    // this much less than -50 -> -250 (which would be a
    // mistake). The whole point of wc-based judging.
    const loss = lossFromScores({ cp: -600 }, { cp: -800 }, "w");
    expect(loss).toBeLessThan(WC_INACCURACY);
    expect(classifyByWcLoss(loss)).toBeNull();
  });
});
