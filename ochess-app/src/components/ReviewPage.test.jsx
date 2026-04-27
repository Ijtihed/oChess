import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("./InteractiveBoard", () => ({
  default: () => <div data-testid="board">board</div>,
}));

vi.mock("./SocialPanel", () => ({ default: () => null }));

vi.mock("../lib/sounds", () => ({
  playVictory: vi.fn(),
  playError: vi.fn(),
}));

import ReviewPage from "./ReviewPage";

beforeEach(() => {
  localStorage.clear();
});

describe("ReviewPage", () => {
  it("shows the empty state when there are no saved review cards", () => {
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>
    );
    // Empty-state copy from the component (Phase 2).
    expect(screen.getByText(/No cards yet/i)).toBeDefined();
  });

  it("renders a card prompt when localStorage has saved review cards", () => {
    localStorage.setItem("ochess_review_cards", JSON.stringify([
      {
        id: "c1",
        type: "puzzle",
        fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
        rating: 1300,
        themes: ["fork"],
        ts: 1,
      },
    ]));
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>
    );
    expect(screen.getAllByText(/Puzzle/).length).toBeGreaterThan(0);
    // The "Recall \u2014 then rate yourself" hint shows when there's no
    // explicit answerMove on the card.
    expect(screen.getByText(/Recall|Make your move/i)).toBeDefined();
  });

  it("renders deck filter chips with counts pulled from the card collection", () => {
    localStorage.setItem("ochess_review_cards", JSON.stringify([
      { id: "c1", type: "puzzle", fen: "8/8/8/8/8/8/8/8 w - - 0 1", ts: 1 },
      { id: "c2", type: "puzzle", fen: "8/8/8/8/8/8/8/8 w - - 0 2", ts: 2 },
      { id: "c3", type: "game",   fen: "8/8/8/8/8/8/8/8 w - - 0 3", ts: 3 },
      { id: "c4", type: "analysis", fen: "8/8/8/8/8/8/8/8 w - - 0 4", ts: 4 },
    ]));
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>
    );
    // Deck chip buttons each render their label and a numeric count
    // in a span. Look up by visible label first, then assert the
    // button's text content includes the expected count.
    const allBtn = screen.getByText("All").closest("button");
    expect(allBtn?.textContent).toMatch(/All\s*4/);
    const puzzleBtn = screen.getByText("Puzzles").closest("button");
    expect(puzzleBtn?.textContent).toMatch(/Puzzles\s*2/);
    const gameBtn = screen.getByText("Games").closest("button");
    expect(gameBtn?.textContent).toMatch(/Games\s*1/);
    const analysisBtn = screen.getByText("Analysis").closest("button");
    expect(analysisBtn?.textContent).toMatch(/Analysis\s*1/);
  });
});
