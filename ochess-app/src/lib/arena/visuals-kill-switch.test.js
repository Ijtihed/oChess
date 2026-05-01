import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is HOISTED to the top of the file, so we can't
// reference test-file locals directly inside the factory. Use
// vi.hoisted to declare the mock object alongside the mock so
// both end up at the right place in the module graph.
const { supabaseMock } = vi.hoisted(() => ({
  supabaseMock: { from: undefined },
}));

vi.mock("../supabase", () => ({ supabase: supabaseMock }));

import { isVisualsKilled, invalidateVisualsKilledCache } from "./visuals-kill-switch";

// Now that mocks are wired, install the actual `from` spy.
supabaseMock.from = vi.fn();

/**
 * Build a chainable .from(...).select(...).eq(...).maybeSingle()
 * stub that resolves to the given { data, error } shape.
 */
function mockSelectMaybeSingle({ data = null, error = null } = {}) {
  const maybeSingle = vi.fn().mockResolvedValue({ data, error });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  supabaseMock.from.mockImplementation(() => ({ select }));
  return { maybeSingle, eq, select };
}

beforeEach(() => {
  invalidateVisualsKilledCache();
  supabaseMock.from.mockReset();
});

describe("visuals-kill-switch", () => {
  it("returns false when the column is false", async () => {
    mockSelectMaybeSingle({ data: { disable_drawn_visuals: false } });
    expect(await isVisualsKilled()).toBe(false);
  });

  it("returns true when the column is true", async () => {
    mockSelectMaybeSingle({ data: { disable_drawn_visuals: true } });
    expect(await isVisualsKilled()).toBe(true);
  });

  it("returns false when the row is missing entirely (fail-open)", async () => {
    mockSelectMaybeSingle({ data: null });
    expect(await isVisualsKilled()).toBe(false);
  });

  it("returns false on a Supabase error (fail-open: visuals stay enabled)", async () => {
    mockSelectMaybeSingle({ data: null, error: { message: "boom" } });
    expect(await isVisualsKilled()).toBe(false);
  });

  it("returns false if the entire RPC throws (fail-open)", async () => {
    supabaseMock.from.mockImplementation(() => { throw new Error("network"); });
    expect(await isVisualsKilled()).toBe(false);
  });

  it("caches the result so subsequent calls within the TTL don't hit the DB again", async () => {
    const { maybeSingle } = mockSelectMaybeSingle({ data: { disable_drawn_visuals: true } });
    await isVisualsKilled();
    await isVisualsKilled();
    await isVisualsKilled();
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache failed reads (so transient blips are retried)", async () => {
    // First call: error.
    const errStub = mockSelectMaybeSingle({ data: null, error: { message: "boom" } });
    expect(await isVisualsKilled()).toBe(false);
    expect(errStub.maybeSingle).toHaveBeenCalledTimes(1);
    // Second call: should re-hit the DB. Re-mock to return success.
    const okStub = mockSelectMaybeSingle({ data: { disable_drawn_visuals: true } });
    expect(await isVisualsKilled()).toBe(true);
    expect(okStub.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("invalidateVisualsKilledCache forces a re-fetch", async () => {
    const stub1 = mockSelectMaybeSingle({ data: { disable_drawn_visuals: true } });
    expect(await isVisualsKilled()).toBe(true);
    expect(stub1.maybeSingle).toHaveBeenCalledTimes(1);

    invalidateVisualsKilledCache();

    const stub2 = mockSelectMaybeSingle({ data: { disable_drawn_visuals: false } });
    expect(await isVisualsKilled()).toBe(false);
    expect(stub2.maybeSingle).toHaveBeenCalledTimes(1);
  });
});
