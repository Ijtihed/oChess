import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../lib/supabase", () => ({ isOnline: () => true, supabase: null }));

vi.mock("../lib/challenges", () => ({
  createChallenge: vi.fn(),
  getChallenge: vi.fn(() => Promise.resolve(null)),
  acceptChallengeRPC: vi.fn(),
  deleteChallenge: vi.fn(),
  watchChallenge: vi.fn(() => ({ unsubscribe: vi.fn() })),
  pollChallenge: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../lib/auth", () => ({
  getRatings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("./SocialPanel", () => ({ default: () => null }));

vi.mock("./AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "alice@example.com" },
    profile: { id: "u1", username: "alice", display_name: "Alice" },
  }),
}));

import { CreateChallenge, JoinChallenge } from "./ChallengePage";

describe("CreateChallenge", () => {
  it("renders the time-control picker and a Create button", () => {
    render(
      <MemoryRouter initialEntries={["/create-challenge"]}>
        <CreateChallenge />
      </MemoryRouter>
    );
    expect(screen.getByText(/Create challenge/i)).toBeDefined();
    // Time control buttons render the TIME_CONTROLS list - pick one to assert.
    expect(screen.getByText("5+0")).toBeDefined();
  });

  it("exposes a 'Back to Play' affordance pointing at /play", () => {
    render(
      <MemoryRouter initialEntries={["/create-challenge"]}>
        <CreateChallenge />
      </MemoryRouter>
    );
    expect(screen.getByText(/Back to Play/i)).toBeDefined();
  });

  it("describes the page so the user knows what it does", () => {
    render(
      <MemoryRouter initialEntries={["/create-challenge"]}>
        <CreateChallenge />
      </MemoryRouter>
    );
    expect(screen.getByText(/private game link/i)).toBeDefined();
  });
});

describe("JoinChallenge", () => {
  it("renders a 'challenge not found / expired' state when getChallenge returns null", async () => {
    render(
      <MemoryRouter initialEntries={["/challenge/nope0000"]}>
        <Routes>
          <Route path="/challenge/:code" element={<JoinChallenge />} />
        </Routes>
      </MemoryRouter>
    );
    // Loading first, then "not found / expired".
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/expired|not found|invalid/i)).toBeDefined();
  });
});
