import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./ChessBoard", () => ({
  default: () => <div data-testid="deco-board">Board</div>,
}));

vi.mock("./ActionCards", () => ({
  default: () => <div data-testid="actions">Actions</div>,
}));

vi.mock("./LivePulse", () => ({
  default: () => <div data-testid="pulse">Pulse</div>,
}));

import LandingPage from "./LandingPage";

describe("LandingPage", () => {
  it("renders without errors", () => {
    const { container } = render(<LandingPage onNavigate={vi.fn()} />);
    expect(container).toBeDefined();
    expect(container.innerHTML).not.toBe("");
  });

  it("displays the oChess branding", () => {
    render(<LandingPage onNavigate={vi.fn()} />);
    expect(screen.getByText("oChess")).toBeDefined();
  });
});
