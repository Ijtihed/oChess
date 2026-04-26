import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import LivePulse from "./LivePulse";

describe("LivePulse", () => {
  it("renders the 'oChess is live' status text", () => {
    render(<LivePulse />);
    expect(screen.getByText(/oChess is live/i)).toBeDefined();
  });

  it("renders the 'Free · Open Source' tagline", () => {
    render(<LivePulse />);
    expect(screen.getByText(/Free · Open Source/i)).toBeDefined();
  });

  it("includes an animated ping element", () => {
    const { container } = render(<LivePulse />);
    expect(container.querySelector(".animate-ping")).not.toBeNull();
  });
});
