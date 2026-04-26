import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import useClock, { formatTime } from "./useClock";

describe("formatTime", () => {
  it("returns 0:00 for null/undefined", () => {
    expect(formatTime(null)).toBe("0:00");
    expect(formatTime(undefined)).toBe("0:00");
  });

  it("returns 0:00 for zero or negative", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(-100)).toBe("0:00");
  });

  it("formats seconds correctly", () => {
    expect(formatTime(5000)).toBe("0:05");
    expect(formatTime(59000)).toBe("0:59");
  });

  it("formats minutes and seconds", () => {
    expect(formatTime(60000)).toBe("1:00");
    expect(formatTime(90000)).toBe("1:30");
    expect(formatTime(600000)).toBe("10:00");
  });

  it("rounds up partial seconds", () => {
    expect(formatTime(1500)).toBe("0:02");
    expect(formatTime(100)).toBe("0:01");
  });
});

describe("useClock — hook behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T20:00:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("starts with both sides at initialMs and no timedOut", () => {
    const { result } = renderHook(() => useClock(60_000, 2_000));
    expect(result.current.display.white).toBe(60_000);
    expect(result.current.display.black).toBe(60_000);
    expect(result.current.timedOut).toBeNull();
  });

  it("ticks down the active side after start()", () => {
    const { result } = renderHook(() => useClock(60_000));
    act(() => { result.current.start("w"); });
    act(() => { vi.advanceTimersByTime(500); });
    // After 500ms, the active (white) side has been debited; black is unchanged.
    expect(result.current.display.white).toBeLessThan(60_000);
    expect(result.current.display.white).toBeGreaterThan(59_000);
    expect(result.current.display.black).toBe(60_000);
  });

  it("switchSide debits the elapsed time and credits the increment to the side that just moved", () => {
    const { result } = renderHook(() => useClock(60_000, 2_000));
    act(() => { result.current.start("w"); });
    act(() => { vi.advanceTimersByTime(1_000); });
    act(() => { result.current.switchSide(); });
    // White spent ~1s and was credited 2s of increment -> ~61_000.
    expect(result.current.display.white).toBeGreaterThan(60_500);
    expect(result.current.display.white).toBeLessThanOrEqual(61_000);
    // Now black is on the clock; advancing time burns black's clock,
    // not white's.
    act(() => { vi.advanceTimersByTime(800); });
    expect(result.current.display.black).toBeLessThan(60_000);
  });

  it("stop() freezes both sides at their current remaining time", () => {
    const { result } = renderHook(() => useClock(60_000));
    act(() => { result.current.start("w"); });
    act(() => { vi.advanceTimersByTime(2_000); });
    act(() => { result.current.stop(); });
    const frozen = result.current.display.white;
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(result.current.display.white).toBe(frozen);
  });

  it("flags timedOut='w' when white runs out and stops ticking", () => {
    const { result } = renderHook(() => useClock(1_000));
    act(() => { result.current.start("w"); });
    act(() => { vi.advanceTimersByTime(1_500); });
    expect(result.current.timedOut).toBe("w");
    expect(result.current.display.white).toBe(0);
    // Continuing to advance should not flip the flag or further
    // mutate the values.
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(result.current.timedOut).toBe("w");
    expect(result.current.display.black).toBe(1_000);
  });

  it("flags timedOut='b' for black when black runs out", () => {
    const { result } = renderHook(() => useClock(1_000));
    act(() => { result.current.start("b"); });
    act(() => { vi.advanceTimersByTime(1_500); });
    expect(result.current.timedOut).toBe("b");
  });

  it("restore(wMs, bMs) sets both sides and clears timedOut", () => {
    const { result } = renderHook(() => useClock(1_000));
    act(() => { result.current.start("w"); });
    act(() => { vi.advanceTimersByTime(1_500); });
    expect(result.current.timedOut).toBe("w");
    act(() => { result.current.restore(30_000, 45_000); });
    expect(result.current.display.white).toBe(30_000);
    expect(result.current.display.black).toBe(45_000);
    expect(result.current.timedOut).toBeNull();
  });

  it("reset(ms) sets both sides equal and clears timedOut", () => {
    const { result } = renderHook(() => useClock(1_000));
    act(() => { result.current.start("w"); });
    act(() => { vi.advanceTimersByTime(1_500); });
    act(() => { result.current.reset(120_000); });
    expect(result.current.display.white).toBe(120_000);
    expect(result.current.display.black).toBe(120_000);
    expect(result.current.timedOut).toBeNull();
  });

  it("does not start the interval when initialMs is falsy (unlimited time)", () => {
    const { result } = renderHook(() => useClock(0));
    act(() => { result.current.start("w"); });
    act(() => { vi.advanceTimersByTime(5_000); });
    // No interval scheduled, so the display values stay at 0/0 and
    // timedOut never flips.
    expect(result.current.display.white).toBe(0);
    expect(result.current.timedOut).toBeNull();
  });
});
