import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../lib/supabase", () => ({
  isOnline: () => true,
  supabase: {
    channel: () => ({
      on: function () { return this; },
      subscribe: function () { return this; },
    }),
    removeChannel: vi.fn(),
  },
}));

vi.mock("../lib/friends", () => ({
  getFriends: vi.fn(() => Promise.resolve([])),
  getPendingRequests: vi.fn(() => Promise.resolve({ incoming: [], outgoing: [] })),
  searchUsers: vi.fn(() => Promise.resolve([])),
  sendFriendRequest: vi.fn(),
  acceptFriendRequest: vi.fn(),
  declineFriendRequest: vi.fn(),
  removeFriend: vi.fn(),
}));

vi.mock("./AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1" }, profile: null, loading: false, refreshProfile: async () => {} }),
}));

import SocialPanel from "./SocialPanel";

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SocialPanel />
    </MemoryRouter>
  );
}

describe("SocialPanel", () => {
  it("renders the Friends heading on dashboard / play / puzzles", () => {
    const { container } = renderAt("/play");
    expect(container.textContent).toMatch(/Friends/);
  });

  // Game routes now keep the panel mounted - users asked to see
  // their friends list while playing so they can challenge a friend
  // straight after the current game ends. Visibility is gated by
  // Tailwind's `hidden 2xl:flex` on the outermost wrapper, so on
  // narrow viewports it never steals layout.
  it("renders the Friends heading on the bot game route", () => {
    const { container } = renderAt("/game");
    expect(container.textContent).toMatch(/Friends/);
  });

  it("renders the Friends heading on the online game route", () => {
    const { container } = renderAt("/game/online/abc-123");
    expect(container.textContent).toMatch(/Friends/);
  });

  it("renders the Friends heading on the variant game route", () => {
    const { container } = renderAt("/variant-game");
    expect(container.textContent).toMatch(/Friends/);
  });

  // Lobby pages (challenge create / accept) stay hidden because
  // they're already centered cards.
  it("renders nothing on the create-challenge route", () => {
    const { container } = renderAt("/create-challenge");
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing on the join-challenge route", () => {
    const { container } = renderAt("/challenge/abcd1234");
    expect(container.innerHTML).toBe("");
  });
});
