/**
 * Test shadow of the lenient JSON parser used by the
 * `arena_rules` Edge Function. The Edge Function's parser
 * lives in Deno-only code (supabase/functions/arena_rules/
 * index.ts) and isn't easily importable into vitest, so this
 * file mirrors the same algorithm in plain JS and locks the
 * behavior in place via test cases.
 *
 * If you change the parser in index.ts, mirror the change here
 * and update the test cases. The two implementations should
 * stay byte-for-byte equivalent on the inputs we test.
 */
import { describe, it, expect } from "vitest";

function stripJsComments(src) {
  let out = "";
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < src.length) {
    const c = src[i];
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === inString) inString = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripTrailingCommas(src) {
  let out = "";
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < src.length) {
    const c = src[i];
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === inString) inString = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      out += c;
      i++;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === "}" || src[j] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function extractFirstJsonObject(src) {
  const start = src.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === inString) inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function tolerantParseJson(input) {
  if (typeof input !== "string") return { ok: false, error: "input is not a string" };
  const trimmed = input.trim();
  try { return { ok: true, value: JSON.parse(trimmed) }; } catch { /* */ }
  let cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try { return { ok: true, value: JSON.parse(cleaned) }; } catch { /* */ }
  cleaned = stripJsComments(cleaned);
  try { return { ok: true, value: JSON.parse(cleaned) }; } catch { /* */ }
  cleaned = stripTrailingCommas(cleaned);
  try { return { ok: true, value: JSON.parse(cleaned) }; } catch { /* */ }
  const objSlice = extractFirstJsonObject(cleaned);
  if (objSlice) {
    try { return { ok: true, value: JSON.parse(objSlice) }; }
    catch (e) { return { ok: false, error: `Couldn't parse JSON: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  try {
    JSON.parse(cleaned);
    return { ok: false, error: "Unknown parse failure" };
  } catch (e) {
    return { ok: false, error: `Couldn't parse JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

describe("tolerantParseJson", () => {
  it("happy path: clean JSON", () => {
    const r = tolerantParseJson('{"a":1,"b":[1,2,3]}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1, b: [1, 2, 3] });
  });

  it("strips ```json fences", () => {
    const r = tolerantParseJson('```json\n{"x":42}\n```');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ x: 42 });
  });

  it("strips bare ``` fences", () => {
    const r = tolerantParseJson('```\n{"x":42}\n```');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ x: 42 });
  });

  it("strips trailing comma before ]", () => {
    const r = tolerantParseJson('{"arr":[1,2,3,]}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ arr: [1, 2, 3] });
  });

  it("strips trailing comma before }", () => {
    const r = tolerantParseJson('{"a":1,"b":2,}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1, b: 2 });
  });

  it("strips // line comments", () => {
    const r = tolerantParseJson('{ "a": 1, // a comment\n  "b": 2 }');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1, b: 2 });
  });

  it("strips block comments", () => {
    const r = tolerantParseJson('{ "a": 1, /* nope */ "b": 2 }');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1, b: 2 });
  });

  it("does NOT strip // inside strings", () => {
    const r = tolerantParseJson('{"url":"http://example.com"}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ url: "http://example.com" });
  });

  it("extracts JSON from prose wrapping", () => {
    const r = tolerantParseJson('Here you go:\n\n{"name":"Atomic"}\n\nEnjoy!');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ name: "Atomic" });
  });

  it("repro: trailing comma in nested winConditions", () => {
    // The exact failure mode reported by the user: array
    // element followed by something other than , or ].
    const r = tolerantParseJson(`{
      "extends": "vanilla",
      "winConditions": [
        { "type": "first_to_n_captures", "target": 3 },
        { "type": "checkmate" },
      ]
    }`);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({
      extends: "vanilla",
      winConditions: [
        { type: "first_to_n_captures", target: 3 },
        { type: "checkmate" },
      ],
    });
  });

  it("repro: trailing comment after array element", () => {
    const r = tolerantParseJson(`{
      "moves": [
        { "kind": "leap", "offsets": [[1,2]] }, // knight pattern
        { "kind": "leap", "offsets": [[2,1]] }
      ]
    }`);
    expect(r.ok).toBe(true);
    expect(r.value.moves).toHaveLength(2);
  });

  it("returns ok:false with a readable error on truncated JSON", () => {
    const r = tolerantParseJson('{"name":"Atomic"');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Couldn't parse JSON/i);
  });

  it("returns ok:false on non-string input", () => {
    const r = tolerantParseJson(null);
    expect(r.ok).toBe(false);
  });
});
