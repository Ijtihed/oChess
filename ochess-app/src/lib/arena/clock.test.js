import { describe, it, expect } from "vitest";
import {
  initClock,
  initRoundClock,
  initTiebreakClock,
  clockSnapshot,
  commitMove,
  pauseClock,
  formatClock,
} from "./clock";
import { ROUND_CLOCK_MS, TIEBREAK_CLOCK_MS } from "./orchestrator";

describe("clock - init", () => {
  it("the first mover gets a turnStartedAtMs stamp", () => {
    const c = initClock("creator", 60_000, 1000);
    expect(c.budgetMs).toBe(60_000);
    expect(c.creator.turnStartedAtMs).toBe(1000);
    expect(c.joiner.spentMs).toBe(0);
    expect(c.joiner.turnStartedAtMs).toBeUndefined();
  });

  it("round / tiebreak presets set the right budgets", () => {
    const r = initRoundClock("creator", 0);
    const t = initTiebreakClock("joiner", 0);
    expect(r.budgetMs).toBe(ROUND_CLOCK_MS);
    expect(t.budgetMs).toBe(TIEBREAK_CLOCK_MS);
  });
});

describe("clock - snapshot", () => {
  it("the running side accumulates time as wall clock advances", () => {
    const c = initClock("creator", 60_000, 1000);
    const snap = clockSnapshot(c, 4000); // 3 seconds later
    expect(snap.running).toBe("creator");
    expect(snap.creator.spentMs).toBe(3000);
    expect(snap.creator.remainingMs).toBe(57_000);
    expect(snap.joiner.spentMs).toBe(0);
    expect(snap.joiner.remainingMs).toBe(60_000);
  });

  it("expired flag flips when remaining hits zero", () => {
    const c = initClock("creator", 5_000, 1000);
    const snap = clockSnapshot(c, 7000); // 6 seconds elapsed > 5s budget
    expect(snap.creator.expired).toBe(true);
    expect(snap.creator.remainingMs).toBe(0);
  });

  it("paused side doesn't accumulate", () => {
    const c = { budgetMs: 60_000, creator: { spentMs: 10_000 }, joiner: { spentMs: 5_000 } };
    const snap = clockSnapshot(c, 99_999_999);
    expect(snap.running).toBe(null);
    expect(snap.creator.spentMs).toBe(10_000);
    expect(snap.joiner.spentMs).toBe(5_000);
  });

  it("clamps spent to the budget so display doesn't go negative", () => {
    const c = initClock("creator", 5_000, 0);
    const snap = clockSnapshot(c, 999_999);
    expect(snap.creator.spentMs).toBe(5_000);
    expect(snap.creator.remainingMs).toBe(0);
  });
});

describe("clock - commitMove", () => {
  it("commits the mover's accumulated time and starts the opponent", () => {
    const c = initClock("creator", 60_000, 1000);
    const next = commitMove(c, "creator", { now: 4000 });
    // Creator's time is locked at 3 seconds spent, opponent now ticking.
    expect(next.creator.spentMs).toBe(3000);
    expect(next.creator.turnStartedAtMs).toBeUndefined();
    expect(next.joiner.turnStartedAtMs).toBe(4000);
  });

  it("subsequent commits accumulate per side", () => {
    let c = initClock("creator", 60_000, 1000);
    c = commitMove(c, "creator", { now: 3000 }); // creator spent 2000
    c = commitMove(c, "joiner",  { now: 7000 }); // joiner spent 4000
    c = commitMove(c, "creator", { now: 10000 }); // creator spent another 3000 = 5000
    expect(c.creator.spentMs).toBe(5000);
    expect(c.joiner.spentMs).toBe(4000);
    expect(c.joiner.turnStartedAtMs).toBe(10000);
  });

  it("endTurn:false commits the mover but doesn't start the opponent (round-end case)", () => {
    const c = initClock("creator", 60_000, 1000);
    const next = commitMove(c, "creator", { now: 4000, endTurn: false });
    expect(next.creator.spentMs).toBe(3000);
    expect(next.joiner.turnStartedAtMs).toBeUndefined();
  });
});

describe("clock - pause", () => {
  it("bakes the running side's elapsed into spentMs and clears all turnStartedAtMs", () => {
    const c = initClock("joiner", 60_000, 1000);
    const paused = pauseClock(c, 5000);
    expect(paused.joiner.spentMs).toBe(4000);
    expect(paused.joiner.turnStartedAtMs).toBeUndefined();
    expect(paused.creator.turnStartedAtMs).toBeUndefined();
  });
});

describe("clock - formatClock", () => {
  it("renders M:SS for under an hour", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(5_000)).toBe("0:05");
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(599_000)).toBe("9:59");
  });

  it("renders H:MM:SS for an hour or more", () => {
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(3_661_000)).toBe("1:01:01");
  });

  it("clamps non-finite / negative to 0", () => {
    expect(formatClock(-1000)).toBe("0:00");
    expect(formatClock(NaN)).toBe("0:00");
  });
});
