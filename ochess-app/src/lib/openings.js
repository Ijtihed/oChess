/**
 * Opening name lookup using the complete Lichess chess-openings database.
 * 3,663 named openings, keyed by UCI move sequence, loaded from /openings.json.
 * Source: github.com/lichess-org/chess-openings (ECO A00–E99).
 */

let book = null;
let loading = false;
let loadPromise = null;

async function loadBook() {
  if (book) return book;
  if (loading) return loadPromise;
  loading = true;
  loadPromise = fetch("/openings.json")
    .then((r) => { if (!r.ok) throw new Error("fetch failed"); return r.json(); })
    .then((data) => {
      book = data;
      loading = false;
      return book;
    })
    .catch(() => {
      loading = false;
      book = {};
      return book;
    });
  return loadPromise;
}

let lastKnown = null;

export async function getOpeningName(history) {
  if (!history.length) return null;

  const db = await loadBook();

  const parts = history.map((m) => m.from + m.to + (m.promotion || ""));
  const fullKey = parts.join(",");

  if (db[fullKey]) {
    lastKnown = db[fullKey];
    return db[fullKey];
  }

  for (let len = parts.length - 1; len >= 1; len--) {
    const sub = parts.slice(0, len).join(",");
    if (db[sub]) {
      lastKnown = db[sub];
      return db[sub];
    }
  }

  return lastKnown;
}

export async function isBookMove(history, plyUpTo) {
  if (!history || !history.length || plyUpTo <= 0) return false;
  const db = await loadBook();
  const n = Math.max(0, Math.min(plyUpTo, history.length));
  const parts = history.slice(0, n).map((m) => m.from + m.to + (m.promotion || ""));
  return !!db[parts.join(",")];
}

export function resetOpeningCache() {
  lastKnown = null;
}
