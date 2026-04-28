/**
 * Drill-set storage for the Anki Plan tab.
 *
 * A "drill set" is a saved, named filter over the user's mistake +
 * puzzle corpus. Concretely: a chip id, a free-text query, or both,
 * with a human-readable name attached. The Plan tab can save the
 * current filter as a drill set and surface it as a clickable card
 * later, so a user who keeps coming back to "my hanging-queen
 * blunders" doesn't have to re-type the filter every time.
 *
 * Drill sets do NOT duplicate the underlying mistake cards - they're
 * just persisted filters. That keeps storage cheap, lets new mistakes
 * automatically surface in matching sets the next time the user
 * opens it, and avoids the synchronisation problem of "what happens
 * to the set when the underlying card is deleted".
 *
 * Persisted to localStorage under `ochess_drill_sets`. Storage shape:
 *
 *   [
 *     {
 *       id: "drill-1714248000000-ab12",
 *       name: "Hanging queens",
 *       query: "hanging queen",   // optional, free-text filter
 *       chipId: "hanging_q",      // optional, chip filter
 *       createdAt: 1714248000000,
 *       updatedAt: 1714248000000,
 *     }
 *   ]
 */

const STORAGE_KEY = "ochess_drill_sets";

/** Generate a stable id for a new drill set. */
function newDrillSetId() {
  return `drill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Sanitize untrusted name input. Empty -> auto-named. */
function sanitizeName(name, query, chipId) {
  const trimmed = (typeof name === "string" ? name : "").trim().slice(0, 60);
  if (trimmed) return trimmed;
  // Fall back to a sensible auto-name from the filter. Keeps the
  // list scannable even if the user forgot to name their drill.
  if (query) return `Drill: ${query.slice(0, 40)}`;
  if (chipId) return `Drill: ${chipId.replace(/_/g, " ")}`;
  return "Untitled drill";
}

export function loadDrillSets() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    // Defensive filter: only keep entries that have at least one of
    // (query, chipId) - an empty filter is meaningless and a
    // corrupted write shouldn't surface as a stuck UI row.
    return raw
      .filter((s) => s && typeof s === "object" && s.id)
      .map((s) => ({
        id: String(s.id),
        name: String(s.name || "Untitled drill"),
        query: typeof s.query === "string" ? s.query : "",
        chipId: typeof s.chipId === "string" ? s.chipId : null,
        source: typeof s.source === "string" ? s.source : null,
        // Optional human-readable banner shown above the board
        // when the user studies the deck. Populated by
        // AI-generated decks; empty for hand-saved ones.
        summary: typeof s.summary === "string" ? s.summary : null,
        createdAt: Number.isFinite(s.createdAt) ? s.createdAt : Date.now(),
        updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : Date.now(),
      }))
      .filter((s) => s.query || s.chipId);
  } catch { return []; }
}

export function saveDrillSets(sets) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sets)); } catch {}
}

/**
 * Add or update a drill set. If `set.id` is given and matches an
 * existing entry, that one is replaced (useful for renaming). If
 * `set.id` is missing, a new id is minted.
 *
 * @returns {{ sets: Array, id: string }} updated array + the saved id.
 */
export function addDrillSet(existing, { id, name, query, chipId, source, summary } = {}) {
  // Reject genuinely-empty drills - we don't want a row in the list
  // that filters to "everything".
  if (!query && !chipId) return { sets: existing, id: null };
  const now = Date.now();
  const finalId = id || newDrillSetId();
  const finalName = sanitizeName(name, query, chipId);
  // `source` (optional, free-form) lets callers tag where a drill
  // came from. Currently used values:
  //   "coach"   - AI-generated deck from the Plan tab
  //   "manual"  - the user typed / chipped + clicked Save
  //   "import"  - placeholder for future "import deck" features
  // The browser surfaces an "AI" badge on coach-tagged decks.
  const finalSource = typeof source === "string" ? source : null;
  // Optional 1-2 sentence "what this deck is" banner. Currently
  // only AI-generated decks set it.
  const finalSummary = typeof summary === "string" && summary.trim() ? summary.trim() : null;
  const idx = existing.findIndex((s) => s.id === finalId);
  if (idx >= 0) {
    const next = existing.slice();
    next[idx] = {
      ...next[idx],
      name: finalName,
      query: query || "",
      chipId: chipId || null,
      source: finalSource ?? next[idx].source ?? null,
      summary: finalSummary ?? next[idx].summary ?? null,
      updatedAt: now,
    };
    return { sets: next, id: finalId };
  }
  return {
    sets: [
      ...existing,
      {
        id: finalId,
        name: finalName,
        query: query || "",
        chipId: chipId || null,
        source: finalSource,
        summary: finalSummary,
        createdAt: now,
        updatedAt: now,
      },
    ],
    id: finalId,
  };
}

export function removeDrillSet(existing, id) {
  return existing.filter((s) => s.id !== id);
}

/**
 * Count how many cards from `cards` match a drill set. Used by the
 * UI to render "Hanging queens · 12 cards" next to each row, so the
 * user knows whether a set is still useful before clicking.
 *
 * `matcher` should be the same predicate the SM-2 queue uses
 * (chip.match) so counts and queue stay in sync.
 */
export function countDrillSetCards(set, cards, { chipFor, queryFilter } = {}) {
  let pool = cards.filter((c) => c.type === "mistake" || c.type === "puzzle");
  if (set.chipId && chipFor) {
    const chip = chipFor(set.chipId);
    if (chip) pool = pool.filter(chip.match);
  }
  if (set.query && queryFilter) pool = queryFilter(pool, set.query);
  return pool.length;
}
