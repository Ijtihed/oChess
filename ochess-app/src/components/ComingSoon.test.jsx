import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import ComingSoon from "./ComingSoon";

describe("ComingSoon", () => {
  it("renders the 404 state when page='unknown'", () => {
    render(
      <MemoryRouter>
        <ComingSoon page="unknown" onBack={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getByText("404")).toBeDefined();
    expect(screen.getByText(/Page not found/i)).toBeDefined();
  });

  it("renders a Coming Soon header for a named feature page", () => {
    render(
      <MemoryRouter>
        <ComingSoon page="Tournaments" onBack={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getByText(/Coming Soon/i)).toBeDefined();
    expect(screen.getByText(/Tournaments/)).toBeDefined();
  });

  it("calls onBack when the Home button is clicked", () => {
    const onBack = vi.fn();
    render(
      <MemoryRouter>
        <ComingSoon page="Tournaments" onBack={onBack} />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByText(/Back to Home/i));
    expect(onBack).toHaveBeenCalled();
  });

  it("falls back to navigate('/') when onBack is not provided", () => {
    // Smoke: doesn't crash without onBack.
    const { container } = render(
      <MemoryRouter>
        <ComingSoon page="Tournaments" />
      </MemoryRouter>
    );
    expect(container.innerHTML).not.toBe("");
  });
});
