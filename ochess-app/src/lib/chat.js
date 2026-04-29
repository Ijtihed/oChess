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
 * Returns the cleaned text, or null when the message should
 * be dropped entirely.
 */
const BAD_WORDS = new Set([
  "fuck",
  "shit",
  "bitch",
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "cunt",
  "dick",
  "pussy",
  "asshole",
  "bastard",
  "whore",
  "slut",
  "cock",
  "kys",
  "kill yourself",
  "stfu",
]);

export function moderateChat(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  for (const w of BAD_WORDS) {
    if (lower.includes(w)) return null;
  }
  return trimmed.slice(0, 200);
}
