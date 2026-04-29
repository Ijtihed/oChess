import { describe, it, expect } from "vitest";
import {
  STATUS,
  ROUND_CLOCK_MS,
  TIEBREAK_CLOCK_MS,
  colorFor,
  colorPairFor,
  buildRoundEntry,
  appendRound,
  scoreFromRounds,
  nextStatusAfterRound,
  resolveMatchWinner,
  finalizeMatch,
  isMatchDecidedEarly,
  clockBudgetFor,
  roundLabelFor,
} from "./orchestrator";

describe("orchestrator - color assignment", () => {
  it("creator plays Black in round 1, joiner plays White", () => {
    expect(colorFor("creator", STATUS.ROUND_1)).toBe("b");
    expect(colorFor("joiner",  STATUS.ROUND_1)).toBe("w");
  });

  it("colors flip in round 2", () => {
    expect(colorFor("creator", STATUS.ROUND_2)).toBe("w");
    expect(colorFor("joiner",  STATUS.ROUND_2)).toBe("b");
  });

  it("tie-break uses round-1 shape (creator Black)", () => {
    expect(colorFor("creator", STATUS.TIEBREAK)).toBe("b");
    expect(colorFor("joiner",  STATUS.TIEBREAK)).toBe("w");
  });

  it("colorPairFor mirrors colorFor", () => {
    expect(colorPairFor(1)).toEqual({ creator: "b", joiner: "w" });
    expect(colorPairFor(2)).toEqual({ creator: "w", joiner: "b" });
    expect(colorPairFor("tiebreak")).toEqual({ creator: "b", joiner: "w" });
  });
});

describe("orchestrator - buildRoundEntry", () => {
  it("translates a Black-wins game status into the creator winning round 1", () => {
    const entry = buildRoundEntry({
      round: 1,
      gameStatus: { ended: true, winner: "b", reason: "checkmate" },
      finalFen: "8/8/8/8/8/8/8/4k2K w - - 0 1",
      plyCount: 30,
    });
    // Round 1: creator = Black, so a "b" win = creator winning.
    expect(entry.winner).toBe("creator");
    expect(entry.reason).toBe("checkmate");
    expect(entry.round).toBe(1);
  });

  it("flips correctly for round 2", () => {
    const entry = buildRoundEntry({
      round: 2,
      gameStatus: { ended: true, winner: "b", reason: "checkmate" },
      finalFen: "8/8/8/8/8/8/8/4k2K w - - 0 1",
      plyCount: 30,
    });
    // Round 2: joiner = Black, so a "b" win = joiner.
    expect(entry.winner).toBe("joiner");
  });

  it("a draw produces winner=null", () => {
    const entry = buildRoundEntry({
      round: 1,
      gameStatus: { ended: true, winner: null, reason: "stalemate" },
      finalFen: "8/8/8/8/8/8/8/4k2K w - - 0 1",
      plyCount: 30,
    });
    expect(entry.winner).toBe(null);
    expect(entry.reason).toBe("stalemate");
  });

  it("reasonOverride wins over the engine reason", () => {
    const entry = buildRoundEntry({
      round: 1,
      gameStatus: { ended: true, winner: "w", reason: "checkmate" },
      reasonOverride: "creator resigned",
      forcedWinnerColor: "w",
      finalFen: "x",
      plyCount: 5,
    });
    expect(entry.reason).toBe("creator resigned");
    expect(entry.winner).toBe("joiner"); // round 1: w = joiner
  });

  it("attaches clockSpent when supplied", () => {
    const entry = buildRoundEntry({
      round: 1,
      gameStatus: { ended: true, winner: "b", reason: "checkmate" },
      finalFen: "x",
      plyCount: 30,
      clockSpent: { creator: 120000, joiner: 240000 },
    });
    expect(entry.clockSpent).toEqual({ creator: 120000, joiner: 240000 });
  });
});

describe("orchestrator - appendRound + scoreFromRounds", () => {
  it("appending a creator win adds 1 to creator score", () => {
    const r = appendRound(null, {
      round: 1, winner: "creator", reason: "checkmate", endedAt: "x", finalFen: "y", plyCount: 1,
    });
    expect(r.score).toEqual({ creator: 1, joiner: 0 });
    expect(r.rounds).toHaveLength(1);
  });

  it("appending a joiner win adds 1 to joiner score", () => {
    const start = appendRound(null, { round: 1, winner: "creator", reason: "checkmate", endedAt: "x", finalFen: "y", plyCount: 1 });
    const r = appendRound(start, { round: 2, winner: "joiner", reason: "checkmate", endedAt: "x", finalFen: "y", plyCount: 1 });
    expect(r.score).toEqual({ creator: 1, joiner: 1 });
    expect(r.rounds).toHaveLength(2);
  });

  it("a draw splits 0.5 to each side", () => {
    const r = appendRound(null, { round: 1, winner: null, reason: "stalemate", endedAt: "x", finalFen: "y", plyCount: 1 });
    expect(r.score).toEqual({ creator: 0.5, joiner: 0.5 });
  });

  it("ignores duplicate calls for the same round", () => {
    const start = appendRound(null, { round: 1, winner: "creator", reason: "checkmate", endedAt: "x", finalFen: "y", plyCount: 1 });
    const dup = appendRound(start, { round: 1, winner: "joiner",  reason: "checkmate", endedAt: "x", finalFen: "y", plyCount: 1 });
    expect(dup.rounds).toHaveLength(1);
    expect(dup.score).toEqual({ creator: 1, joiner: 0 });
  });

  it("scoreFromRounds rebuilds the score from a list", () => {
    const score = scoreFromRounds([
      { round: 1, winner: "creator" },
      { round: 2, winner: "joiner" },
      { round: "tiebreak", winner: "creator" },
    ]);
    expect(score).toEqual({ creator: 2, joiner: 1 });
  });
});

describe("orchestrator - nextStatusAfterRound", () => {
  it("round_1 -> warmup_round_2", () => {
    const mr = appendRound(null, { round: 1, winner: "creator", reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 });
    expect(nextStatusAfterRound("round_1", mr)).toBe("warmup_round_2");
  });

  it("round_2 with split score -> tiebreak", () => {
    const mr = appendRound(
      appendRound(null, { round: 1, winner: "creator", reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 }),
      { round: 2, winner: "joiner", reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 },
    );
    expect(nextStatusAfterRound("round_2", mr)).toBe("tiebreak");
  });

  it("round_2 with one player up 2-0 -> done", () => {
    const mr = appendRound(
      appendRound(null, { round: 1, winner: "creator", reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 }),
      { round: 2, winner: "creator", reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 },
    );
    expect(nextStatusAfterRound("round_2", mr)).toBe("done");
  });

  it("tiebreak -> done", () => {
    const mr = appendRound(null, { round: "tiebreak", winner: "joiner", reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 });
    expect(nextStatusAfterRound("tiebreak", mr)).toBe("done");
  });
});

describe("orchestrator - resolveMatchWinner + finalizeMatch", () => {
  it("2-0 yields the leading player", () => {
    const mr = appendRound(
      appendRound(null, { round: 1, winner: "creator", reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 }),
      { round: 2, winner: "creator", reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 },
    );
    expect(resolveMatchWinner(mr)).toBe("creator");
  });

  it("1-1 with no tie-break is a draw at the resolver level (rare)", () => {
    const mr = appendRound(
      appendRound(null, { round: 1, winner: "creator", reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 }),
      { round: 2, winner: "joiner", reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 },
    );
    expect(resolveMatchWinner(mr)).toBe(null);
  });

  it("tie-break trumps round score", () => {
    const mr = [
      { round: 1, winner: "creator" },
      { round: 2, winner: "joiner" },
      { round: "tiebreak", winner: "joiner" },
    ].reduce((acc, r) => appendRound(acc, { ...r, reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 }), null);
    expect(resolveMatchWinner(mr)).toBe("joiner");
  });

  it("finalizeMatch stamps the winner field", () => {
    // After round 2 with creator up 2-0: finalize seals the
    // result so the UI can read match_result.winner directly.
    const mr = appendRound(
      appendRound(null, { round: 1, winner: "creator", reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 }),
      { round: 2, winner: "creator", reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 },
    );
    expect(finalizeMatch(mr).winner).toBe("creator");

    // After a tie-break draw the match is genuinely a draw.
    const drawMr = [
      { round: 1, winner: "creator" },
      { round: 2, winner: "joiner" },
      { round: "tiebreak", winner: null },
    ].reduce((acc, r) => appendRound(acc, { ...r, reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 }), null);
    expect(finalizeMatch(drawMr).winner).toBe(null);
  });

  it("isMatchDecidedEarly catches 2-0 before tie-break", () => {
    const decided = appendRound(
      appendRound(null, { round: 1, winner: "creator", reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 }),
      { round: 2, winner: "creator", reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 },
    );
    expect(isMatchDecidedEarly(decided)).toBe(true);

    const undecided = appendRound(null, { round: 1, winner: "creator", reason: "x", endedAt: "x", finalFen: "x", plyCount: 1 });
    expect(isMatchDecidedEarly(undecided)).toBe(false);
  });
});

describe("orchestrator - misc helpers", () => {
  it("clockBudgetFor matches the constants", () => {
    expect(clockBudgetFor(1)).toBe(ROUND_CLOCK_MS);
    expect(clockBudgetFor(2)).toBe(ROUND_CLOCK_MS);
    expect(clockBudgetFor("tiebreak")).toBe(TIEBREAK_CLOCK_MS);
  });

  it("roundLabelFor maps statuses to labels", () => {
    expect(roundLabelFor("round_1")).toBe(1);
    expect(roundLabelFor("round_2")).toBe(2);
    expect(roundLabelFor("tiebreak")).toBe("tiebreak");
    expect(roundLabelFor("warmup_round_1")).toBe(null);
  });
});
