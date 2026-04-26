import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

const navigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigate,
}));

import BotsPage from "./BotsPage";

beforeEach(() => { navigate.mockClear(); });

describe("BotsPage", () => {
  it("redirects to /play with the bots tab in state on mount", () => {
    render(<BotsPage />);
    expect(navigate).toHaveBeenCalledWith("/play", { state: { tab: "bots" }, replace: true });
  });

  it("renders nothing", () => {
    const { container } = render(<BotsPage />);
    expect(container.innerHTML).toBe("");
  });
});
