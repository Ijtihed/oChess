import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const profileFixture = { id: "u-other", username: "bob", display_name: "Bob", avatar_url: null };

vi.mock("../lib/auth", () => ({
  getProfileByUsername: vi.fn(() => Promise.resolve(profileFixture)),
  getRatings: vi.fn(() => Promise.resolve([])),
  getRecentGames: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../lib/supabase", () => ({ isOnline: () => true }));

vi.mock("../lib/friends", () => ({
  sendFriendRequest: vi.fn(() => Promise.resolve()),
  getFriends: vi.fn(() => Promise.resolve([])),
  getPendingRequests: vi.fn(() => Promise.resolve({ incoming: [], outgoing: [], outgoingRequestIds: {} })),
  acceptFriendRequest: vi.fn(() => Promise.resolve()),
  declineFriendRequest: vi.fn(() => Promise.resolve()),
}));

vi.mock("./SocialPanel", () => ({ default: () => null }));

vi.mock("./AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "alice@example.com" },
    profile: { id: "u1", username: "alice", display_name: "Alice" },
  }),
}));

import PublicProfile from "./PublicProfile";

describe("PublicProfile", () => {
  it("renders the target user's name and shows the empty 'Recent Games' state", async () => {
    render(
      <MemoryRouter initialEntries={["/u/bob"]}>
        <Routes>
          <Route path="/u/:username" element={<PublicProfile />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("Bob")).toBeDefined());
    expect(screen.getByText(/Recent Games/i)).toBeDefined();
    expect(screen.getByText(/No games yet/i)).toBeDefined();
  });

  it("offers an Add Friend button when there is no existing relationship", async () => {
    render(
      <MemoryRouter initialEntries={["/u/bob"]}>
        <Routes>
          <Route path="/u/:username" element={<PublicProfile />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText(/Add Friend/i)).toBeDefined());
  });
});
