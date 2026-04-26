import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("react-chessboard", () => ({
  Chessboard: () => <div data-testid="chessboard">board</div>,
}));

vi.mock("../lib/puzzles", () => ({
  loadPuzzles: vi.fn(() => Promise.resolve([])),
  loadPuzzleRating: vi.fn(() => ({ rating: 1500, rd: 350, games: 0 })),
  getAdaptivePuzzle: vi.fn(() => null),
}));

vi.mock("../lib/board-prefs", () => ({
  load: () => ({ pieceSet: "cburnett", boardTheme: "dark" }),
  getTheme: () => ({ id: "dark", type: "color", light: "#3e3e3e", dark: "#272727" }),
}));

vi.mock("./LivePulse", () => ({ default: () => <div data-testid="pulse">pulse</div> }));
vi.mock("./SocialPanel", () => ({ default: () => <div data-testid="social">social</div> }));

import Dashboard from "./Dashboard";

describe("Dashboard", () => {
  it("renders a greeting + Quick Play grid for a signed-in user", () => {
    render(
      <MemoryRouter>
        <Dashboard user={{ name: "Alice", id: "u1" }} onNavigate={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByText(/Hey, Alice/i)).toBeDefined();
    expect(screen.getByText(/Quick Play/i)).toBeDefined();
  });

  it("renders Welcome instead of a name for a guest", () => {
    render(
      <MemoryRouter>
        <Dashboard user={{ guest: true, name: "Guest", id: "guest" }} onNavigate={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByText(/Welcome/i)).toBeDefined();
  });

  it("surfaces the Daily Puzzle column heading", () => {
    render(
      <MemoryRouter>
        <Dashboard user={{ name: "Alice", id: "u1" }} onNavigate={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByText(/Daily Puzzle/i)).toBeDefined();
  });
});
