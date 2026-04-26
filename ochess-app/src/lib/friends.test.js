import { describe, it, expect, vi, beforeEach } from "vitest";

// Tiny in-memory friendships table to exercise the lib's public
// surface end-to-end. The schema mirrors what schema.sql defines
// (id, user_id, friend_id, status).
//
// vi.hoisted lifts the shared state above the mock factory (which is
// itself hoisted) so the in-test reset works without TDZ errors.
const { friendshipsTable, profilesTable, nextIdRef } = vi.hoisted(() => ({
  friendshipsTable: [],
  profilesTable: new Map(),
  nextIdRef: { value: 0 },
}));

function makeBuilder(table) {
  const ctx = { filters: {}, ors: [], op: null, payload: null };
  const tableRows = () => (table === "friendships" ? friendshipsTable : Array.from(profilesTable.values()));
  const matchesNow = () => {
    const list = tableRows();
    return list.filter((r) => {
      for (const [k, v] of Object.entries(ctx.filters)) {
        if (typeof v === "function") { if (!v(r[k])) return false; }
        else if (Array.isArray(v)) { if (!v.includes(r[k])) return false; }
        else if (r[k] !== v) return false;
      }
      if (ctx.ors.length) return ctx.ors.some((c) => c(r));
      return true;
    });
  };
  // Note: applyFilters legacy helper removed — matchesNow handles all callers.
  // (Marker)

  const builder = {
    select(_cols) { ctx.op = "select"; return builder; },
    insert(row) {
      const id = `f-${++nextIdRef.value}`;
      const stored = { id, status: row.status || "pending", ...row };
      friendshipsTable.push(stored);
      return { select: () => ({ single: () => Promise.resolve({ data: stored, error: null }) }) };
    },
    update(payload) { ctx.op = "update"; ctx.payload = payload; return builder; },
    delete() { ctx.op = "delete"; return builder; },
    eq(col, val) { ctx.filters[col] = val; return builder; },
    neq(col, val) { ctx.filters[col] = (cur) => cur !== val; return builder; },
    in(col, vals) { ctx.filters[col] = vals; return builder; },
    or(expr) {
      // Very small parser: handles the two patterns this codebase uses:
      //   user_id.eq.X,friend_id.eq.X
      //   and(user_id.eq.X,friend_id.eq.Y),and(user_id.eq.Y,friend_id.eq.X)
      const clauses = [];
      const segs = expr.split(/,(?![^(]*\))/);
      for (const seg of segs) {
        if (seg.startsWith("and(")) {
          const inner = seg.slice(4, -1).split(",");
          const checks = inner.map((s) => {
            const [col, op, val] = s.split(".");
            return (r) => r[col] === val;
          });
          clauses.push((r) => checks.every((c) => c(r)));
        } else {
          const [col, op, val] = seg.split(".");
          clauses.push((r) => r[col] === val);
        }
      }
      ctx.ors = clauses;
      return builder;
    },
    ilike(col, pattern) {
      const re = new RegExp("^" + pattern.replace(/%/g, ".*") + "$", "i");
      ctx.filters[col] = (cur) => re.test(cur || "");
      return builder;
    },
    limit() { return builder; },
    then(resolve, reject) {
      // Builder is the awaitable terminator — evaluate the queued
      // op against the current filters at await time so update() /
      // delete() chained with eq() resolves like real Supabase.
      const matches = matchesNow();
      if (ctx.op === "update") {
        for (const r of matches) Object.assign(r, ctx.payload);
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      if (ctx.op === "delete") {
        for (const m of matches) {
          const idx = friendshipsTable.indexOf(m);
          if (idx >= 0) friendshipsTable.splice(idx, 1);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: matches, error: null, status: 200 }).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock("./supabase", () => ({
  supabase: {
    from(table) { return makeBuilder(table); },
    auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: "me" } } } }) },
  },
}));

import { sendFriendRequest, getPendingRequests, acceptFriendRequest, declineFriendRequest, removeFriend } from "./friends";

beforeEach(() => {
  friendshipsTable.length = 0;
  profilesTable.clear();
  nextIdRef.value = 0;
});

describe("sendFriendRequest", () => {
  it("rejects friending yourself", async () => {
    await expect(sendFriendRequest("u1", "u1")).rejects.toThrow(/yourself/i);
  });

  it("rejects re-friending an existing accepted friend", async () => {
    friendshipsTable.push({ id: "f1", user_id: "u1", friend_id: "u2", status: "accepted" });
    await expect(sendFriendRequest("u1", "u2")).rejects.toThrow(/already friends/i);
  });

  it("rejects re-friending when a pending request exists in either direction", async () => {
    friendshipsTable.push({ id: "f1", user_id: "u2", friend_id: "u1", status: "pending" });
    await expect(sendFriendRequest("u1", "u2")).rejects.toThrow(/pending/i);
  });

  it("inserts a new pending row when none exists", async () => {
    const row = await sendFriendRequest("u1", "u2");
    expect(row.user_id).toBe("u1");
    expect(row.friend_id).toBe("u2");
    expect(row.status).toBe("pending");
  });
});

describe("getPendingRequests", () => {
  it("returns empty shape when there's nothing", async () => {
    const out = await getPendingRequests("u1");
    expect(out.incoming).toEqual([]);
    expect(out.outgoing).toEqual([]);
    expect(out.outgoingRequestIds).toEqual({});
  });

  it("exposes outgoingRequestIds keyed by recipient -> request id", async () => {
    friendshipsTable.push({ id: "f1", user_id: "u1", friend_id: "u2", status: "pending" });
    friendshipsTable.push({ id: "f2", user_id: "u1", friend_id: "u3", status: "pending" });
    const out = await getPendingRequests("u1");
    expect(out.outgoing.sort()).toEqual(["u2", "u3"]);
    expect(out.outgoingRequestIds).toEqual({ u2: "f1", u3: "f2" });
  });

  it("incoming entries carry requestId and the requester profile id", async () => {
    friendshipsTable.push({ id: "f9", user_id: "u4", friend_id: "u1", status: "pending" });
    const out = await getPendingRequests("u1");
    expect(out.incoming).toHaveLength(1);
    expect(out.incoming[0].requestId).toBe("f9");
    expect(out.incoming[0].id).toBe("u4");
  });
});

describe("acceptFriendRequest / declineFriendRequest / removeFriend", () => {
  it("acceptFriendRequest flips status to accepted", async () => {
    friendshipsTable.push({ id: "f1", user_id: "u2", friend_id: "u1", status: "pending" });
    await acceptFriendRequest("f1");
    expect(friendshipsTable[0].status).toBe("accepted");
  });

  it("declineFriendRequest deletes the row", async () => {
    friendshipsTable.push({ id: "f1", user_id: "u2", friend_id: "u1", status: "pending" });
    await declineFriendRequest("f1");
    expect(friendshipsTable.length).toBe(0);
  });

  it("removeFriend deletes the row", async () => {
    friendshipsTable.push({ id: "f1", user_id: "u1", friend_id: "u2", status: "accepted" });
    await removeFriend("f1");
    expect(friendshipsTable.length).toBe(0);
  });
});
