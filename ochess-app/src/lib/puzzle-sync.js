/**
 * Server-side puzzle tracking for oChess.
 * All queries use the Supabase SDK so auth headers are automatic.
 */

import { supabase } from "./supabase";

export async function savePuzzleAttempt(userId, puzzleId, puzzleRating, result, timeSpentMs) {
  if (!supabase || !userId) return;
  try {
    await supabase.from("puzzle_attempts").insert({
      user_id: userId, puzzle_id: String(puzzleId), puzzle_rating: puzzleRating, result, time_spent_ms: timeSpentMs,
    });
  } catch {}
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
