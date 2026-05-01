/**
 * Static-parse + structural verification of the iframe runtime
 * source string.
 *
 * The runtime is shipped as a string baked into the React
 * overlay's srcDoc attribute. If it has a JS parse error, the
 * iframe silently fails to initialize and the user sees no
 * visuals + no useful error. There's no compile-time check for
 * the embedded JS because it's a string from the bundler's
 * point of view.
 *
 * This test catches that class of bug at unit-test time:
 *   1. Acorn-parse the embedded <script> body. If it fails,
 *      the runtime would also fail to parse in Chromium.
 *   2. Spot-check that the required runtime symbols are
 *      present (message handler, INIT branch, SCENE branch,
 *      paintScene function). If we accidentally delete one,
 *      the test fails.
 *   3. Spot-check that the embedded PRNG matches the standalone
 *      one's algorithm constants - drift here breaks
 *      cross-client determinism.
 */

import { describe, it, expect } from "vitest";
import { parse } from "acorn";
import { RUNTIME_SOURCE, PROTOCOL_VERSION } from "./runtime-source";

/**
 * Pull the body of the inline <script> element out of the
 * runtime HTML doc. Returns the JS source string ready to feed
 * to acorn.
 */
function extractScript(html) {
  const open = html.indexOf("<script>");
  const close = html.indexOf("</script>", open);
  if (open === -1 || close === -1) {
    throw new Error("could not find <script> in runtime source");
  }
  return html.slice(open + "<script>".length, close);
}

describe("RUNTIME_SOURCE - static structure", () => {
  it("is a non-empty string with a doctype", () => {
    expect(typeof RUNTIME_SOURCE).toBe("string");
    expect(RUNTIME_SOURCE.length).toBeGreaterThan(1000);
    expect(RUNTIME_SOURCE).toMatch(/^<!doctype html>/i);
  });

  it("declares a canvas element with id='c'", () => {
    expect(RUNTIME_SOURCE).toMatch(/<canvas[^>]*id="c"/);
  });

  it("contains a single <script> block", () => {
    const opens = (RUNTIME_SOURCE.match(/<script>/g) || []).length;
    const closes = (RUNTIME_SOURCE.match(/<\/script>/g) || []).length;
    expect(opens).toBe(1);
    expect(closes).toBe(1);
  });

  it("PROTOCOL_VERSION is a positive integer", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe("RUNTIME_SOURCE - embedded JS is parseable", () => {
  const script = extractScript(RUNTIME_SOURCE);

  it("the <script> body parses cleanly with acorn (proxy for: Chromium would parse it)", () => {
    expect(() => parse(script, {
      ecmaVersion: 2022,
      sourceType: "script",
    })).not.toThrow();
  });

  it("uses 'use strict' inside the IIFE", () => {
    expect(script).toMatch(/"use strict"/);
  });

  // Runtime symbol contract - if any of these change shape, the
  // overlay React component will break too.
  it("installs a message handler on the iframe window", () => {
    expect(script).toMatch(/window\.addEventListener\(\s*"message"/);
  });

  it("handles the INIT message type", () => {
    expect(script).toMatch(/msg\.type\s*===\s*"INIT"/);
  });

  it("handles the SCENE message type", () => {
    expect(script).toMatch(/msg\.type\s*===\s*"SCENE"/);
  });

  it("posts READY back to parent after init succeeds", () => {
    expect(script).toMatch(/type:\s*"READY"/);
  });

  it("posts PAINT_DONE after each frame", () => {
    expect(script).toMatch(/type:\s*"PAINT_DONE"/);
  });

  it("defines a paintScene function", () => {
    expect(script).toMatch(/function paintScene\b/);
  });

  it("defines the seeded PRNG factory makeRandom", () => {
    expect(script).toMatch(/function makeRandom\b/);
  });

  it("defines the loop-guard helper that rejects runaway iteration", () => {
    expect(script).toMatch(/function guardFn\b/);
  });

  it("defines the per-slot draw runner runSlotDraw", () => {
    expect(script).toMatch(/function runSlotDraw\b/);
  });

  it("validates the message protocol version on inbound messages", () => {
    expect(script).toMatch(/protocolVersion/);
  });
});

describe("RUNTIME_SOURCE - PRNG algorithm matches the standalone module", () => {
  // The runtime inlines its own copy of xoshiro128+ + the
  // string-to-seed mixer (because the iframe can't import). If
  // the standalone module evolves and the inlined copy doesn't,
  // both clients in a multiplayer match would render different
  // animations. This test confirms the algorithm constants
  // match.
  const script = extractScript(RUNTIME_SOURCE);

  it("uses the same golden-ratio seed constant as standalone makeRandom", () => {
    expect(script).toMatch(/0x9E3779B1/);
  });

  it("uses the same Murmur3 finalizer constants", () => {
    expect(script).toMatch(/0x85ebca6b/);
    expect(script).toMatch(/0xc2b2ae35/);
  });

  it("guards against the all-zero state degenerate case", () => {
    expect(script).toMatch(/if\s*\(\s*\(s0\s*\|\s*s1\s*\|\s*s2\s*\|\s*s3\s*\)\s*===\s*0\s*\)/);
  });
});

describe("RUNTIME_SOURCE - produces a parseable doc when sandboxed", () => {
  // Not literally checking the doc parses as HTML (we don't
  // have an HTML parser in the test environment), but we DO
  // confirm the structure has the bits browsers need.
  it("body precedes script (so the canvas exists when JS runs)", () => {
    const bodyAt = RUNTIME_SOURCE.indexOf("<body>");
    const canvasAt = RUNTIME_SOURCE.indexOf("<canvas");
    const scriptAt = RUNTIME_SOURCE.indexOf("<script>");
    expect(bodyAt).toBeGreaterThan(-1);
    expect(canvasAt).toBeGreaterThan(bodyAt);
    expect(scriptAt).toBeGreaterThan(canvasAt);
  });

  it("html and body have transparent backgrounds (so the chess board shows through)", () => {
    expect(RUNTIME_SOURCE).toMatch(/background:\s*transparent/);
  });
});
