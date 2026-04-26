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
    expect(screen.getByText(/Puzzle/)).toBeDefined();
    // The "Recall \u2014 then rate yourself" hint shows when there's no
    // explicit answerMove on the card.
    expect(screen.getByText(/Recall|Make your move/i)).toBeDefined();
  });
});
