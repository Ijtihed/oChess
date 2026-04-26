/**
 * Server-side puzzle tracking for oChess.
 * All queries use the Supabase SDK so auth headers are automatic.
 */

import { supabase } from "./supabase";

const RATING_KEY = "ochess_puzzle_rating";
const STREAK_KEY = "ochess_puzzle_streak";
const HISTORY_KEY = "ochess_puzzle_history";

export async function savePuzzleAttempt(userId, puzzleId, puzzleRating, result, timeSpentMs) {
  if (!supabase || !userId) return;
  try {
    await supabase.from("puzzle_attempts").insert({
      user_id: userId, puzzle_id: String(puzzleId), puzzle_rating: puzzleRating, result, time_spent_ms: timeSpentMs,
    });
  } catch {}
}

/**
 * Merge local Glicko + streak state with the user's puzzle_progress
 * row on sign-in. The side that has played the most puzzles wins for
 * rating/RD; best_streak is always taken at maximum across the two.
 *
 * Returns the merged values so callers can refresh in-page state, or
 * null when the merge couldn't run (no client / not logged in / DB
 * row missing or unreadable).
 */
export async function syncPuzzleProgressFromServer(userId) {
  if (!supabase || !userId) return null;
  try {
    const { data, error } = await supabase
      .from("puzzle_progress")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;

    const local = (() => {
      try {
        const r = JSON.parse(localStorage.getItem(RATING_KEY) || "null");
        if (r && typeof r.rating === "number") return { rating: r.rating, rd: r.rd || 350, games: r.games || 0 };
      } catch {}
      return { rating: 1500, rd: 350, games: 0 };
    })();
    const localStreak = (() => {
      try { return JSON.parse(localStorage.getItem(STREAK_KEY) || "{}"); } catch { return {}; }
    })();

    const serverGames = (data.puzzles_solved || 0) + (data.puzzles_failed || 0);
    const merged = {
      rating: serverGames > local.games ? Math.round(data.puzzle_rating || 1500) : local.rating,
      rd: serverGames > local.games ? Math.round(data.puzzle_rd || 350) : local.rd,
      games: Math.max(serverGames, local.games),
    };
    const bestStreak = Math.max(data.best_streak || 0, localStreak.best || 0);
    const currentStreak = Math.max(data.current_streak || 0, localStreak.current || 0);

    try {
      localStorage.setItem(RATING_KEY, JSON.stringify(merged));
      localStorage.setItem(STREAK_KEY, JSON.stringify({ current: currentStreak, best: bestStreak }));
    } catch {}

    // Push the merged values back so the server reflects whichever
    // device has the freshest progress.
    try {
      await supabase.from("puzzle_progress").update({
        puzzle_rating: merged.rating,
        puzzle_rd: merged.rd,
        puzzles_solved: Math.max(data.puzzles_solved || 0, (local.games - (data.puzzles_failed || 0)) || 0),
        puzzles_failed: data.puzzles_failed || 0,
        current_streak: currentStreak,
        best_streak: bestStreak,
        updated_at: new Date().toISOString(),
      }).eq("user_id", userId);
    } catch {}

    return { ...merged, current_streak: currentStreak, best_streak: bestStreak };
  } catch { return null; }
}

export async function syncPuzzleProgress(userId, rating, rd, solved, failed, currentStreak, bestStreak) {
  if (!supabase || !userId) return;
  try {
    await supabase.from("puzzle_progress").update({
      puzzle_rating: rating, puzzle_rd: rd,
      puzzles_solved: solved, puzzles_failed: failed,
      current_streak: currentStreak, best_streak: bestStreak,
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);
  } catch {}
}

export async function markDailyPuzzleSolved(userId, date) {
  if (!supabase || !userId) return;
  try {
    await supabase.from("puzzle_progress").update({ daily_puzzle_date: date, daily_puzzle_solved: true }).eq("user_id", userId);
  } catch {}
}

export async function isDailyPuzzleSolved(userId) {
  if (!supabase || !userId) return false;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabase.from("puzzle_progress").select("daily_puzzle_date,daily_puzzle_solved").eq("user_id", userId).maybeSingle();
    return data?.daily_puzzle_date === today && data?.daily_puzzle_solved === true;
  } catch { return false; }
}
