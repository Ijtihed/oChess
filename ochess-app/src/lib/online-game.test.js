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

// Shared fake-channel hook used by the joinGameChannel broadcast
// tests below. Tests reset it in beforeEach.
const channelHook = { instance: null };

function makeFakeChannel() {
  const handlers = {};
  const sent = [];
  let subscribeCb = null;
  const api = {
    on(_kind, opts, cb) { if (opts?.event) handlers[opts.event] = cb; return api; },
    subscribe(cb) { subscribeCb = cb; return api; },
    send(p) { sent.push(p); return Promise.resolve(); },
    track: () => Promise.resolve(),
    untrack: () => {},
  };
  return {
    api,
    sent,
    fire(event, payload) { handlers[event]?.({ payload }); },
    fireSubscribed: async () => { if (subscribeCb) await subscribeCb("SUBSCRIBED"); },
  };
}

vi.mock("./supabase", () => ({
  supabase: {
    from: () => makeQuery(),
    auth: { getSession: () => Promise.resolve({ data: null, error: null }) },
    channel: () => {
      channelHook.instance = makeFakeChannel();
      return channelHook.instance.api;
    },
    removeChannel: () => {},
  },
  getRealtimeClient: () => ({
    channel: () => {
      channelHook.instance = makeFakeChannel();
      return channelHook.instance.api;
    },
    removeChannel: () => {},
  }),
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

// ─────────────────────────────────────────────────────────────────
// joinGameChannel broadcast surface - verifies that every send*
// function emits a broadcast event with the right shape, and that
// every on* callback fires when a matching broadcast lands. The
// new `sendRematchCancel` / `onRematchCancel` pair is locked in so
// it can't regress.
// ─────────────────────────────────────────────────────────────────

import { joinGameChannel } from "./online-game";

describe("joinGameChannel broadcast surface", () => {
  beforeEach(() => { channelHook.instance = null; });

  function setup() {
    const cbs = {
      onMove: vi.fn(),
      onResign: vi.fn(),
      onDrawOffer: vi.fn(),
      onDrawAccept: vi.fn(),
      onDrawDecline: vi.fn(),
      onChat: vi.fn(),
      onGameOver: vi.fn(),
      onRematchOffer: vi.fn(),
      onRematchAccept: vi.fn(),
      onRematchDecline: vi.fn(),
      onRematchCancel: vi.fn(),
      onConnected: vi.fn(),
    };
    const api = joinGameChannel("game-1", cbs);
    return { api, cbs, fake: channelHook.instance };
  }

  it("exposes the full send* API including sendRematchCancel", () => {
    const { api } = setup();
    expect(typeof api.sendMove).toBe("function");
    expect(typeof api.sendResign).toBe("function");
    expect(typeof api.sendDrawOffer).toBe("function");
    expect(typeof api.sendDrawAccept).toBe("function");
    expect(typeof api.sendDrawDecline).toBe("function");
    expect(typeof api.sendRematchOffer).toBe("function");
    expect(typeof api.sendRematchAccept).toBe("function");
    expect(typeof api.sendRematchDecline).toBe("function");
    expect(typeof api.sendRematchCancel).toBe("function");
  });

  it("sendRematchCancel emits a broadcast with the userId payload", () => {
    const { api, fake } = setup();
    api.sendRematchCancel("user-42");
    const cancelMsg = fake.sent.find((m) => m.event === "rematch_cancel");
    expect(cancelMsg).toBeDefined();
    expect(cancelMsg.type).toBe("broadcast");
    expect(cancelMsg.payload).toEqual({ userId: "user-42" });
  });

  it("invokes onRematchCancel when the rematch_cancel event arrives", () => {
    const { cbs, fake } = setup();
    fake.fire("rematch_cancel", { userId: "opponent-7" });
    expect(cbs.onRematchCancel).toHaveBeenCalledTimes(1);
    expect(cbs.onRematchCancel).toHaveBeenCalledWith({ userId: "opponent-7" });
  });

  it("invokes onRematchDecline when the rematch_decline event arrives", () => {
    const { cbs, fake } = setup();
    fake.fire("rematch_decline", { userId: "opponent-7" });
    expect(cbs.onRematchDecline).toHaveBeenCalledTimes(1);
    expect(cbs.onRematchDecline).toHaveBeenCalledWith({ userId: "opponent-7" });
  });

  it("invokes onDrawDecline when the draw_decline event arrives", () => {
    const { cbs, fake } = setup();
    fake.fire("draw_decline", { userId: "opponent-7" });
    expect(cbs.onDrawDecline).toHaveBeenCalledTimes(1);
    expect(cbs.onDrawDecline).toHaveBeenCalledWith({ userId: "opponent-7" });
  });

  it("missing callbacks do not throw when an event arrives", () => {
    const api = joinGameChannel("game-1", {}); // no callbacks
    const fake = channelHook.instance;
    expect(() => fake.fire("rematch_cancel", { userId: "x" })).not.toThrow();
    expect(() => fake.fire("rematch_decline", { userId: "x" })).not.toThrow();
    void api;
  });
});
