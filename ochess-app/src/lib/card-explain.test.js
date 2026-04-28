import { describe, it, expect } from "vitest";
import { explainCard } from "./card-explain";

describe("explainCard - empty / fallback", () => {
  it("returns empty string for null / undefined card", () => {
    expect(explainCard(null)).toBe("");
    expect(explainCard(undefined)).toBe("");
    expect(explainCard({})).toBe("");
  });

  it("prefers writer-supplied answerText over the templated explanation", () => {
    const card = {
      type: "mistake",
      played_san: "Bxh7",
      best_san: "Nxd5",
      eval_loss_cp: 350,
      themes: ["blunder"],
      answerText: "Hand-written coach note",
    };
    expect(explainCard(card)).toBe("Hand-written coach note");
  });

  it("prefers notes over the templated explanation", () => {
    const card = {
      type: "analysis",
      notes: "Look at the f7 weakness",
    };
    expect(explainCard(card)).toBe("Look at the f7 weakness");
  });
});

describe("explainCard - mistake cards", () => {
  it("opens with what was played + the loss in pawns", () => {
    const card = {
      type: "mistake",
      played_san: "Bxh7",
      best_san: "Nxd5",
      eval_loss_cp: 350,
      themes: ["blunder"],
      phase: "middlegame",
    };
    const out = explainCard(card);
    expect(out).toMatch(/You played Bxh7/);
    expect(out).toMatch(/blunder|3\.5 pawns|3\.5 pawn/);
    expect(out).toMatch(/Nxd5/);
  });

  it("frames missed_mate cards with forced-mate language", () => {
    const card = {
      type: "mistake",
      played_san: "h3",
      best_san: "Qxh7#",
      eval_loss_cp: 1000,
      themes: ["missed_mate", "blunder"],
    };
    expect(explainCard(card)).toMatch(/forced mate|forcing checks/i);
  });

  it("frames hanging_queen cards with queen-safety language", () => {
    const card = {
      type: "mistake",
      played_san: "Qd5",
      best_san: "Qd1",
      eval_loss_cp: 800,
      themes: ["hanging_queen", "blunder"],
    };
    expect(explainCard(card)).toMatch(/queen safe|queen attacks/i);
  });

  it("frames hanging_knight cards with minor-piece language", () => {
    const card = {
      type: "mistake",
      played_san: "Nf3",
      best_san: "Ne5",
      eval_loss_cp: 350,
      themes: ["hanging_knight"],
    };
    expect(explainCard(card)).toMatch(/knight/i);
  });

  it("frames missed_capture cards with material-capture language", () => {
    const card = {
      type: "mistake",
      played_san: "h3",
      best_san: "Nxe5",
      eval_loss_cp: 200,
      themes: ["missed_capture"],
    };
    expect(explainCard(card)).toMatch(/material|undefended|free/i);
  });

  it("appends opening + phase context when both are available", () => {
    const card = {
      type: "mistake",
      played_san: "h3",
      best_san: "Nf3",
      eval_loss_cp: 200,
      themes: ["mistake"],
      phase: "middlegame",
      opening: "Italian Game",
    };
    expect(explainCard(card)).toMatch(/Italian Game/);
    expect(explainCard(card)).toMatch(/middlegame/);
  });

  it("survives a card with only played_san + best_san (no eval, no themes)", () => {
    const card = {
      type: "mistake",
      played_san: "h3",
      best_san: "Nf3",
    };
    const out = explainCard(card);
    expect(out).toMatch(/h3/);
    expect(out).toMatch(/Nf3/);
  });
});

describe("explainCard - puzzle cards", () => {
  it("acknowledges the solve and surfaces themes + rating when available", () => {
    const card = {
      type: "puzzle",
      rating: 1500,
      themes: ["fork", "knight"],
    };
    const out = explainCard(card);
    expect(out).toMatch(/Solved/i);
    expect(out).toMatch(/1500/);
    expect(out).toMatch(/fork/);
  });

  it("works for a puzzle with no rating or themes", () => {
    expect(explainCard({ type: "puzzle" })).toMatch(/Solved/i);
  });
});

describe("explainCard - severity bucketing", () => {
  it("calls a 600cp loss decisive", () => {
    const card = { type: "mistake", played_san: "Bxh7", best_san: "Nxd5", eval_loss_cp: 600, themes: ["blunder"] };
    expect(explainCard(card)).toMatch(/decisive/i);
  });

  it("calls a 350cp loss a blunder", () => {
    const card = { type: "mistake", played_san: "Bxh7", best_san: "Nxd5", eval_loss_cp: 350, themes: ["blunder"] };
    expect(explainCard(card)).toMatch(/blunder/i);
  });

  it("doesn't say 'blunder' for a 150cp mistake", () => {
    const card = { type: "mistake", played_san: "h3", best_san: "Nf3", eval_loss_cp: 150, themes: ["mistake"] };
    expect(explainCard(card)).not.toMatch(/blunder/i);
  });
});
