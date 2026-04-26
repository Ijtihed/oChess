import { describe, it, expect, vi, beforeEach } from "vitest";

const eqCalls = [];

function makeQuery() {
  const q = {
    _filters: {},
    select() { return q; },
    neq() { return q; },
    eq(col, val) { q._filters[col] = val; eqCalls.push({ col, val }); return q; },
    gte() { return q; },
    lte() { return q; },
    order() { return q; },
    limit() { return q; },
    then(resolve) { resolve({ data: [], error: null }); return Promise.resolve({ data: [], error: null }); },
  };
  return q;
}

vi.mock("./supabase", () => ({
  supabase: {
    from: () => makeQuery(),
    auth: { getSession: () => Promise.resolve({ data: null, error: null }) },
  },
  getRealtimeClient: () => null,
}));

import { findMatch } from "./online-game";

describe("findMatch is_rated filter", () => {
  beforeEach(() => { eqCalls.length = 0; });

  it("filters seeks by is_rated=true when the caller wants a rated game", async () => {
    await findMatch("user-1", 1500, { timeControl: "5+0", isRated: true });
    const isRatedFilter = eqCalls.find((c) => c.col === "is_rated");
    expect(isRatedFilter).toBeDefined();
    expect(isRatedFilter.val).toBe(true);
  });

  it("filters seeks by is_rated=false when the caller wants casual", async () => {
    await findMatch("user-1", 1500, { timeControl: "5+0", isRated: false });
    const isRatedFilter = eqCalls.find((c) => c.col === "is_rated");
    expect(isRatedFilter).toBeDefined();
    expect(isRatedFilter.val).toBe(false);
  });

  it("does not constrain is_rated when caller leaves it undefined (legacy callers)", async () => {
    await findMatch("user-1", 1500, { timeControl: "5+0" });
    const isRatedFilter = eqCalls.find((c) => c.col === "is_rated");
    expect(isRatedFilter).toBeUndefined();
  });
});
