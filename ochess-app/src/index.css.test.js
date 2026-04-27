import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read directly from the working directory - under Vitest's transform,
// `import.meta.url` for CSS files isn't a `file:` URL we can convert.
const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");

describe("index.css design tokens", () => {
  it("defines the shared button utility classes", () => {
    expect(css).toMatch(/\.btn\s*{/);
    expect(css).toMatch(/\.btn-primary\s*{/);
    expect(css).toMatch(/\.btn-secondary\s*{/);
    expect(css).toMatch(/\.btn-ghost\s*{/);
  });

  it("provides a focus-visible outline on interactive elements", () => {
    expect(css).toMatch(/button:focus-visible/);
    expect(css).toMatch(/input:focus-visible/);
    expect(css).toMatch(/outline:\s*2px solid/);
  });

  it("uses a non-translating fade for page-enter so it doesn't fight anim-fade-up", () => {
    // page-enter must be a fade only (no translateY) - otherwise
    // first-paint headings double-animate and snap. Match either
    // animation: fade-in or fade with no translate keyframe.
    const pageEnter = css.match(/\.page-enter\s*{[^}]*}/);
    expect(pageEnter).toBeTruthy();
    expect(pageEnter[0]).toMatch(/fade-in/);
  });
});
