import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock supabase: a small in-memory puzzle_progress row. Hoisted so
// the mock factory and the test bodies share the same handle.
const { state } = vi.hoisted(() => ({ state: { row: null, lastUpdate: null } }));

vi.mock("./supabase", () => ({
  supabase: {
    from(table) {
      if (table !== "puzzle_progress") throw new Error("unexpected table " + table);
      const ctx = { op: null, payload: null, filters: {} };
      const builder = {
        select() { ctx.op = "select"; return builder; },
        eq(col, val) { ctx.filters[col] = val; return builder; },
        update(payload) { ctx.op = "update"; ctx.payload = payload; return builder; },
        maybeSingle() {
          if (state.row && state.row.user_id === ctx.filters.user_id) {
            return Promise.resolve({ data: state.row, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        // Make the builder awaitable so update().eq().then(...) works
        // the same as the real Supabase JS client.
        then(resolve, reject) {
          if (ctx.op === "update") {
            state.lastUpdate = { filters: { ...ctx.filters }, payload: ctx.payload };
            if (state.row && state.row.user_id === ctx.filters.user_id) {
              Object.assign(state.row, ctx.payload);
            }
            return Promise.resolve({ error: null }).then(resolve, reject);
          }
          return Promise.resolve({ error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  },
}));

import { syncPuzzleProgressFromServer, todayLocalISO } from "./puzzle-sync";

beforeEach(() => {
  localStorage.clear();
  state.row = null;
  state.lastUpdate = null;
});

describe("syncPuzzleProgressFromServer", () => {
  it("returns null when there is no server row", async () => {
    expect(await syncPuzzleProgressFromServer("u1")).toBeNull();
  });

  it("server wins on rating + rd when it has more games played", async () => {
    state.row = { user_id: "u1", puzzle_rating: 1800, puzzle_rd: 80, puzzles_solved: 100, puzzles_failed: 20, current_streak: 5, best_streak: 30 };
    localStorage.setItem("ochess_puzzle_rating", JSON.stringify({ rating: 1500, rd: 200, games: 5 }));
    const merged = await syncPuzzleProgressFromServer("u1");
    expect(merged.rating).toBe(1800);
    expect(merged.rd).toBe(80);
    expect(merged.games).toBe(120);
  });

  it("local wins on rating when local has played more games than the server row", async () => {
    state.row = { user_id: "u1", puzzle_rating: 1500, puzzle_rd: 200, puzzles_solved: 1, puzzles_failed: 0, current_streak: 0, best_streak: 1 };
    localStorage.setItem("ochess_puzzle_rating", JSON.stringify({ rating: 2000, rd: 60, games: 500 }));
    const merged = await syncPuzzleProgressFromServer("u1");
    expect(merged.rating).toBe(2000);
    expect(merged.rd).toBe(60);
    expect(merged.games).toBe(500);
  });

  it("best_streak is the max across local and server", async () => {
    state.row = { user_id: "u1", puzzle_rating: 1500, puzzle_rd: 200, puzzles_solved: 100, puzzles_failed: 0, current_streak: 0, best_streak: 25 };
    localStorage.setItem("ochess_puzzle_streak", JSON.stringify({ current: 10, best: 50 }));
    const merged = await syncPuzzleProgressFromServer("u1");
    expect(merged.best_streak).toBe(50);
    expect(merged.current_streak).toBe(10);
  });

  it("writes the merged blob back to localStorage so the dashboard reflects the merge", async () => {
    state.row = { user_id: "u1", puzzle_rating: 1700, puzzle_rd: 70, puzzles_solved: 100, puzzles_failed: 5, current_streak: 4, best_streak: 12 };
    await syncPuzzleProgressFromServer("u1");
    const stored = JSON.parse(localStorage.getItem("ochess_puzzle_rating"));
    expect(stored.rating).toBe(1700);
    const streak = JSON.parse(localStorage.getItem("ochess_puzzle_streak"));
    expect(streak.best).toBe(12);
  });

  it("pushes the merged values back to the server (writeback)", async () => {
    state.row = { user_id: "u1", puzzle_rating: 1500, puzzle_rd: 200, puzzles_solved: 0, puzzles_failed: 0, current_streak: 0, best_streak: 0 };
    localStorage.setItem("ochess_puzzle_streak", JSON.stringify({ current: 7, best: 9 }));
    await syncPuzzleProgressFromServer("u1");
    expect(state.lastUpdate).toBeTruthy();
    expect(state.lastUpdate.payload.best_streak).toBe(9);
    expect(state.lastUpdate.payload.current_streak).toBe(7);
  });

  it("returns null when userId is falsy", async () => {
    expect(await syncPuzzleProgressFromServer(null)).toBeNull();
    expect(await syncPuzzleProgressFromServer(undefined)).toBeNull();
  });
});

describe("todayLocalISO", () => {
  it("formats a date as YYYY-MM-DD using local zone fields", () => {
    // Use the date constructor with local-zone values so the
    // assertion is independent of the machine's timezone.
    const fake = new Date(2026, 0, 5, 23, 30, 0);
    expect(todayLocalISO(fake)).toBe("2026-01-05");
  });

  it("does not roll over at UTC midnight for a same-local-day date", () => {
    // Construct a date that is 2026-01-05 at 23:00 local time. The
    // UTC slice would have rolled to 2026-01-06 for most positive
    // UTC offsets; the local slice should still report 2026-01-05.
    const fake = new Date(2026, 0, 5, 23, 0, 0);
    expect(todayLocalISO(fake)).toBe("2026-01-05");
  });

  it("zero-pads months and days under 10", () => {
    const fake = new Date(2026, 1, 3, 12, 0, 0);
    expect(todayLocalISO(fake)).toBe("2026-02-03");
  });
});
