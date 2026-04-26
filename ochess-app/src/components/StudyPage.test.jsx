import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const navigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigate,
}));

vi.mock("./ChessBoard", () => ({ default: () => <div data-testid="board" /> }));
vi.mock("./SocialPanel", () => ({ default: () => null }));

import StudyPage from "./StudyPage";

describe("StudyPage", () => {
  it("shows the preview banner and a 'Coming soon' badge", () => {
    navigate.mockClear();
    render(<StudyPage />);
    expect(screen.getByText(/Studies aren't fully wired up yet/i)).toBeDefined();
    expect(screen.getByText(/Coming soon/i)).toBeDefined();
  });

  it("the Open Analysis button navigates to /analysis", () => {
    navigate.mockClear();
    render(<StudyPage />);
    fireEvent.click(screen.getByText(/Open Analysis/i));
    expect(navigate).toHaveBeenCalledWith("/analysis");
  });

  it("the inline Anki link navigates to /review", () => {
    navigate.mockClear();
    render(<StudyPage />);
    fireEvent.click(screen.getByText(/^Anki$/));
    expect(navigate).toHaveBeenCalledWith("/review");
  });
});
