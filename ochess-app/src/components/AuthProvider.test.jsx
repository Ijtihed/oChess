import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";

// Hoisted state so the mock factory and the test bodies share refs.
const { state, getProfileMock, syncMock } = vi.hoisted(() => ({
  state: { listener: null, supabaseShape: "online" },
  getProfileMock: { fn: null },
  syncMock: { fn: null },
}));

vi.mock("../lib/supabase", () => ({
  get supabase() {
    if (state.supabaseShape === "offline") return null;
    return {
      auth: {
        onAuthStateChange: (cb) => {
          state.listener = cb;
          return { data: { subscription: { unsubscribe: vi.fn() } } };
        },
      },
    };
  },
}));

vi.mock("../lib/auth", () => ({
  getProfile: (...args) => getProfileMock.fn(...args),
}));

vi.mock("../lib/puzzle-sync", () => ({
  syncPuzzleProgressFromServer: (...args) => syncMock.fn(...args),
}));

import AuthProvider, { useAuth } from "./AuthProvider";

function Probe() {
  const ctx = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(ctx.loading)}</span>
      <span data-testid="user">{ctx.user?.id || ""}</span>
      <span data-testid="profile">{ctx.profile?.username || ""}</span>
    </div>
  );
}

beforeEach(() => {
  state.listener = null;
  state.supabaseShape = "online";
  getProfileMock.fn = vi.fn(() => Promise.resolve({ id: "u1", username: "alice" }));
  syncMock.fn = vi.fn(() => Promise.resolve(null));
});

afterEach(() => { vi.useRealTimers(); });

describe("AuthProvider", () => {
  it("loads the profile when INITIAL_SESSION arrives with a user", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    expect(state.listener).toBeTypeOf("function");
    await act(async () => {
      await state.listener("INITIAL_SESSION", { user: { id: "u1" } });
    });
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("user").textContent).toBe("u1");
    expect(screen.getByTestId("profile").textContent).toBe("alice");
    // Puzzle sync should fire for signed-in INITIAL_SESSION users.
    expect(syncMock.fn).toHaveBeenCalledWith("u1");
  });

  it("clears profile on SIGNED_OUT", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => {
      await state.listener("INITIAL_SESSION", { user: { id: "u1" } });
    });
    await waitFor(() => expect(screen.getByTestId("profile").textContent).toBe("alice"));
    await act(async () => {
      await state.listener("SIGNED_OUT", null);
    });
    expect(screen.getByTestId("user").textContent).toBe("");
    expect(screen.getByTestId("profile").textContent).toBe("");
  });

  it("short-circuits loading when supabase is null (offline mode)", async () => {
    state.supabaseShape = "offline";
    render(<AuthProvider><Probe /></AuthProvider>);
    // No listener attached; loading flips to false immediately.
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(state.listener).toBeNull();
  });

  it("releases the loading gate after the safety timeout fires", async () => {
    vi.useFakeTimers();
    // Don't call the listener at all — simulate a stuck onAuthStateChange.
    render(<AuthProvider><Probe /></AuthProvider>);
    expect(screen.getByTestId("loading").textContent).toBe("true");
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });
});
