import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import LegalPage from "./LegalPage";

function mountAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/legal/:slug" element={<LegalPage />} />
        <Route path="*" element={<LegalPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("LegalPage", () => {
  it("renders the Privacy page with database-grounded language", () => {
    mountAt("/legal/privacy");
    expect(screen.getByRole("heading", { level: 1, name: /privacy/i })).toBeDefined();
    // Anchored to actual schema tables, not boilerplate.
    expect(screen.getAllByText(/profiles/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Glicko-2/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/pg_cron/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Row-Level Security/).length).toBeGreaterThan(0);
  });

  it("renders the Terms page with the no-engine cheating clause", () => {
    mountAt("/legal/terms");
    expect(screen.getByRole("heading", { level: 1, name: /terms/i })).toBeDefined();
    expect(screen.getAllByText(/chess engine/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Acceptable use/).length).toBeGreaterThan(0);
  });

  it("renders the Attribution page with required upstream credits", () => {
    mountAt("/legal/attribution");
    expect(screen.getByRole("heading", { level: 1, name: /attribution/i })).toBeDefined();
    // Per upstream license requirements:
    expect(screen.getAllByText(/Stockfish/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/GPLv3/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Lichess/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ODbL/).length).toBeGreaterThan(0);
  });

  it("falls back to a 404-ish UI for unknown legal slugs", () => {
    mountAt("/legal/something-not-real");
    expect(screen.getByText(/Legal section not found/i)).toBeDefined();
    // Provides escape links to the real pages.
    expect(screen.getByRole("link", { name: /privacy/i })).toBeDefined();
    expect(screen.getByRole("link", { name: /terms/i })).toBeDefined();
  });

  it("exposes the inter-page tab nav on every valid page", () => {
    mountAt("/legal/privacy");
    const navLinks = screen.getAllByRole("link", { name: /^(privacy|terms|attribution)$/i });
    // 3 nav tabs should always be present.
    expect(navLinks.length).toBeGreaterThanOrEqual(3);
  });
});
