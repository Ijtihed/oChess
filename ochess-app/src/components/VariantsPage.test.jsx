import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const navigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

vi.mock("react-chessboard", () => ({
  Chessboard: () => <div data-testid="cb" />,
}));

vi.mock("../lib/board-prefs", () => ({
  load: () => ({ pieceSet: "cburnett", boardTheme: "dark" }),
  getTheme: () => ({ id: "dark", type: "color", light: "#3e3e3e", dark: "#272727" }),
}));

vi.mock("../lib/variants", () => ({
  // Only chess960 / kingOfTheHill / threeCheck / noCastling are bot-supported.
  isBotSupportedVariant: (id) => ["chess960", "kingOfTheHill", "threeCheck", "noCastling"].includes(id),
}));

vi.mock("./SocialPanel", () => ({ default: () => null }));

import VariantsPage from "./VariantsPage";

beforeEach(() => { navigate.mockClear(); });

describe("VariantsPage", () => {
  it("lists the playable variants with names visible", () => {
    render(<MemoryRouter><VariantsPage /></MemoryRouter>);
    expect(screen.getByText(/Chess960/)).toBeDefined();
    expect(screen.getByText(/Atomic/)).toBeDefined();
    expect(screen.getByText(/Antichess/)).toBeDefined();
  });

  it("shows a 'Friend matches coming soon' button for bot-unsupported variants", () => {
    render(<MemoryRouter><VariantsPage /></MemoryRouter>);
    fireEvent.click(screen.getByText(/^Atomic$/));
    expect(screen.getByText(/Friend matches coming soon/i)).toBeDefined();
    // Bot picker buttons should be disabled — we just verify Play is absent.
    expect(screen.queryByText(/^Play$/)).toBeNull();
  });

  it("Play button on a bot-supported variant navigates to /variant-game with state", () => {
    render(<MemoryRouter><VariantsPage /></MemoryRouter>);
    fireEvent.click(screen.getByText(/Chess960/));
    fireEvent.click(screen.getByText(/^Play$/));
    expect(navigate).toHaveBeenCalled();
    const [path, opts] = navigate.mock.calls[0];
    expect(path).toBe("/variant-game");
    expect(opts.state.variantId).toBe("chess960");
    expect(opts.state.opponent).toBeDefined();
  });
});
