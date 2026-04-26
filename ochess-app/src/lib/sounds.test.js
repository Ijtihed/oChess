import { describe, it, expect, vi, beforeEach } from "vitest";

const playCalls = [];

vi.mock("howler", () => {
  class Howl {
    constructor(opts) { this.opts = opts; }
    volume() {}
    play() { playCalls.push(this.opts.src?.[0] || ""); }
    load() {}
  }
  return {
    Howl,
    Howler: { volume() {}, ctx: { state: "running", resume() {} } },
  };
});

beforeEach(() => {
  playCalls.length = 0;
});

describe("playMoveSound — choice of sound from the chess.js move object", () => {
  it("plays Checkmate.mp3 when SAN ends with #", async () => {
    const { playMoveSound } = await import("./sounds");
    playMoveSound({ san: "Qxh7#" });
    expect(playCalls.some((p) => p.includes("Checkmate"))).toBe(true);
  });

  it("plays Check.mp3 when SAN ends with + (and no mate)", async () => {
    const { playMoveSound } = await import("./sounds");
    playMoveSound({ san: "Bxf7+" });
    expect(playCalls.some((p) => p.includes("Check"))).toBe(true);
    expect(playCalls.some((p) => p.includes("Checkmate"))).toBe(false);
  });

  it("plays Capture.mp3 for plain captures", async () => {
    const { playMoveSound } = await import("./sounds");
    playMoveSound({ san: "Nxe5", captured: "p" });
    expect(playCalls.some((p) => p.includes("Capture"))).toBe(true);
  });

  it("plays Move.mp3 for quiet moves", async () => {
    const { playMoveSound } = await import("./sounds");
    playMoveSound({ san: "Nf3" });
    expect(playCalls.some((p) => p.includes("Move"))).toBe(true);
  });

  it("does nothing for null / undefined input", async () => {
    const { playMoveSound } = await import("./sounds");
    playMoveSound(null);
    playMoveSound(undefined);
    expect(playCalls).toEqual([]);
  });

  it("accepts a bare SAN string instead of a verbose move object", async () => {
    const { playMoveSound } = await import("./sounds");
    playMoveSound("Qxh7#");
    expect(playCalls.some((p) => p.includes("Checkmate"))).toBe(true);
  });
});

describe("setVolume", () => {
  it("clamps volume between 0 and 1 and persists to localStorage", async () => {
    const { setVolume, getVolume } = await import("./sounds");
    setVolume(2);
    expect(getVolume()).toBe(1);
    setVolume(-0.5);
    expect(getVolume()).toBe(0);
    setVolume(0.3);
    expect(getVolume()).toBeCloseTo(0.3);
    expect(localStorage.getItem("ochess_volume")).toBe("0.3");
  });
});
