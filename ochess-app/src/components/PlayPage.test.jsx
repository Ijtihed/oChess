import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

import PlayPage from "./PlayPage";

describe("PlayPage", () => {
  it("renders without errors", () => {
    const { container } = render(
      <MemoryRouter>
        <PlayPage />
      </MemoryRouter>
    );
    expect(container).toBeDefined();
    expect(container.innerHTML).not.toBe("");
  });

  it("shows vs Humans and vs Bots tabs", () => {
    render(
      <MemoryRouter>
        <PlayPage />
      </MemoryRouter>
    );
    expect(screen.getByText("vs Humans")).toBeDefined();
    expect(screen.getByText("vs Bots")).toBeDefined();
  });
});
