import { describe, it, expect } from "vitest";
import { makeRandom } from "./seeded-prng";

describe("seeded-prng", () => {
  it("returns numbers in [0, 1)", () => {
    const r = makeRandom("test-seed");
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("is deterministic for the same seed", () => {
    const r1 = makeRandom("match-abc-123");
    const r2 = makeRandom("match-abc-123");
    const seq1 = Array.from({ length: 10 }, () => r1());
    const seq2 = Array.from({ length: 10 }, () => r2());
    expect(seq1).toEqual(seq2);
  });

  it("produces different sequences for different seeds", () => {
    const r1 = makeRandom("match-A");
    const r2 = makeRandom("match-B");
    const seq1 = Array.from({ length: 10 }, () => r1());
    const seq2 = Array.from({ length: 10 }, () => r2());
    expect(seq1).not.toEqual(seq2);
  });

  it("handles empty / null / undefined seeds without crashing", () => {
    expect(() => makeRandom("")()).not.toThrow();
    expect(() => makeRandom(null)()).not.toThrow();
    expect(() => makeRandom(undefined)()).not.toThrow();
  });

  it("produces a roughly uniform distribution (chi-square sanity)", () => {
    const r = makeRandom("uniform-test");
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++) {
      const idx = Math.floor(r() * 10);
      buckets[idx]++;
    }
    // Each bucket should be ~1000. Allow 850-1150 (15% slop is
    // very generous; xoshiro is much tighter than this).
    for (const b of buckets) {
      expect(b).toBeGreaterThan(850);
      expect(b).toBeLessThan(1150);
    }
  });

  it("doesn't degenerate to constant zero (the all-zero-state risk)", () => {
    // An obscure seed that hashes to all zeros would lock the
    // PRNG. We have a safeguard; verify it.
    const r = makeRandom("\0\0\0\0");
    const seq = Array.from({ length: 20 }, () => r());
    const allSame = seq.every((v) => v === seq[0]);
    expect(allSame).toBe(false);
  });
});
