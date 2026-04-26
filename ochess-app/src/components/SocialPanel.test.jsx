import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../lib/supabase", () => ({
  isOnline: () => true,
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

  it("renders nothing on the bot game route", () => {
    const { container } = renderAt("/game");
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing on the online game route", () => {
    const { container } = renderAt("/game/online/abc-123");
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing on the variant game route", () => {
    const { container } = renderAt("/variant-game");
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing on the create-challenge route", () => {
    const { container } = renderAt("/create-challenge");
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing on the join-challenge route", () => {
    const { container } = renderAt("/challenge/abcd1234");
    expect(container.innerHTML).toBe("");
  });
});
