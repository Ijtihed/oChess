/**
 * Shared chat-text moderation. Drops messages that contain
 * any banned word; otherwise truncates to 200 chars to bound
 * the realtime broadcast payload + protect the chat scroll
 * area from a single mega-message.
 *
 * Lives in its own module so the Online Play screen and AI
 * Arena rooms share the same banlist - if it expands it
 * grows in one place.
 *
 * Matching strategy
 * -----------------
 * Two tiers of word-boundary matching, picked per entry:
 *
 *   - Prefix-anchored (`\bword\w*`): the start of the banned
 *     word must sit on a word boundary, but inflections /
 *     suffixes still match. So "fuck" catches "fucking",
 *     "fucker", "fucked"; "shit" catches "shitty",
 *     "shitting"; "bitch" catches "bitches", "bitching".
 *     Used for entries whose only realistic containers are
 *     themselves offensive.
 *
 *   - Strict word (`\bword\b`): exact word, no suffix. Used
 *     for the small set of entries whose substring shows up
 *     inside legitimate English ("Dickens", "cocktail",
 *     "Scunthorpe", "pussycat"). Plain word-boundary keeps
 *     `Scunthorpe` clean automatically (no `\b` inside the
 *     name), but `Dickens` / `cocktail` / `pussycat` start at
 *     a word boundary so they need the trailing `\b` too.
 *
 * Multi-word entries (e.g. "kill yourself") use prefix
 * anchoring on the first token only, so "kill yourself" /
 * "kill yourselves" / "kill yourself now" all match while
 * "killing yourself slowly with sugar" is left alone.
 *
 * Returns the cleaned text, or null when the message should
 * be dropped entirely.
 */
// Prefix-anchored: `\bword\w*` so inflections still match.
// Most entries land here - their substrings only appear in
// other offensive words.
const BAD_WORDS_PREFIX = [
  "fuck",
  "shit",
  "bitch",
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "cunt",
  "asshole",
  "bastard",
  "whore",
  "slut",
  "kys",
  "kill yourself",
  "stfu",
];

// Strict word-only: `\bword\b`. Required when a banned word's
// substring shows up at the start of a legitimate longer word.
// `dick` → Dickens / Dickerson; `cock` → cocktail / shuttlecock;
// `pussy` → pussycat / pussyfoot.
const BAD_WORDS_STRICT = [
  "dick",
  "cock",
  "pussy",
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pre-compile a single union regex with the two boundary
// flavors so moderateChat() stays a single .test() call. We
// rebuild the alternation here rather than constructing two
// separate regexes so the engine can short-circuit on the
// first match across both lists.
const BAD_WORDS_RE = new RegExp(
  [
    `\\b(?:${BAD_WORDS_PREFIX.map(escapeRegex).join("|")})\\w*`,
    `\\b(?:${BAD_WORDS_STRICT.map(escapeRegex).join("|")})\\b`,
  ].join("|"),
  "i"
);

export function moderateChat(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (BAD_WORDS_RE.test(trimmed)) return null;
  return trimmed.slice(0, 200);
}
