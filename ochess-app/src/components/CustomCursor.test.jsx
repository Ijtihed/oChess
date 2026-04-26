import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

import CustomCursor from "./CustomCursor";

// Smoke + selector test: we mount the cursor, then synthesize
// elementFromPoint to point at different DOM nodes and confirm the
// cursor toggles its `cursor--over` class for both real interactive
// elements (button) and Tailwind `.group` wrappers.

describe("CustomCursor", () => {
  it("renders a #custom-cursor element with aria-hidden", () => {
    const { container } = render(<CustomCursor />);
    const dot = container.querySelector("#custom-cursor");
    expect(dot).not.toBeNull();
    expect(dot.getAttribute("aria-hidden")).toBe("true");
  });

  it("scales up over button elements (real interactive)", () => {
    const { container } = render(<CustomCursor />);
    const dot = container.querySelector("#custom-cursor");
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    const orig = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => btn);
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 5 }));
    expect(dot.classList.contains("cursor--over")).toBe(true);
    document.elementFromPoint = orig;
    btn.remove();
  });

  it("also scales up over .group wrappers (custom-cursor rule)", () => {
    const { container } = render(<CustomCursor />);
    const dot = container.querySelector("#custom-cursor");
    const div = document.createElement("div");
    div.className = "group";
    document.body.appendChild(div);
    const orig = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => div);
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 5 }));
    expect(dot.classList.contains("cursor--over")).toBe(true);
    document.elementFromPoint = orig;
    div.remove();
  });

  it("does not scale up over plain text nodes", () => {
    const { container } = render(<CustomCursor />);
    const dot = container.querySelector("#custom-cursor");
    const div = document.createElement("div");
    div.textContent = "plain";
    document.body.appendChild(div);
    const orig = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => div);
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 5 }));
    expect(dot.classList.contains("cursor--over")).toBe(false);
    document.elementFromPoint = orig;
    div.remove();
  });
});
