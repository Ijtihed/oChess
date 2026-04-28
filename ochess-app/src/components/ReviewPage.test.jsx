import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("./InteractiveBoard", () => ({
  default: () => <div data-testid="board">board</div>,
}));

vi.mock("./SocialPanel", () => ({ default: () => null }));
vi.mock("./StudyPlanPanel", () => ({ default: () => <div data-testid="plan-panel" /> }));

vi.mock("../lib/sounds", () => ({
  playMoveSound: vi.fn(),
  playVictory: vi.fn(),
  playError: vi.fn(),
}));

import ReviewPage from "./ReviewPage";

beforeEach(() => {
  localStorage.clear();
});

describe("ReviewPage - deck browser (Today tab default view)", () => {
  it("shows the empty state when there are no decks at all", () => {
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>
    );
    expect(screen.getByText(/No (cards|decks) yet/i)).toBeDefined();
  });

  it("renders the deck browser as the default Today view, NOT a card session", () => {
    localStorage.setItem("ochess_review_cards", JSON.stringify([
      { id: "p1", type: "puzzle", fen: "8/8/8/8/8/8/8/8 w - - 0 1", ts: 1 },
      { id: "p2", type: "puzzle", fen: "8/8/8/8/8/8/8/8 w - - 0 2", ts: 2 },
      { id: "m1", type: "mistake", fen: "8/8/8/8/8/8/8/8 w - - 0 3", ts: 3 },
    ]));
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>
    );
    // Built-in section header + deck cards present.
    expect(screen.getByText(/Built-in/i)).toBeDefined();
    expect(screen.getByText(/^Puzzles$/)).toBeDefined();
    expect(screen.getByText(/Game mistakes/i)).toBeDefined();
    expect(screen.getByText(/^Everything$/)).toBeDefined();
    expect(screen.getByText(/^All cards$/)).toBeDefined();
    // Crucially: the deck browser does NOT immediately drop the
    // user into a per-card session. The board mount is gated
    // behind clicking a deck.
    expect(screen.queryByTestId("board")).toBeNull();
  });

  it("renders per-deck card + due counts on the deck cards", () => {
    localStorage.setItem("ochess_review_cards", JSON.stringify([
      { id: "p1", type: "puzzle", fen: "8/8/8/8/8/8/8/8 w - - 0 1", ts: 1 },
      { id: "p2", type: "puzzle", fen: "8/8/8/8/8/8/8/8 w - - 0 2", ts: 2 },
      { id: "m1", type: "mistake", fen: "8/8/8/8/8/8/8/8 w - - 0 3", ts: 3 },
    ]));
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>
    );
    const puzzleRow = screen.getByText(/^Puzzles$/).closest(".group");
    expect(puzzleRow?.textContent).toMatch(/2 cards/);
    expect(puzzleRow?.textContent).toMatch(/2 due/);
    const mistakeRow = screen.getByText(/Game mistakes/i).closest(".group");
    expect(mistakeRow?.textContent).toMatch(/1 card/);
  });

  it("user-saved drill sets surface as decks under 'My decks'", () => {
    localStorage.setItem("ochess_review_cards", JSON.stringify([
      { id: "m1", type: "mistake", fen: "8/8/8/8/8/8/8/8 w - - 0 1",
        themes: ["hanging_queen"], played_san: "Qa5", ts: 1 },
    ]));
    localStorage.setItem("ochess_drill_sets", JSON.stringify([
      { id: "d1", name: "Hanging queens", query: "hanging_queen", chipId: null,
        source: "manual", createdAt: 1, updatedAt: 1 },
    ]));
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>
    );
    expect(screen.getByText(/My decks/i)).toBeDefined();
    expect(screen.getByText(/Hanging queens/i)).toBeDefined();
  });

  it("AI coach drills get an 'AI' badge in the deck browser", () => {
    localStorage.setItem("ochess_review_cards", JSON.stringify([
      { id: "m1", type: "mistake", fen: "8/8/8/8/8/8/8/8 w - - 0 1",
        themes: ["blunder"], ts: 1 },
    ]));
    localStorage.setItem("ochess_drill_sets", JSON.stringify([
      { id: "d-ai", name: "Day 1: Tactical awareness", query: "blunder",
        chipId: null, source: "coach", createdAt: 1, updatedAt: 1 },
    ]));
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>
    );
    const row = screen.getByText(/Day 1: Tactical awareness/i).closest(".group");
    expect(row?.textContent).toMatch(/AI/);
  });

  it("clicking a deck enters a session view with the board mounted", () => {
    localStorage.setItem("ochess_review_cards", JSON.stringify([
      { id: "p1", type: "puzzle",
        fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
        rating: 1300, themes: ["fork"], ts: 1 },
    ]));
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>
    );
    // Deck browser first.
    expect(screen.queryByTestId("board")).toBeNull();
    // Click the Puzzles deck card. There are two clickable elements
    // per row (the main card area + the Study button on the right);
    // either entry point should open the deck.
    const studyButton = screen.getAllByText(/^Study$/)[0];
    fireEvent.click(studyButton);
    // Now the board is mounted + the active-deck banner appears.
    expect(screen.getByTestId("board")).toBeDefined();
    expect(screen.getByText(/Studying/i)).toBeDefined();
    expect(screen.getByText(/Switch deck/i)).toBeDefined();
  });

  it("hides the eval-loss bar when eval_loss_cp is 0 (no real loss to show)", () => {
    // Regression: same as before but tested through the deck-flow.
    localStorage.setItem("ochess_review_cards", JSON.stringify([
      { id: "z1", type: "mistake", fen: "8/8/8/8/8/8/8/8 w - - 0 1",
        eval_loss_cp: 0, ts: 1 },
    ]));
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>
    );
    // Open the Game mistakes deck.
    const studyButton = screen.getAllByText(/^Study$/)[0];
    fireEvent.click(studyButton);
    // Inside the session, no eval-loss panel should render for a
    // zero-loss card.
    expect(screen.queryByText(/Eval loss/i)).toBeNull();
  });
});
