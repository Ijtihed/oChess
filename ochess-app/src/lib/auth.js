/**
 * Auth helpers for oChess using Supabase.
 * Falls back to guest mode when Supabase isn't configured.
 */

import { supabase, isOnline } from "./supabase";

export async function signUp(email, password, username) {
  if (!supabase) throw new Error("Online features not configured");
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { username } },
  });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  if (!supabase) throw new Error("Online features not configured");
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signInWithGoogle() {
  if (!supabase) throw new Error("Online features not configured");
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session || null;
}

export async function getProfile(userId) {
  if (!supabase) return null;
  const { data } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  return data;
}

export async function getProfileByUsername(username) {
  if (!supabase) return null;
  const { data } = await supabase.from("profiles").select("*").eq("username", username).maybeSingle();
  return data;
}

export async function updateProfile(userId, updates) {
  // Refuse silently-succeeding writes when there is no backend. Without
  // this guard the UI would show "Saved!" while the changes vanished
  // on the next page load.
  if (!supabase) throw new Error("Online features not configured");
  const clean = {};
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) clean[k] = v;
  }
  clean.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from("profiles")
    .update(clean)
    .eq("id", userId)
    .select()
    .single();
  if (error) {
    console.error("updateProfile error:", error);
    throw new Error(error.message || "Failed to save profile");
  }
  return data;
}

export async function getRatings(userId) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.from("ratings").select("*").eq("user_id", userId);
    if (error) { console.error("[auth] getRatings error:", error.message, error.code, error.details); return []; }
    console.log("[auth] getRatings:", data?.length || 0, "ratings for", userId);
    return data || [];
  } catch (e) { console.error("[auth] getRatings exception:", e); return []; }
}

export async function getRecentGames(userId, limit = 20) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from("games")
      .select("*")
      .or(`white_id.eq.${userId},black_id.eq.${userId}`)
      .eq("status", "completed")
      .order("ended_at", { ascending: false })
      .limit(limit);
    if (error) return [];
    return data || [];
  } catch { return []; }
}

export function onAuthChange(callback) {
  if (!supabase) return { data: { subscription: { unsubscribe: () => {} } } };
  return supabase.auth.onAuthStateChange(callback);
}
