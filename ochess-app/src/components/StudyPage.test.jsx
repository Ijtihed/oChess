import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const navigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigate,
}));

import StudyPage from "./StudyPage";

describe("StudyPage", () => {
  it("renders the Coming Soon shell with the Study title", () => {
    navigate.mockClear();
    render(<StudyPage />);
    // ComingSoon renders the page name as the h2 title plus the
    // generic "under construction" copy. Don't lock in the exact
    // wording - just assert the user sees Study + the Coming Soon
    // affordance.
    expect(screen.getByRole("heading", { name: /Study/i })).toBeDefined();
    expect(screen.getByText(/Coming Soon/i)).toBeDefined();
  });

  it("the back button navigates to home", () => {
    navigate.mockClear();
    render(<StudyPage />);
    fireEvent.click(screen.getByText(/Back to Home/i));
    expect(navigate).toHaveBeenCalledWith("/");
  });
});
