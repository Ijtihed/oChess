import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const navigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigate,
  // Footer uses <Link> for the Legal section; provide a minimal
  // anchor-equivalent so the import resolves without a real router.
  Link: ({ to, children, ...rest }) => (
    <a href={typeof to === "string" ? to : "#"} {...rest}>{children}</a>
  ),
}));

import Footer from "./Footer";

describe("Footer", () => {
  it("renders the wordmark and tagline", () => {
    render(<Footer />);
    expect(screen.getByText("oChess")).toBeDefined();
    expect(screen.getByText(/Free · Open Source · Fast/i)).toBeDefined();
  });

  it("calls navigate when a Platform link is clicked", () => {
    navigate.mockClear();
    render(<Footer />);
    fireEvent.click(screen.getByText(/^Play$/i));
    expect(navigate).toHaveBeenCalledWith("/play");
    fireEvent.click(screen.getByText(/^Puzzles$/i));
    expect(navigate).toHaveBeenCalledWith("/puzzles");
  });

  it("renders an external GitHub link", () => {
    render(<Footer />);
    const gh = screen.getByText(/GitHub/i).closest("a");
    expect(gh.getAttribute("href")).toMatch(/github\.com/);
    expect(gh.getAttribute("target")).toBe("_blank");
    expect(gh.getAttribute("rel")).toMatch(/noopener/);
  });

  it("displays the current year in the copyright", () => {
    render(<Footer />);
    const year = String(new Date().getFullYear());
    expect(document.body.textContent).toMatch(new RegExp(year));
  });

  it("links to the privacy, terms, and attribution pages", () => {
    render(<Footer />);
    const privacy = screen.getByText("Privacy").closest("a");
    const terms = screen.getByText("Terms").closest("a");
    const attribution = screen.getByText("Attribution").closest("a");
    expect(privacy?.getAttribute("href")).toBe("/legal/privacy");
    expect(terms?.getAttribute("href")).toBe("/legal/terms");
    expect(attribution?.getAttribute("href")).toBe("/legal/attribution");
  });
});
