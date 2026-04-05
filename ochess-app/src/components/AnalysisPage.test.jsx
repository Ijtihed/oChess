import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../lib/engine", () => ({
  init: vi.fn(() => Promise.resolve()),
  evaluate: vi.fn(() => Promise.resolve(null)),
  formatEval: vi.fn(() => "0.0"),
  isReady: vi.fn(() => false),
  destroy: vi.fn(),
}));

vi.mock("../lib/openings", () => ({
  getOpeningName: vi.fn(() => Promise.resolve(null)),
  resetOpeningCache: vi.fn(),
}));

vi.mock("../lib/sounds", () => ({
  playMoveSound: vi.fn(),
}));

vi.mock("../lib/board-prefs", () => ({
  load: vi.fn(() => ({ boardTheme: "default", pieceSet: "default" })),
  getTheme: vi.fn(() => ({})),
}));

vi.mock("./InteractiveBoard", () => ({
  default: () => <div data-testid="board">Board</div>,
}));

vi.mock("react-chessboard", () => ({
  Chessboard: () => <div data-testid="chessboard">Chessboard</div>,
}));

vi.mock("./SocialPanel", () => ({
  default: () => <div data-testid="social">Social</div>,
}));

import AnalysisPage from "./AnalysisPage";

describe("AnalysisPage", () => {
  it("renders without errors", () => {
    const { container } = render(
      <MemoryRouter>
        <AnalysisPage />
      </MemoryRouter>
    );
    expect(container).toBeDefined();
    expect(container.innerHTML).not.toBe("");
  });

  it("shows analysis title", () => {
    const { container } = render(
      <MemoryRouter>
        <AnalysisPage />
      </MemoryRouter>
    );
    expect(container.textContent).toContain("Analysis");
  });
});
