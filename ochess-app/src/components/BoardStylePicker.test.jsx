import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const { state } = vi.hoisted(() => ({ state: { saved: null } }));

vi.mock("../lib/board-prefs", () => ({
  PIECE_SETS: ["cburnett", "alpha"],
  COLOR_THEMES: [
    { id: "dark", name: "Dark", light: "#3e3e3e", dark: "#272727", type: "color" },
    { id: "green", name: "Green", light: "#779952", dark: "#466d1d", type: "color" },
  ],
  IMAGE_THEMES: [],
  load: () => state.saved || { pieceSet: "cburnett", boardTheme: "dark" },
  save: (p) => { state.saved = p; },
  getTheme: (id) => ({ id: id || "dark", name: id || "Dark", light: "#3e3e3e", dark: "#272727", type: "color" }),
}));

import BoardStylePicker from "./BoardStylePicker";

beforeEach(() => {
  state.saved = null;
  document.body.style.overflow = "";
});

describe("BoardStylePicker", () => {
  it("renders the floating trigger when closed", () => {
    render(<BoardStylePicker />);
    expect(screen.getByLabelText(/Open board style picker/i)).toBeDefined();
  });

  it("opens a dialog and locks body scroll when triggered", () => {
    render(<BoardStylePicker />);
    fireEvent.click(screen.getByLabelText(/Open board style picker/i));
    expect(screen.getByText(/Board Style/i)).toBeDefined();
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("closes on Escape and restores body scroll", () => {
    render(<BoardStylePicker />);
    fireEvent.click(screen.getByLabelText(/Open board style picker/i));
    expect(document.body.style.overflow).toBe("hidden");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("Cancel restores the original prefs (preview is reverted)", () => {
    state.saved = { pieceSet: "cburnett", boardTheme: "dark" };
    render(<BoardStylePicker />);
    fireEvent.click(screen.getByLabelText(/Open board style picker/i));
    // Click the Green color theme to preview it.
    fireEvent.click(screen.getByText(/^Green$/));
    expect(state.saved.boardTheme).toBe("green");
    // Cancel should call save with the original prefs.
    fireEvent.click(screen.getAllByText(/^Cancel$/)[0]);
    expect(state.saved.boardTheme).toBe("dark");
  });
});
