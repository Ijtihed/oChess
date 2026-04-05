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
      const response = await fetch("/puzzledb/lichess_db_puzzle.csv");
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
    const response = await fetch("/puzzledb/lichess_db_puzzle.csv");
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
 * Range: playerRating ± spread, biased slightly upward to challenge.
 * If no puzzles in range, widens until something is found.
 */
const recentIds = new Set();
const MAX_RECENT = 50;

function getAdaptivePuzzle(puzzles, playerRating) {
  const bias = 50;
  const target = playerRating + bias;
  for (let spread = 150; spread <= 1000; spread += 100) {
    const candidates = puzzles.filter((p) => p.rating >= target - spread && p.rating <= target + spread && !recentIds.has(p.id));
    if (candidates.length >= 5) {
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      recentIds.add(pick.id);
      if (recentIds.size > MAX_RECENT) { const first = recentIds.values().next().value; recentIds.delete(first); }
      return pick;
    }
  }
  const pick = puzzles[Math.floor(Math.random() * puzzles.length)];
  recentIds.add(pick.id);
  if (recentIds.size > MAX_RECENT) { const first = recentIds.values().next().value; recentIds.delete(first); }
  return pick;
}

function getRandomPuzzle(puzzles, minRating = 0, maxRating = 9999) {
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
