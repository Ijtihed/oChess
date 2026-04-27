import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We construct a small in-memory Supabase mock that records inserts /
// updates / deletes so the tests can verify the contract of
// challenges.js without spinning up a real Postgres.

const { state, supabaseMock } = vi.hoisted(() => {
  const state = {
    challengesTable: new Map(), // id -> row
    insertSequence: 0,
    ops: { inserts: 0, updates: [], deletes: 0 },
    insertErrorRequest: null, // { count: N } -> first N inserts get a 23505
    nowMs: new Date("2026-04-26T20:00:00Z").getTime(),
    rpcImpl: null,
  };

  function makeFromBuilder(table) {
    const ctx = { table, filters: {}, op: null, payload: null };
    const apply = (rows) => rows.filter((r) => Object.entries(ctx.filters).every(([k, v]) => r[k] === v));
    const builder = {
      insert(row) {
        const id = `id-${++state.insertSequence}`;
        const created_at = new Date(state.nowMs).toISOString();
        const stored = { id, created_at, status: "waiting", ...row };
        if (state.insertErrorRequest) {
          state.insertErrorRequest.count -= 1;
          if (state.insertErrorRequest.count >= 0) {
            return {
              select: () => ({ single: () => Promise.resolve({ data: null, error: { code: "23505", message: "unique_violation" } }) }),
            };
          }
        }
        if (table === "challenges") state.challengesTable.set(id, stored);
        state.ops.inserts++;
        return {
          select: () => ({ single: () => Promise.resolve({ data: stored, error: null }) }),
        };
      },
      select() { ctx.op = "select"; return builder; },
      eq(col, val) { ctx.filters[col] = val; return builder; },
      update(payload) { ctx.op = "update"; ctx.payload = payload; return builder; },
      delete() { ctx.op = "delete"; return builder; },
      maybeSingle() {
        const list = Array.from(state.challengesTable.values());
        const row = apply(list)[0] || null;
        return Promise.resolve({ data: row, error: null });
      },
      // Make builder awaitable so update/delete chained with eq()
      // resolve like the real Supabase client.
      then(resolve, reject) {
        if (ctx.op === "update") {
          state.ops.updates.push({ filters: { ...ctx.filters }, payload: ctx.payload });
          const list = Array.from(state.challengesTable.values());
          for (const r of apply(list)) Object.assign(r, ctx.payload);
          return Promise.resolve({ error: null }).then(resolve, reject);
        }
        if (ctx.op === "delete") {
          state.ops.deletes++;
          const list = Array.from(state.challengesTable.values());
          for (const r of apply(list)) state.challengesTable.delete(r.id);
          return Promise.resolve({ error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const supabaseMock = {
    from(table) { return makeFromBuilder(table); },
    rpc(name, params) {
      if (state.rpcImpl) return state.rpcImpl(name, params);
      return Promise.resolve({ data: null, error: null });
    },
    channel() { return { on() { return this; }, subscribe() { return this; } }; },
    removeChannel() {},
  };

  return { state, supabaseMock };
});

vi.mock("./supabase", () => ({ supabase: supabaseMock }));

import { createChallenge, getChallenge, deleteChallenge, acceptChallengeRPC } from "./challenges";

beforeEach(() => {
  state.challengesTable.clear();
  state.insertSequence = 0;
  state.ops.inserts = 0; state.ops.updates.length = 0; state.ops.deletes = 0;
  state.insertErrorRequest = null;
  state.nowMs = new Date("2026-04-26T20:00:00Z").getTime();
  state.rpcImpl = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createChallenge", () => {
  it("inserts a row with the given fields and returns it", async () => {
    const row = await createChallenge("u1", "Alice", 1500, { timeControl: "5+0", colorPref: "random" });
    expect(row).toBeTruthy();
    expect(row.code).toMatch(/^[a-z0-9]{8}$/);
    expect(row.creator_id).toBe("u1");
    expect(row.creator_name).toBe("Alice");
    expect(row.time_control).toBe("5+0");
    expect(state.ops.inserts).toBe(1);
  });

  it("retries on 23505 unique-code collisions up to 3 times", async () => {
    state.insertErrorRequest = { count: 2 };
    const row = await createChallenge("u1", "Alice", 1500, { timeControl: "10+0" });
    expect(row).toBeTruthy();
    // 2 failures + 1 success = 3 inserts attempted total.
    expect(state.ops.inserts).toBe(1); // success only counts toward stored
  });

  it("eventually rejects after exhausting all retries", async () => {
    state.insertErrorRequest = { count: 5 };
    await expect(createChallenge("u1", "Alice", 1500, { timeControl: "5+0" }))
      .rejects.toThrow(/unique code/i);
  });
});

describe("getChallenge expiry", () => {
  it("returns the row when it's fresh", async () => {
    // The library compares created_at against the real Date.now(),
    // and the mock seeds created_at from state.nowMs (a fixed past
    // timestamp). Freeze the system clock to that timestamp so the
    // "0 elapsed" branch holds regardless of when the suite runs.
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(state.nowMs));
    const created = await createChallenge("u1", "A", 1500, { timeControl: "5+0" });
    const out = await getChallenge(created.code);
    expect(out).toBeTruthy();
    expect(out.code).toBe(created.code);
  });

  it("marks the row expired and returns null after 15 minutes", async () => {
    const created = await createChallenge("u1", "A", 1500, { timeControl: "5+0" });
    // Use vitest's fake timers to advance Date.now() past the 15-minute
    // expiry threshold without touching the global Date constructor.
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date("2026-04-26T20:16:00Z"));
    try {
      const out = await getChallenge(created.code);
      expect(out).toBeNull();
      const expiredUpdate = state.ops.updates.find((u) => u.payload.status === "expired");
      expect(expiredUpdate).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null for a code that doesn't exist", async () => {
    const out = await getChallenge("nope0000");
    expect(out).toBeNull();
  });
});

describe("deleteChallenge", () => {
  it("removes the row matching the id", async () => {
    const created = await createChallenge("u1", "A", 1500, { timeControl: "5+0" });
    expect(state.challengesTable.has(created.id)).toBe(true);
    await deleteChallenge(created.id);
    expect(state.challengesTable.has(created.id)).toBe(false);
  });
});

describe("acceptChallengeRPC", () => {
  it("calls supabase.rpc('accept_challenge') with the four expected params", async () => {
    const calls = [];
    state.rpcImpl = (name, params) => {
      calls.push({ name, params });
      return Promise.resolve({ data: { id: "g1" }, error: null });
    };
    const game = await acceptChallengeRPC("c1", "u2", "Bob", 1450);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("accept_challenge");
    expect(calls[0].params).toEqual({
      p_challenge_id: "c1",
      p_joiner_id: "u2",
      p_joiner_name: "Bob",
      p_joiner_rating: 1450,
    });
    expect(game.id).toBe("g1");
  });

  it("rethrows the server error message when the RPC's data has .error", async () => {
    state.rpcImpl = () => Promise.resolve({ data: { error: "Not found" }, error: null });
    await expect(acceptChallengeRPC("c1", "u2", "Bob", 1450)).rejects.toThrow(/not found/i);
  });
});
