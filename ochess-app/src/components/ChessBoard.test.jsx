import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import ChessBoard from "./ChessBoard";

describe("ChessBoard (decorative)", () => {
  it("renders 64 square cells by default", () => {
    const { container } = render(<ChessBoard />);
    // The grid uses inline grid-template-columns rather than tailwind's
    // `grid-cols-8`, so locate it via the grid wrapper that holds the
    // 64 children.
    const grids = container.querySelectorAll(".grid");
    const matching = Array.from(grids).find((g) => g.children.length === 64);
    expect(matching).toBeDefined();
  });

  it("renders piece images using the supplied pieceSet prop", () => {
    const board = { id: "wood", name: "wood", src: "/images/board/wood.jpg", type: "image" };
    const { container } = render(<ChessBoard pieceSet="cburnett" board={board} />);
    const imgs = container.querySelectorAll("img");
    // Starting position has 32 pieces.
    expect(imgs.length).toBeGreaterThanOrEqual(32);
    const allSrcs = Array.from(imgs).map((i) => i.getAttribute("src") || "");
    expect(allSrcs.some((s) => s.includes("/cburnett/"))).toBe(true);
  });

  it("forwards a click handler when provided and exposes role=button", () => {
    let clicked = 0;
    const { container } = render(<ChessBoard onClick={() => { clicked += 1; }} />);
    const root = container.firstElementChild;
    expect(root.getAttribute("role")).toBe("button");
    root.click();
    expect(clicked).toBe(1);
  });
});
