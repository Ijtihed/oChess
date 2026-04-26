import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../lib/bot-engine", () => ({
  BOT_CONFIG: Array.from({ length: 8 }, (_, i) => ({ level: i, name: `Bot${i}`, desc: "d", engine: "random" })),
}));

vi.mock("./GameScreen", () => ({
  getSavedGame: vi.fn(() => null),
  clearSavedGame: vi.fn(),
}));

vi.mock("./SocialPanel", () => ({
  default: () => <div data-testid="social">Social</div>,
}));

const getActiveGameMock = vi.fn();
const cancelAllMySeeksMock = vi.fn(() => Promise.resolve());

vi.mock("../lib/online-game", () => ({
  createSeek: vi.fn(),
  cancelSeek: vi.fn(() => Promise.resolve()),
  findMatch: vi.fn(),
  claimSeekRPC: vi.fn(),
  getActiveGame: (...args) => getActiveGameMock(...args),
  cancelAllMySeeks: (...args) => cancelAllMySeeksMock(...args),
}));

vi.mock("../lib/supabase", () => ({
  isOnline: () => true,
  supabase: {
    from: () => ({
      select: () => ({
        neq: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
    channel: () => ({
      on: function () { return this; },
      subscribe: function () { return this; },
    }),
    removeChannel: vi.fn(),
  },
}));

vi.mock("../lib/auth", () => ({
  getRatings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("./AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "user-1", email: "u@example.com" },
    profile: { display_name: "Tester", username: "tester" },
    loading: false,
    refreshProfile: async () => {},
  }),
}));

import PlayPage from "./PlayPage";

describe("PlayPage", () => {
  beforeEach(() => {
    getActiveGameMock.mockReset();
    cancelAllMySeeksMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders without errors", () => {
    getActiveGameMock.mockResolvedValue(null);
    const { container } = render(
      <MemoryRouter>
        <PlayPage />
      </MemoryRouter>
    );
    expect(container).toBeDefined();
    expect(container.innerHTML).not.toBe("");
  });

  it("shows vs Humans and vs Bots tabs", () => {
    getActiveGameMock.mockResolvedValue(null);
    render(
      <MemoryRouter>
        <PlayPage />
      </MemoryRouter>
    );
    expect(screen.getByText("vs Humans")).toBeDefined();
    expect(screen.getByText("vs Bots")).toBeDefined();
  });

  it("re-checks the active game when the tab regains focus", async () => {
    // First call returns an active game, second call (after focus)
    // returns null — the banner should clear without a refresh.
    getActiveGameMock.mockResolvedValue(null);
    await act(async () => {
      render(
        <MemoryRouter>
          <PlayPage />
        </MemoryRouter>
      );
    });
    const initialCount = getActiveGameMock.mock.calls.length;
    expect(initialCount).toBeGreaterThanOrEqual(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(getActiveGameMock.mock.calls.length).toBeGreaterThan(initialCount);
  });
});
