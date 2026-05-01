import { describe, it, expect, beforeEach } from "vitest";
import {
  pushVisualError,
  getVisualErrors,
  subscribeToVisualErrors,
  clearVisualErrors,
} from "./visuals-error-buffer";

const ROOM = "00000000-0000-0000-0000-000000000001";
const ROOM_B = "00000000-0000-0000-0000-000000000002";

beforeEach(() => {
  clearVisualErrors(ROOM);
  clearVisualErrors(ROOM_B);
});

describe("visuals-error-buffer", () => {
  it("starts empty for a room that's never been pushed to", () => {
    expect(getVisualErrors(ROOM)).toEqual([]);
  });

  it("captures slot, message, stack, ply on push", () => {
    pushVisualError(ROOM, {
      slot: "q.aura",
      message: "ctx.fillStyle is not a function",
      stack: "at __draw__ line 3",
      ply: 12,
    });
    const errs = getVisualErrors(ROOM);
    expect(errs.length).toBe(1);
    expect(errs[0].slot).toBe("q.aura");
    expect(errs[0].message).toBe("ctx.fillStyle is not a function");
    expect(errs[0].stack).toBe("at __draw__ line 3");
    expect(errs[0].ply).toBe(12);
    expect(typeof errs[0].at).toBe("number");
  });

  it("returns the SAME snapshot reference until the store changes", () => {
    pushVisualError(ROOM, { slot: "x", message: "y" });
    const a = getVisualErrors(ROOM);
    const b = getVisualErrors(ROOM);
    // useSyncExternalStore requires stable snapshots. Returning
    // a fresh array on each get causes React error #185.
    expect(a).toBe(b);
  });

  it("returns a new snapshot reference only after a mutation", () => {
    pushVisualError(ROOM, { slot: "x", message: "y" });
    const before = getVisualErrors(ROOM);
    pushVisualError(ROOM, { slot: "z", message: "w" });
    const after = getVisualErrors(ROOM);
    expect(after).not.toBe(before);
    expect(after.length).toBe(2);
  });

  it("normalizes missing fields to defaults", () => {
    pushVisualError(ROOM, {});
    const errs = getVisualErrors(ROOM);
    expect(errs[0].slot).toBe("unknown");
    expect(errs[0].message).toBe("");
    expect(errs[0].stack).toBe("");
    expect(errs[0].ply).toBe(null);
  });

  it("caps the buffer at 32 entries (FIFO drops oldest)", () => {
    for (let i = 0; i < 50; i++) {
      pushVisualError(ROOM, { slot: `s.${i}`, message: `m${i}` });
    }
    const errs = getVisualErrors(ROOM);
    expect(errs.length).toBe(32);
    // Oldest 18 should be gone; we should see s.18 ... s.49.
    expect(errs[0].slot).toBe("s.18");
    expect(errs[31].slot).toBe("s.49");
  });

  it("isolates buffers across rooms", () => {
    pushVisualError(ROOM, { slot: "a", message: "for room A" });
    pushVisualError(ROOM_B, { slot: "b", message: "for room B" });
    expect(getVisualErrors(ROOM).length).toBe(1);
    expect(getVisualErrors(ROOM_B).length).toBe(1);
    expect(getVisualErrors(ROOM)[0].slot).toBe("a");
    expect(getVisualErrors(ROOM_B)[0].slot).toBe("b");
  });

  it("notifies subscribers on push", () => {
    let calls = 0;
    const unsub = subscribeToVisualErrors(ROOM, () => { calls++; });
    pushVisualError(ROOM, { slot: "x", message: "y" });
    pushVisualError(ROOM, { slot: "z", message: "w" });
    expect(calls).toBe(2);
    unsub();
    pushVisualError(ROOM, { slot: "after-unsub", message: "" });
    expect(calls).toBe(2);
  });

  it("subscribers for room A are not notified when room B pushes", () => {
    let aCalls = 0;
    let bCalls = 0;
    subscribeToVisualErrors(ROOM, () => { aCalls++; });
    subscribeToVisualErrors(ROOM_B, () => { bCalls++; });
    pushVisualError(ROOM_B, { slot: "x", message: "" });
    expect(aCalls).toBe(0);
    expect(bCalls).toBe(1);
  });

  it("clearVisualErrors empties the buffer for that room only", () => {
    pushVisualError(ROOM, { slot: "x", message: "" });
    pushVisualError(ROOM_B, { slot: "y", message: "" });
    clearVisualErrors(ROOM);
    expect(getVisualErrors(ROOM)).toEqual([]);
    expect(getVisualErrors(ROOM_B).length).toBe(1);
  });

  it("clearVisualErrors notifies subscribers and returns a stable empty snapshot", () => {
    let calls = 0;
    subscribeToVisualErrors(ROOM, () => { calls++; });
    pushVisualError(ROOM, { slot: "x", message: "" });
    expect(calls).toBe(1);
    clearVisualErrors(ROOM);
    expect(calls).toBe(2);
    const a = getVisualErrors(ROOM);
    const b = getVisualErrors(ROOM);
    expect(a).toBe(b);
    expect(a).toEqual([]);
  });

  it("ignores pushes with no roomId (defensive)", () => {
    pushVisualError(null, { slot: "x", message: "y" });
    pushVisualError(undefined, { slot: "x", message: "y" });
    pushVisualError("", { slot: "x", message: "y" });
    expect(getVisualErrors(ROOM)).toEqual([]);
  });

  it("subscribe with no listener or no roomId returns a no-op unsubscribe", () => {
    const u1 = subscribeToVisualErrors(null, () => {});
    const u2 = subscribeToVisualErrors(ROOM, null);
    expect(typeof u1).toBe("function");
    expect(typeof u2).toBe("function");
    expect(() => u1()).not.toThrow();
    expect(() => u2()).not.toThrow();
  });

  it("a throwing subscriber doesn't break other subscribers", () => {
    let goodCalls = 0;
    subscribeToVisualErrors(ROOM, () => { throw new Error("nope"); });
    subscribeToVisualErrors(ROOM, () => { goodCalls++; });
    pushVisualError(ROOM, { slot: "x", message: "" });
    expect(goodCalls).toBe(1);
  });
});
