let puzzleCache = null;
let loading = false;
let loadPromise = null;

const RATING_KEY = "ochess_puzzle_rating";

function parseLine(line) {
  const p = line.split(",");
  if (p.length < 8) return null;
  const rating = parseInt(p[3]);
  if (isNaN(rating)) return null;
  return {
    id: p[0],
    fen: p[1],
    moves: p[2].split(" "),
    rating,
    popularity: parseInt(p[5]) || 0,
    themes: p[7] ? p[7].split(" ").filter(Boolean) : [],
    gameUrl: p[8] || null,
  };
}

async function loadPuzzles(count = 3000) {
  if (puzzleCache) return puzzleCache;
  if (loading) return loadPromise;

  loading = true;
  loadPromise = (async () => {
    try {
      // The deployed CSV (`puzzles.csv`) is a 10k-puzzle sample of the
      // Lichess database, trimmed by `scripts/trim-puzzles.mjs`. The
      // full 1 GB file is gitignored - we ship a curated subset so
      // that Vercel deploys stay under the 100 MB asset limit.
      const response = await fetch("/puzzledb/puzzles.csv");
      if (!response.ok) {
        throw new Error(`puzzle CSV fetch failed: HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let headerSkipped = false;
      const puzzles = [];

      while (puzzles.length < count) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!headerSkipped) { headerSkipped = true; continue; }
          if (!line.trim()) continue;
          const puzzle = parseLine(line);
          if (puzzle) puzzles.push(puzzle);
          if (puzzles.length >= count) break;
        }
      }

      reader.cancel().catch(() => {});
      puzzleCache = puzzles;
      return puzzles;
    } finally {
      loading = false;
    }
  })();

  return loadPromise;
}

function findPuzzleById(puzzles, id) {
  return puzzles.find((p) => p.id === id) || null;
}

async function searchPuzzleById(id) {
  const cached = puzzleCache ? findPuzzleById(puzzleCache, id) : null;
  if (cached) return cached;

  try {
    const response = await fetch("/puzzledb/puzzles.csv");
    if (!response.ok) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let headerSkipped = false;
    let scanned = 0;

    while (scanned < 200000) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!headerSkipped) { headerSkipped = true; continue; }
        scanned++;
        if (line.startsWith(id + ",")) {
          reader.cancel().catch(() => {});
          return parseLine(line);
        }
      }
    }
    reader.cancel().catch(() => {});
  } catch {}
  return null;
}

/**
 * Pick a puzzle near the player's rating.
 *
 * Selection strategy (in order, falling back when each tier exhausts):
 *   1. Within +/- spread of the rating, NOT in recentIds, NOT in
 *      attempted-puzzle history. This is the ideal: novel puzzle near
 *      your level.
 *   2. Within spread, NOT in recentIds, but may have been attempted
 *      historically. Lets a heavy user keep training without running
 *      out - they'll re-encounter old puzzles eventually.
 *   3. Anywhere in the deck - last-resort fallback.
 *
 * `recentIds` tracks the last MAX_RECENT picks within the current
 * session. `getAttemptedIds()` reads localStorage at picker-time so
 * the avoidance survives reloads.
 *
 * Spread widens iteratively when not enough candidates are found.
 */
const recentIds = new Set();
const MAX_RECENT = 50;

function getAttemptedIds() {
  try {
    const h = JSON.parse(localStorage.getItem("ochess_puzzle_history") || "{}");
    return new Set(Object.keys(h));
  } catch { return new Set(); }
}

function rememberPick(id) {
  recentIds.add(id);
  if (recentIds.size > MAX_RECENT) {
    const first = recentIds.values().next().value;
    recentIds.delete(first);
  }
}

function getAdaptivePuzzle(puzzles, playerRating) {
  const bias = 50;
  const target = playerRating + bias;
  const attempted = getAttemptedIds();

  // Tier 1: within rating spread, novel + non-recent.
  for (let spread = 150; spread <= 1000; spread += 100) {
    const candidates = puzzles.filter((p) =>
      p.rating >= target - spread &&
      p.rating <= target + spread &&
      !recentIds.has(p.id) &&
      !attempted.has(p.id)
    );
    if (candidates.length >= 5) {
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      rememberPick(pick.id);
      return pick;
    }
  }

  // Tier 2: within rating spread, non-recent, allow re-encountering
  // historically attempted puzzles. This kicks in when a user has
  // worked through a big chunk of the deck - better to re-train an old
  // puzzle than to silently fail.
  for (let spread = 150; spread <= 1000; spread += 100) {
    const candidates = puzzles.filter((p) =>
      p.rating >= target - spread &&
      p.rating <= target + spread &&
      !recentIds.has(p.id)
    );
    if (candidates.length >= 5) {
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      rememberPick(pick.id);
      return pick;
    }
  }

  // Tier 3: pure random fallback.
  if (puzzles.length === 0) return null;
  const pick = puzzles[Math.floor(Math.random() * puzzles.length)];
  rememberPick(pick.id);
  return pick;
}

function getRandomPuzzle(puzzles, minRating = 0, maxRating = 9999) {
  if (!puzzles || puzzles.length === 0) return null;
  const filtered = puzzles.filter((p) => p.rating >= minRating && p.rating <= maxRating);
  if (filtered.length === 0) return puzzles[Math.floor(Math.random() * puzzles.length)];
  return filtered[Math.floor(Math.random() * filtered.length)];
}

function getPuzzlesByTheme(puzzles, theme) {
  return puzzles.filter((p) => p.themes.includes(theme));
}

/**
 * Glicko-1 rating system.
 * Tracks rating (r), rating deviation (rd), and game count.
 * RD decreases with more games (more confident), increases over time (not implemented yet).
 */
const Q = Math.log(10) / 400;
const DEFAULT_RD = 350;
const MIN_RD = 50;

function g_rd(rd) {
  return 1 / Math.sqrt(1 + 3 * Q * Q * rd * rd / (Math.PI * Math.PI));
}

function loadPuzzleRating() {
  try {
    const d = JSON.parse(localStorage.getItem(RATING_KEY) || "null");
    if (d && typeof d.rating === "number") {
      return { rating: d.rating, rd: d.rd || DEFAULT_RD, games: d.games || 0 };
    }
  } catch {}
  return { rating: 1500, rd: DEFAULT_RD, games: 0 };
}

/**
 * @param {number} puzzleRating
 * @param {boolean} solved
 * @param {object} opts
 * @param {number} opts.timerSec - 0 if no timer, otherwise the timer duration
 * @param {number} opts.timeLeftPct - 0-1, how much time was left (1 = full, 0 = ran out)
 * @param {boolean} opts.usedHints
 */
function updatePuzzleRating(puzzleRating, solved, opts = {}) {
  const pr = loadPuzzleRating();
  const r = pr.rating;
  const rd = Math.max(MIN_RD, pr.rd);
  const puzzleRd = 50;

  const gj = g_rd(puzzleRd);
  const expected = 1 / (1 + Math.pow(10, -gj * (r - puzzleRating) / 400));
  const score = solved ? 1 : 0;

  const dSq = 1 / (Q * Q * gj * gj * expected * (1 - expected));
  let delta = (Q / (1 / (rd * rd) + 1 / dSq)) * gj * (score - expected);

  if (opts.timerSec > 0 && solved) {
    const speedBonus = 1 + 0.3 * (opts.timeLeftPct || 0);
    delta *= speedBonus;
  }
  if (opts.timerSec > 0 && !solved) {
    delta *= 0.8;
  }
  if (opts.usedHints && solved) {
    delta *= 0.6;
  }

  const newR = r + delta;
  const newRd = Math.sqrt(1 / (1 / (rd * rd) + 1 / dSq));

  const updated = {
    rating: Math.max(100, Math.round(newR)),
    rd: Math.max(MIN_RD, Math.round(newRd)),
    games: pr.games + 1,
  };
  try { localStorage.setItem(RATING_KEY, JSON.stringify(updated)); } catch {}
  return updated;
}

export {
  loadPuzzles, findPuzzleById, searchPuzzleById,
  getAdaptivePuzzle, getRandomPuzzle, getPuzzlesByTheme,
  loadPuzzleRating, updatePuzzleRating,
};
