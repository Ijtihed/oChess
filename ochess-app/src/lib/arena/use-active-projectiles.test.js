/**
 * Tests for the projectile timeline hook.
 *
 * Two things to verify:
 *   1. fireProjectile pushes a new entry that's immediately
 *      visible in the projectiles snapshot.
 *   2. The entry's progress advances toward 1 over its TTL,
 *      then the entry is dropped.
 *
 * We use vitest's fake timers + manual RAF stub to step time
 * deterministically. The hook's internal RAF loop ordinarily
 * runs at display refresh rate; under fake timers we drive it
 * by advancing the fake performance.now and tickling the RAF
 * queue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useActiveProjectiles } from "./use-active-projectiles";

let nowMs;
let rafQueue;
let originalNow;
let originalRAF;
let originalCAF;

beforeEach(() => {
  nowMs = 1000;
  rafQueue = [];
  originalNow = performance.now;
  originalRAF = globalThis.requestAnimationFrame;
  originalCAF = globalThis.cancelAnimationFrame;
  performance.now = () => nowMs;
  globalThis.requestAnimationFrame = (cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  globalThis.cancelAnimationFrame = (id) => {
    rafQueue[id - 1] = null;
  };
});

afterEach(() => {
  performance.now = originalNow;
  globalThis.requestAnimationFrame = originalRAF;
  globalThis.cancelAnimationFrame = originalCAF;
});

/** Advance the fake clock by `ms` and flush the RAF queue. */
function tick(ms) {
  nowMs += ms;
  // Snapshot, then run every queued callback. Each callback may
  // re-queue itself; keep going until quiescent or 50 iterations.
  for (let i = 0; i < 50; i++) {
    const q = rafQueue.slice();
    rafQueue.length = 0;
    if (q.every((cb) => !cb)) break;
    for (const cb of q) {
      if (cb) cb(nowMs);
    }
    if (rafQueue.length === 0) break;
  }
}

describe("useActiveProjectiles", () => {
  it("starts with an empty projectiles list", () => {
    const { result } = renderHook(() => useActiveProjectiles());
    expect(result.current.projectiles).toEqual([]);
  });

  it("fireProjectile pushes a new entry visible in the next snapshot", () => {
    const { result } = renderHook(() => useActiveProjectiles());
    act(() => {
      result.current.fireProjectile("e2", "e4", "fireball", 400);
    });
    expect(result.current.projectiles.length).toBe(1);
    const p = result.current.projectiles[0];
    expect(p.from).toBe("e2");
    expect(p.to).toBe("e4");
    expect(p.kind).toBe("fireball");
    expect(p.ttl).toBe(400);
    expect(p.progress).toBe(0);
  });

  it("advances progress over time and drops the entry after ttl", () => {
    const { result } = renderHook(() => useActiveProjectiles());
    act(() => {
      result.current.fireProjectile("a1", "h8", "snap", 300);
    });
    // At 100ms in (1/3 of ttl), progress should be ~0.33.
    act(() => { tick(100); });
    expect(result.current.projectiles.length).toBe(1);
    expect(result.current.projectiles[0].progress).toBeGreaterThan(0.3);
    expect(result.current.projectiles[0].progress).toBeLessThan(0.4);
    // After full ttl, the entry is dropped on the next tick.
    act(() => { tick(300); });
    expect(result.current.projectiles).toEqual([]);
  });

  it("clamps ttl to a sane range", () => {
    const { result } = renderHook(() => useActiveProjectiles());
    act(() => {
      result.current.fireProjectile("e2", "e4", "x", 1);     // below floor (50)
      result.current.fireProjectile("a1", "h8", "y", 99999); // above ceiling (2000)
    });
    const ps = result.current.projectiles;
    expect(ps[0].ttl).toBe(50);
    expect(ps[1].ttl).toBe(2000);
  });

  it("rejects invalid square strings without crashing", () => {
    const { result } = renderHook(() => useActiveProjectiles());
    act(() => {
      result.current.fireProjectile(null, "e4", "x");
      result.current.fireProjectile("e2", undefined, "x");
      result.current.fireProjectile("longer", "e4", "x");
      result.current.fireProjectile("e2", "longer", "x");
    });
    expect(result.current.projectiles).toEqual([]);
  });

  it("clearProjectiles empties the list", () => {
    const { result } = renderHook(() => useActiveProjectiles());
    act(() => {
      result.current.fireProjectile("e2", "e4", "x", 500);
      result.current.fireProjectile("e7", "e5", "x", 500);
    });
    expect(result.current.projectiles.length).toBe(2);
    act(() => { result.current.clearProjectiles(); });
    expect(result.current.projectiles).toEqual([]);
  });

  it("supports multiple in-flight projectiles independently", () => {
    const { result } = renderHook(() => useActiveProjectiles());
    act(() => { result.current.fireProjectile("a1", "h8", "x", 300); });
    act(() => { tick(100); });
    act(() => { result.current.fireProjectile("b2", "g7", "x", 300); });
    // Now: first projectile is at progress ~0.33; second is at 0.
    expect(result.current.projectiles.length).toBe(2);
    const p0 = result.current.projectiles.find((p) => p.from === "a1");
    const p1 = result.current.projectiles.find((p) => p.from === "b2");
    expect(p0.progress).toBeGreaterThan(0.3);
    expect(p1.progress).toBe(0);
    // After 200 more ms: first hits 1.0 and gets dropped; second
    // is at ~0.66.
    act(() => { tick(200); });
    expect(result.current.projectiles.length).toBe(1);
    expect(result.current.projectiles[0].from).toBe("b2");
    expect(result.current.projectiles[0].progress).toBeGreaterThan(0.6);
  });

  it("defaults the kind to 'default' if omitted", () => {
    const { result } = renderHook(() => useActiveProjectiles());
    act(() => { result.current.fireProjectile("e2", "e4"); });
    expect(result.current.projectiles[0].kind).toBe("default");
  });
});
