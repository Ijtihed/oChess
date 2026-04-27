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
  // Online-supported is the friend-challenge subset. Use a different
  // set than bot-supported so the two CTAs can be tested independently.
  isOnlineSupportedVariant: (id) => ["chess960", "kingOfTheHill", "threeCheck", "antichess", "horde", "racingKings", "fogOfWar", "standard"].includes(id),
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

  it("shows a disabled 'bot opponent unavailable' label for bot-unsupported variants", () => {
    render(<MemoryRouter><VariantsPage /></MemoryRouter>);
    fireEvent.click(screen.getByText(/^Atomic$/));
    // Atomic isn't in our bot-supported mock list AND not in our
    // online-supported mock list, so the only CTA shown is the
    // disabled "Bot opponent unavailable" label.
    expect(screen.getByText(/Bot opponent unavailable/i)).toBeDefined();
    expect(screen.queryByText(/^Play vs Bot$/)).toBeNull();
  });

  it("Play vs Bot button on a bot-supported variant navigates to /variant-game with state", () => {
    render(<MemoryRouter><VariantsPage /></MemoryRouter>);
    fireEvent.click(screen.getByText(/Chess960/));
    fireEvent.click(screen.getByText(/^Play vs Bot$/));
    expect(navigate).toHaveBeenCalled();
    const [path, opts] = navigate.mock.calls[0];
    expect(path).toBe("/variant-game");
    expect(opts.state.variantId).toBe("chess960");
    expect(opts.state.opponent).toBeDefined();
  });

  it("'Challenge a friend' button on online-supported variants navigates to /create-challenge with the variant", () => {
    render(<MemoryRouter><VariantsPage /></MemoryRouter>);
    fireEvent.click(screen.getByText(/Chess960/));
    const friendBtn = screen.getByText(/Challenge a friend/i);
    fireEvent.click(friendBtn);
    expect(navigate).toHaveBeenCalledWith("/create-challenge?variant=chess960");
  });
});
