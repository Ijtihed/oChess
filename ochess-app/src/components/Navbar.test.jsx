import { describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../lib/friends", () => ({
  searchUsers: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../lib/supabase", () => ({
  isOnline: () => true,
}));

import Navbar from "./Navbar";

function renderNavbar(overrides = {}) {
  return render(
    <MemoryRouter>
      <Navbar
        activePage="home"
        onNavigate={() => {}}
        user={null}
        onAuthClick={() => {}}
        {...overrides}
      />
    </MemoryRouter>
  );
}

describe("Navbar", () => {
  it("renders the wordmark", () => {
    renderNavbar();
    expect(screen.getByText("oChess")).toBeDefined();
  });

  it("closes the mobile menu when a pointerdown lands outside the nav", () => {
    renderNavbar();
    const toggle = screen.getByLabelText("Toggle menu");
    act(() => { fireEvent.click(toggle); });
    // After opening, both desktop and mobile copies of "Play" exist.
    expect(screen.getAllByText("Play").length).toBeGreaterThan(1);

    act(() => {
      const evt = new PointerEvent("pointerdown", { bubbles: true });
      document.body.dispatchEvent(evt);
    });

    // Mobile copy should be gone - only the desktop nav copy remains.
    expect(screen.getAllByText("Play").length).toBe(1);
  });
});
