/**
 * Translate raw validator error strings into plain-English
 * messages the lobby can show to users. The validator emits
 * machine-readable diagnostics (e.g. "pieces.p.moves[2]:
 * invalid kind 'jump'", "white has zero legal moves from the
 * starting position") that are great for debugging but
 * actively confusing for someone whose prompt just produced
 * a broken variant.
 *
 * This module is the friendly layer:
 *
 *   raw validator errors -> { headline, hint, raw[] }
 *
 * The lobby UI renders the headline + hint in soft amber and
 * keeps the raw diagnostics tucked in a "Show details"
 * disclosure so power users can still inspect them.
 *
 * Keep the mapping table small and pattern-based; we don't
 * want to maintain a giant lookup. New error categories from
 * validator.js should be added here as they show up.
 *
 * @typedef {Object} FriendlyValidationError
 * @property {string}   headline    One-sentence "what's wrong" copy.
 * @property {string}   hint        Actionable suggestion.
 * @property {string[]} raw         Original validator errors so the disclosure can show them.
 */

/**
 * Heuristic patterns mapped to friendly copy. Order matters:
 * the first pattern that matches an error string wins. More
 * specific patterns should appear above the generic catch-all.
 */
const PATTERNS = [
  // ── Starting position ──
  {
    test: (s) => /king starts in check/i.test(s) || /king is in check before/i.test(s),
    cat: "illegal-start",
  },
  {
    test: (s) => /missing the (white|black) king/i.test(s),
    cat: "missing-king",
  },
  {
    test: (s) => /not a valid FEN|startingFen.*invalid/i.test(s),
    cat: "bad-fen",
  },
  {
    test: (s) => /(zero|no) legal moves (from the starting position|for the first mover)/i.test(s),
    cat: "no-legal-moves",
  },
  {
    test: (s) => /one-sided/i.test(s) || /white has zero/i.test(s) || /black has zero/i.test(s),
    cat: "asymmetric",
  },

  // ── Move primitives ──
  {
    test: (s) => /\[0,?\s*0\]|\(0,\s*0\)/i.test(s) || /direction.*\[0,\s*0\]/i.test(s),
    cat: "zero-direction",
  },
  {
    test: (s) => /maxRange/i.test(s) && /1\.\.8|range/i.test(s),
    cat: "bad-range",
  },
  {
    test: (s) => /requires (a )?(dirs|offsets) array/i.test(s) || /missing (dirs|offsets)/i.test(s),
    cat: "missing-array",
  },
  {
    test: (s) => /invalid kind/i.test(s) || /unknown primitive/i.test(s),
    cat: "unknown-primitive",
  },

  // ── Win conditions ──
  {
    test: (s) => /win condition.*type|winCondition.*type/i.test(s) && /unknown|unrecognized|invalid/i.test(s),
    cat: "unknown-win-condition",
  },
  {
    test: (s) => /first_to_n_captures.*target/i.test(s),
    cat: "bad-capture-target",
  },
  {
    test: (s) => /race_to_squares.*(squares|piece)/i.test(s),
    cat: "bad-race-squares",
  },

  // ── Top-level shape ──
  {
    test: (s) => /resolveRules failed/i.test(s) || /extends.*vanilla/i.test(s),
    cat: "bad-shape",
  },
  {
    test: (s) => /maxPlies/i.test(s) && /(10|2000|range)/i.test(s),
    cat: "bad-max-plies",
  },
];

const COPY = {
  "illegal-start": {
    headline: "The opening position would start with one king already in check.",
    hint: "Try wording your prompt so pieces are placed away from each other - e.g. \"both kings start in their home squares but pawns are removed\".",
  },
  "missing-king": {
    headline: "The starting position is missing a king.",
    hint: "If you're using a custom starting setup, make sure both sides have a king on the board.",
  },
  "bad-fen": {
    headline: "The custom starting board the AI generated isn't a valid chess position.",
    hint: "Try a simpler description without specifying exact squares - e.g. \"queens swap places with knights\" instead of giving coordinates.",
  },
  "no-legal-moves": {
    headline: "One side has no legal moves from the very first turn.",
    hint: "The variant might be too restrictive. Try giving pieces more freedom or removing rules that block them entirely.",
  },
  "asymmetric": {
    headline: "The variant is too one-sided - one player would dominate from the start.",
    hint: "Try making changes apply to both colors, or balance the asymmetry (e.g. \"white knights leap twice, black bishops slide twice\").",
  },
  "zero-direction": {
    headline: "The AI tried to give a piece a \"stay in place\" move that would loop forever.",
    hint: "Rephrase to something concrete - e.g. \"knights can leap up to 4 squares\" instead of \"knights can stay still\".",
  },
  "bad-range": {
    headline: "A piece's move range is out of bounds (must be 1\u20138 squares).",
    hint: "Try wording your prompt with smaller numbers - e.g. \"rooks can only move up to 3 squares\" instead of \"a million\".",
  },
  "missing-array": {
    headline: "A piece's movement is missing the directions or offsets it can use.",
    hint: "Be specific about HOW the piece moves - \"diagonally\", \"like a knight\", \"forward only\", etc.",
  },
  "unknown-primitive": {
    headline: "The AI invented a movement type the engine doesn't support.",
    hint: "Stick to natural descriptions - sliding (rook/bishop/queen-style), leaping (knight-style), or stepping (pawn/king-style).",
  },
  "unknown-win-condition": {
    headline: "The win condition the AI suggested isn't supported.",
    hint: "Supported wins: checkmate, capture the king, first to N captures, race a piece to a target square, last side standing. Stick close to one of these.",
  },
  "bad-capture-target": {
    headline: "The \"first to N captures\" target is out of range (must be 1\u201364).",
    hint: "Try a smaller number like \"first to 3 captures\" or \"first to 5 captures\".",
  },
  "bad-race-squares": {
    headline: "The race-to-squares win condition is missing target squares.",
    hint: "Be explicit about where the piece needs to end up - e.g. \"first king to reach the opposite back rank\".",
  },
  "bad-shape": {
    headline: "The AI's rules don't match the engine's expected format.",
    hint: "Try a simpler prompt or rephrase. The AI works best with concrete descriptions like \"pawns move backward\" or \"knights leap twice\".",
  },
  "bad-max-plies": {
    headline: "The game length cap the AI suggested is out of range.",
    hint: "The engine supports games up to 2000 plies (1000 full moves). Don't ask for ultra-long games or instant draws.",
  },
};

const FALLBACK = {
  headline: "The AI couldn't produce a playable variant from that prompt.",
  hint: "Try rephrasing with a simpler, more concrete idea - or pick one of the example chips below the prompt box.",
};

/**
 * Translate an array of raw validator error strings into a
 * single user-friendly object. Picks the most informative
 * matched category; falls back to a generic "try rephrasing"
 * when nothing matches.
 *
 * @param {string[] | string | null} errors
 * @returns {FriendlyValidationError}
 */
export function translateValidatorErrors(errors) {
  const list = Array.isArray(errors)
    ? errors.filter((e) => typeof e === "string")
    : (typeof errors === "string" && errors.trim() ? [errors] : []);

  if (list.length === 0) {
    return { ...FALLBACK, raw: [] };
  }

  for (const err of list) {
    for (const p of PATTERNS) {
      if (p.test(err)) {
        return { ...COPY[p.cat], raw: list };
      }
    }
  }
  return { ...FALLBACK, raw: list };
}

// ── Pre-flight prompt sanity ──

/**
 * Validate the user's prompt BEFORE we burn an API call. Catches
 * obviously-bad inputs that Gemini would either choke on or
 * produce garbage from. Returns null when the prompt looks fine,
 * else a friendly error message.
 *
 * Rules (intentionally lenient - we want to encourage creative
 * prompts, just not actively-broken ones):
 *
 *   - At least 6 characters of actual letters/digits (not just
 *     punctuation or emoji)
 *   - At most 2000 characters (UI also enforces this via maxLength)
 *   - Has at least 2 word-shaped tokens
 *
 * @param {string} prompt
 * @returns {string | null}
 */
export function checkPromptSanity(prompt) {
  if (typeof prompt !== "string") {
    return "Type a description of the variant first.";
  }
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return "Type a description of the variant first.";
  }
  if (trimmed.length > 2000) {
    return "Prompt is too long. Keep it under 2000 characters.";
  }
  // Strip emoji and punctuation. ASCII letters/digits + common
  // accented latin chars count as content. If less than 6 chars
  // of content remain, the prompt is essentially noise.
  const content = trimmed.replace(/[^A-Za-z0-9\u00C0-\u017F]/g, "");
  if (content.length < 6) {
    return "Prompt is too short. Describe the variant in a sentence or two - e.g. \"both kings start in the middle\".";
  }
  // At least two word-shaped tokens (3+ letters each).
  const words = trimmed.match(/[A-Za-z\u00C0-\u017F]{3,}/g) || [];
  if (words.length < 2) {
    return "Prompt needs at least a couple of real words. Try a full sentence describing the variant.";
  }
  return null;
}
