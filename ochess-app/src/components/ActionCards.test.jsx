import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import ActionCards from "./ActionCards";

describe("ActionCards", () => {
  it("renders the five primary action labels", () => {
    render(<ActionCards onNavigate={vi.fn()} />);
    expect(screen.getByText("Play")).toBeDefined();
    expect(screen.getByText("Anki")).toBeDefined();
    expect(screen.getByText("Play Bot")).toBeDefined();
    expect(screen.getByText("Puzzles")).toBeDefined();
    expect(screen.getByText("Analysis")).toBeDefined();
  });

  it("invokes onNavigate with the action id when a card is clicked", () => {
    const onNavigate = vi.fn();
    render(<ActionCards onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("Play"));
    expect(onNavigate).toHaveBeenCalledWith("play");
    fireEvent.click(screen.getByText("Anki"));
    expect(onNavigate).toHaveBeenCalledWith("review");
    fireEvent.click(screen.getByText("Play Bot"));
    expect(onNavigate).toHaveBeenCalledWith("bots");
    fireEvent.click(screen.getByText("Puzzles"));
    expect(onNavigate).toHaveBeenCalledWith("puzzles");
    fireEvent.click(screen.getByText("Analysis"));
    expect(onNavigate).toHaveBeenCalledWith("analysis");
  });
});
