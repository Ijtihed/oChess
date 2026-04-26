import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const { state } = vi.hoisted(() => ({ state: { puzzles: [] } }));

vi.mock("../lib/puzzles", () => ({
  loadPuzzles: vi.fn(() => Promise.resolve(state.puzzles)),
  getAdaptivePuzzle: vi.fn(() => state.puzzles[0]),
  findPuzzleById: vi.fn((list, id) => list.find((p) => p.id === id)),
  searchPuzzleById: vi.fn(() => Promise.resolve(null)),
  loadPuzzleRating: vi.fn(() => ({ rating: 1500, rd: 350, games: 0 })),
  updatePuzzleRating: vi.fn((r) => ({ rating: r, rd: 350, games: 1 })),
}));

vi.mock("../lib/sounds", () => ({
  playMoveSound: vi.fn(),
  playError: vi.fn(),
  playVictory: vi.fn(),
  playDraw: vi.fn(),
  preloadAll: vi.fn(),
}));

vi.mock("../lib/coach", () => ({
  explainPuzzle: vi.fn(() => Promise.resolve("Tactical motif: fork.")),
}));

vi.mock("./InteractiveBoard", () => ({ default: () => <div data-testid="board" /> }));
vi.mock("./LoadingScreen", () => ({ default: ({ message }) => <div data-testid="loading">{message}</div> }));
vi.mock("./SocialPanel", () => ({ default: () => null }));

vi.mock("./AuthProvider", () => ({
  useAuth: () => ({ user: null, profile: null }),
}));

import PuzzlesPage from "./PuzzlesPage";

beforeEach(() => {
  localStorage.clear();
  state.puzzles = [];
});

describe("PuzzlesPage", () => {
  it("shows the loading screen while puzzles are being fetched", () => {
    render(
      <MemoryRouter>
        <PuzzlesPage />
      </MemoryRouter>
    );
    expect(screen.getByTestId("loading")).toBeDefined();
  });

  it("renders the error state when the puzzle DB returns an empty list", async () => {
    state.puzzles = [];
    render(
      <MemoryRouter>
        <PuzzlesPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText(/Puzzles unavailable/i)).toBeDefined());
    expect(screen.getByText(/Retry/i)).toBeDefined();
  });

  it("renders the setup screen when puzzles load and there's no skipSetup flag", async () => {
    state.puzzles = [
      { id: "p1", fen: "4k3/8/8/8/8/8/8/4K3 w - - 0 1", moves: ["e1e2"], rating: 1200, themes: [] },
    ];
    render(
      <MemoryRouter>
        <PuzzlesPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText(/Configure your session/i)).toBeDefined());
  });
});
