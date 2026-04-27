import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("./InteractiveBoard", () => ({
  default: () => <div data-testid="board">board</div>,
}));

vi.mock("./SocialPanel", () => ({ default: () => null }));

vi.mock("../lib/sounds", () => ({
  playMoveSound: vi.fn(),
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
    // The new instruction line + the legacy hint can both contain
    // "Make your move" - we just want to verify *something* shows
    // a prompt to the user about what to do.
    expect(screen.getAllByText(/Make your move|Recall|Reveal/i).length).toBeGreaterThan(0);
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

  it("renders the rich Anki sidebar (queue breakdown + 7-day forecast + state pill)", () => {
    localStorage.setItem("ochess_review_cards", JSON.stringify([
      { id: "p1", type: "puzzle", fen: "8/8/8/8/8/8/8/8 w - - 0 1", ts: 1 },
      { id: "p2", type: "puzzle", fen: "8/8/8/8/8/8/8/8 w - - 0 2", ts: 2 },
    ]));
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>
    );
    // Queue widget: section heading + state rows. Several of the
    // labels also appear in the prompt-header state pill, so we
    // use getAllByText for those.
    expect(screen.getByText(/^Queue$/)).toBeDefined();
    expect(screen.getAllByText(/^New$/).length).toBeGreaterThan(0);
    expect(screen.getByText(/^Learning$/)).toBeDefined();
    expect(screen.getByText(/^Review$/)).toBeDefined();
    expect(screen.getByText(/^Relearning$/)).toBeDefined();
    // Forecast strip is present.
    expect(screen.getByText(/Next 7 days/i)).toBeDefined();
  });

  it("hides the eval-loss bar when eval_loss_cp is 0 (no real loss to show)", () => {
    // Regression: a card with eval_loss_cp === 0 used to render an
    // empty progress bar in CardMetadata, which looked like a UI
    // bug. The hasAny / show-bar guards now require a positive
    // value before rendering.
    localStorage.setItem("ochess_review_cards", JSON.stringify([
      {
        id: "z1",
        type: "mistake",
        fen: "8/8/8/8/8/8/8/8 w - - 0 1",
        eval_loss_cp: 0,
        ts: 1,
      },
    ]));
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>
    );
    // No "Eval loss" label should appear since loss is 0.
    expect(screen.queryByText(/Eval loss/i)).toBeNull();
  });
});
