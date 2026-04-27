/**
 * Profile smoke test.
 *
 * Earlier attempts at a Profile test deadlocked because of the
 * intricate auth + Supabase + localStorage + reactdom-portal
 * machinery the component pulls in. This minimal harness mocks
 * every external surface so the render is purely React + DOM -
 * no real timers, no network, no portals - and just asserts that
 * the page mounts in both the signed-out and signed-in branches.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Hoisted control surface for swapping the auth context per-test.
const { authState } = vi.hoisted(() => ({
  authState: {
    user: null,
    profile: null,
    refreshProfile: () => Promise.resolve(),
  },
}));

vi.mock("./AuthProvider", () => ({
  useAuth: () => authState,
}));

vi.mock("../lib/auth", () => ({
  updateProfile: vi.fn(() => Promise.resolve()),
  uploadAvatar: vi.fn(() => Promise.resolve()),
  getRatings: vi.fn(() => Promise.resolve([])),
  getRecentGames: vi.fn(() => Promise.resolve([])),
  signOut: vi.fn(() => Promise.resolve()),
}));

vi.mock("../lib/supabase", () => ({
  isOnline: () => false,
}));

vi.mock("../lib/puzzles", () => ({
  loadPuzzleRating: () => 1500,
}));

vi.mock("../lib/board-prefs", () => ({
  load: () => ({ pieceSet: "cburnett", board: "wood", showCoords: true }),
}));

vi.mock("./SocialPanel", () => ({ default: () => null }));

import Profile from "./Profile";

beforeEach(() => {
  authState.user = null;
  authState.profile = null;
  cleanup();
  // Profile reads localStorage for puzzle stats; ensure a clean slate
  // and a deterministic streak shape.
  try { window.localStorage.clear(); } catch { /* jsdom handles it */ }
});

describe("Profile (smoke)", () => {
  it("renders the signed-out fallback when no auth user is present", () => {
    render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    );
    // The not-signed-in branch shows a message + a Home CTA.
    expect(screen.getAllByText(/sign in|signed in|profile/i).length).toBeGreaterThan(0);
  });

  it("renders profile view when an auth user is present", () => {
    authState.user = { id: "u1", email: "alice@example.com" };
    authState.profile = {
      id: "u1",
      username: "alice",
      display_name: "Alice",
      bio: null,
      country: null,
      avatar_url: null,
      lichess_username: null,
      chesscom_username: null,
    };
    render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    );
    expect(screen.getAllByText(/Alice|alice/).length).toBeGreaterThan(0);
  });
});
