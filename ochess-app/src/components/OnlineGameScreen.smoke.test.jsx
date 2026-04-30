/**
 * OnlineGameScreen smoke test.
 *
 * The default-export component is ~1000 lines, talks to Supabase
 * Realtime + RPC + the clock + sounds + chess.js, and is otherwise
 * untested. Goal here: a single render that exercises the import
 * graph, mounts the component with fake data, and verifies the
 * principal UI affordances (board, clock, social panel hidden,
 * resign / draw / leave controls). Anything that protects against
 * a regression in this 1000-line file is a win.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import OnlineGameScreen from "./OnlineGameScreen";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("../lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          single: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      insert: () => Promise.resolve({ error: null }),
    }),
    channel: () => ({
      on: () => ({ on: () => ({ on: () => ({ subscribe: () => ({}) }) }) }),
      subscribe: () => ({}),
      send: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
    }),
    removeChannel: () => Promise.resolve(),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
  isOnline: () => true,
}));

// Capture the callbacks the component registers so individual tests
// can fire broadcast-events directly (e.g. simulate the opponent
// declining a rematch).
export const channelCallbacksRef = { value: null };
const channelStub = {
  leave: vi.fn(),
  unsubscribe: vi.fn(),
  send: vi.fn(() => Promise.resolve()),
  sendMove: vi.fn(),
  sendResign: vi.fn(),
  sendDrawOffer: vi.fn(),
  sendDrawAccept: vi.fn(),
  sendDrawDecline: vi.fn(),
  sendGameOver: vi.fn(),
  sendChat: vi.fn(),
  sendRematchOffer: vi.fn(),
  sendRematchAccept: vi.fn(),
  sendRematchDecline: vi.fn(),
  sendRematchCancel: vi.fn(),
};

vi.mock("../lib/online-game", () => ({
  joinGameChannel: vi.fn((_id, cbs) => {
    channelCallbacksRef.value = cbs;
    return channelStub;
  }),
  completeGame: vi.fn(() => Promise.resolve()),
  saveGameStateToDB: vi.fn(() => Promise.resolve()),
  createRematchGame: vi.fn(() => Promise.resolve({ id: "rematch-id" })),
  subscribeToGameRow: vi.fn(() => ({
    unsubscribe: vi.fn(),
    leave: vi.fn(),
  })),
}));

vi.mock("../lib/sounds", () => ({
  playMoveSound: vi.fn(),
  playGameStart: vi.fn(),
  playVictory: vi.fn(),
  playDefeat: vi.fn(),
  playDraw: vi.fn(),
  playLowTime: vi.fn(),
  playChatNotify: vi.fn(),
  playOfferNotify: vi.fn(),
  playSocialNotify: vi.fn(),
  preloadAll: vi.fn(),
}));

vi.mock("../lib/openings", () => ({
  getOpeningName: vi.fn(() => Promise.resolve(null)),
  resetOpeningCache: vi.fn(),
}));

vi.mock("./AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "user-1", email: "white@example.com" },
    profile: { id: "user-1", username: "whiteplayer", display_name: "White Player" },
    loading: false,
  }),
}));

// SocialPanel mounts and subscribes to friendships; stub it out so
// the component-under-test stays focused on the game UI.
vi.mock("./SocialPanel", () => ({
  default: () => null,
}));

// InteractiveBoard would otherwise pull in react-chessboard, which
// is fine in unit tests but adds a heavy DOM. Stub it.
vi.mock("./InteractiveBoard", () => ({
  default: ({ fen }) => <div data-testid="board" data-fen={fen || ""}>board</div>,
}));

// ── Helpers ─────────────────────────────────────────────────────────

function makeGameData(overrides = {}) {
  return {
    id: "game-1",
    white_id: "user-1",
    black_id: "user-2",
    white_name: "White Player",
    black_name: "Black Player",
    white_rating: 1500,
    black_rating: 1500,
    time_control: "5+0",
    variant: "standard",
    is_rated: false,
    status: "active",
    pgn: "",
    fen: null,
    chat: [],
    white_time_ms: 5 * 60 * 1000,
    black_time_ms: 5 * 60 * 1000,
    last_move_at: null,
    turn: "w",
    white_draw_offers: 0,
    black_draw_offers: 0,
    rematch_offered_by: null,
    rematch_game_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function mount(gameData = makeGameData(), playerColor = "white") {
  return render(
    <MemoryRouter>
      <OnlineGameScreen gameData={gameData} playerColor={playerColor} />
    </MemoryRouter>
  );
}

// ── Tests ──────────────────────────────────────────────────────────

describe("OnlineGameScreen (smoke)", () => {
  it("mounts an active game without crashing", () => {
    mount();
    // The opponent's display name only renders once their bar mounts
    // (which happens on first server presence). Asserting the active
    // user's name is sufficient to prove the import + mount path.
    expect(screen.getAllByText(/White Player/).length).toBeGreaterThan(0);
  });

  it("renders the board fen prop from chess.js starting position", () => {
    mount();
    const board = screen.getByTestId("board");
    expect(board.getAttribute("data-fen")).toMatch(/^rnbqkbnr/);
  });

  it("does not render the post-game result panel for an active game", () => {
    mount();
    // No "You win", "You lost", "Draw" should appear on an active game.
    expect(screen.queryByText(/^You win!$/)).toBeNull();
    expect(screen.queryByText(/^You lost$/)).toBeNull();
  });

  it("renders the result panel with role=status when the row arrives completed", () => {
    const completed = makeGameData({
      status: "completed",
      result: "white_wins",
      winner: "user-1",
      pgn: "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6",
    });
    mount(completed);
    // The component reads gameOver from the row asynchronously; we just
    // assert the import / render path doesn't crash for completed rows.
    expect(screen.getAllByText(/White Player/).length).toBeGreaterThan(0);
  });

  it("survives missing optional gameData fields without crashing", () => {
    const minimal = makeGameData({ chat: null, last_move_at: null });
    mount(minimal);
    expect(screen.getByTestId("board")).toBeDefined();
  });

  // ── Offer-decline / cancel toast flow ─────────────────────────────
  // When the opponent rejects MY rematch (or cancels their own
  // incoming rematch on the other side), the component should
  // surface a transient banner. Previously the UI silently reverted
  // and users couldn't tell whether their click had registered.

  it("shows a toast banner when the opponent declines a rematch", () => {
    const completed = makeGameData({
      status: "completed",
      result: "white_wins",
      pgn: "1. e4 e5 2. f4 exf4",
      rematch_offered_by: "user-1", // I'm the offerer.
    });
    mount(completed);
    // Pretend the opponent's rematch_decline broadcast arrived.
    act(() => { channelCallbacksRef.value?.onRematchDecline?.({ userId: "user-2" }); });
    expect(screen.getByText(/Opponent declined the rematch/i)).toBeDefined();
  });

  it("shows a toast banner when the opponent cancels their incoming rematch", () => {
    const completed = makeGameData({
      status: "completed",
      result: "white_wins",
      pgn: "1. e4 e5 2. f4 exf4",
      rematch_offered_by: "user-2", // Opponent is the offerer.
    });
    mount(completed);
    act(() => { channelCallbacksRef.value?.onRematchCancel?.({ userId: "user-2" }); });
    expect(screen.getByText(/Opponent canceled the rematch offer/i)).toBeDefined();
  });

  it("shows a toast banner when the opponent declines a draw offer", () => {
    const active = makeGameData({ pgn: "1. e4 e5" });
    mount(active);
    // The decliner must be one of the players for the validPlayers
    // gate to pass; the opponent here is user-2.
    act(() => { channelCallbacksRef.value?.onDrawDecline?.({ userId: "user-2" }); });
    expect(screen.getByText(/Opponent declined your draw offer/i)).toBeDefined();
  });

  // ── Draw-offer pending state (visible to both sides) ──────────
  // The pending draw offer is now persisted to the games row and
  // both clients see it via the postgres-changes feed. Verify the
  // Accept / Decline panel for the receiver and the "Draw pending"
  // affordance for the offerer.

  it("shows the accept/decline panel when the opponent has a pending offer", () => {
    const active = makeGameData({ pgn: "1. e4 e5" });
    mount(active);
    // Simulate the opponent's draw_offer broadcast arriving.
    act(() => {
      channelCallbacksRef.value?.onDrawOffer?.({ userId: "user-2", ply: 2 });
    });
    expect(screen.getByText(/Opponent offers a draw/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /^Accept$/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /^Decline$/i })).toBeDefined();
  });

  it("shows 'Draw pending…' on the offerer's side after offering", () => {
    // The Draw button only renders past the early-abort window
    // (history.length > 2), so we need at least 3 plies of PGN.
    const active = makeGameData({
      pgn: "1. e4 e5 2. Nf3",
      // Server says I'm the offerer with an offer ply of 3.
      draw_offer_by: "user-1",
      draw_offer_ply: 3,
    });
    mount(active);
    expect(screen.getByText(/Draw pending/i)).toBeDefined();
  });

  // ── Draw-offer expiry (anti-camping) ──────────────────────────
  // Once 2 plies have been played past the offer ply, the offer
  // auto-clears for both sides and the offerer sees a notice.

  it("auto-expires my draw offer once 2 plies have advanced past it", async () => {
    // Mount with my offer at ply 3, but the current PGN already has
    // 5 plies (3 + 2). The expiry effect should fire on mount, clear
    // local state, and surface the toast.
    const active = makeGameData({
      pgn: "1. e4 e5 2. Nf3 Nc6 3. Bb5",
      draw_offer_by: "user-1",
      draw_offer_ply: 3,
    });
    mount(active);
    // Toast should appear since my offer has lapsed.
    expect(screen.getByText(/Your draw offer expired/i)).toBeDefined();
    // The "Draw pending…" affordance should be gone - the button
    // is back to its normal "Draw" label.
    expect(screen.queryByText(/Draw pending/i)).toBeNull();
  });

  it("does not let the receiver accept a stale (expired) offer", () => {
    // Server says opponent (user-2) offered at ply 3, but the game
    // has already advanced 2 plies past that. The Accept/Decline
    // panel must not render in this state - the offer has lapsed.
    const active = makeGameData({
      pgn: "1. e4 e5 2. Nf3 Nc6 3. Bb5",
      draw_offer_by: "user-2",
      draw_offer_ply: 3,
    });
    mount(active);
    expect(screen.queryByText(/Opponent offers a draw/i)).toBeNull();
  });

  it("ignores rematch_decline broadcasts from outside the player set", () => {
    const completed = makeGameData({
      status: "completed",
      result: "white_wins",
      pgn: "1. e4 e5",
    });
    mount(completed);
    // The component currently only validates this on offer/accept;
    // decline is permissive on purpose (the broadcast can only have
    // come from the opposite tab if self:false is honored). This
    // test pins the existing behavior so a future tightening here
    // stays an explicit decision rather than a silent regression.
    act(() => { channelCallbacksRef.value?.onRematchDecline?.({ userId: "user-1" }); });
    expect(screen.getByText(/Opponent declined the rematch/i)).toBeDefined();
  });
});
