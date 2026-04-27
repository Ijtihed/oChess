import { describe, it, expect } from "vitest";
import { initMonitoring, captureError, track, identify } from "./monitoring";

// All monitoring is opt-in via env vars. The unit tests don't set
// VITE_SENTRY_DSN or VITE_POSTHOG_KEY, so init() should resolve as
// a no-op and every public function should be safe to call.

describe("monitoring (no-op when env vars are unset)", () => {
  it("initMonitoring resolves without throwing", async () => {
    await expect(initMonitoring()).resolves.toBeUndefined();
  });

  it("initMonitoring is idempotent on repeated calls", async () => {
    const first = initMonitoring();
    const second = initMonitoring();
    expect(first).toBe(second);
  });

  it("captureError is safe to call without init", () => {
    expect(() => captureError(new Error("boom"))).not.toThrow();
    expect(() => captureError(new Error("boom"), { extra: 1 })).not.toThrow();
    expect(() => captureError(null)).not.toThrow();
  });

  it("track is safe to call without init", () => {
    expect(() => track("test_event")).not.toThrow();
    expect(() => track("test_event", { foo: "bar" })).not.toThrow();
  });

  it("identify is safe to call (signed in or signed out)", () => {
    expect(() => identify("user-123")).not.toThrow();
    expect(() => identify("user-123", { plan: "free" })).not.toThrow();
    expect(() => identify(null)).not.toThrow(); // logout reset
  });
});
