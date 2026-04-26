import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeLogger } from "./log";

describe("makeLogger", () => {
  let logSpy, warnSpy, errSpy;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns log/warn/error helpers", () => {
    const l = makeLogger("test");
    expect(typeof l.log).toBe("function");
    expect(typeof l.warn).toBe("function");
    expect(typeof l.error).toBe("function");
  });

  it("always logs errors regardless of build mode (so prod crashes are visible)", () => {
    const l = makeLogger("test");
    l.error("boom");
    expect(errSpy).toHaveBeenCalled();
    const call = errSpy.mock.calls[0];
    expect(call[0]).toBe("[test]");
    expect(call[1]).toBe("boom");
  });

  it("emits log/warn under Vitest (DEV mode)", () => {
    // Vitest runs with import.meta.env.DEV === true, so log/warn fire.
    const l = makeLogger("dev");
    l.log("hello");
    l.warn("careful");
    expect(logSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("supports an empty tag", () => {
    const l = makeLogger();
    l.log("plain");
    const call = logSpy.mock.calls.find((c) => c.includes("plain"));
    expect(call).toBeDefined();
  });
});
