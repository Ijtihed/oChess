/**
 * Auth helpers for oChess using Supabase.
 * Falls back to guest mode when Supabase isn't configured.
 */

import { supabase } from "./supabase";
import { makeLogger } from "./log";

const { log: alog, error: aerr } = makeLogger("auth");

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

// Allowlist of profile columns clients are permitted to update.
// Anything else (id, created_at, crazy_arena_lab, etc.) is silently
// dropped before hitting the network. The DB also enforces this via
// `profiles_guard_writes` trigger; the client check is a friendlier
// UI signal so callers can see "tried to set field X" mistakes
// rather than a generic Postgres error.
const PROFILE_UPDATABLE_FIELDS = new Set([
  "username",
  "display_name",
  "avatar_url",
  "bio",
  "country",
  "lichess_username",
  "chesscom_username",
  "board_prefs",
]);

// Username format mirrored from AuthModal.jsx so save-time validation
// matches sign-up validation. Any change here must be mirrored on the
// DB (`profiles_username_format` check constraint).
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export async function updateProfile(userId, updates) {
  // Refuse silently-succeeding writes when there is no backend. Without
  // this guard the UI would show "Saved!" while the changes vanished
  // on the next page load.
  if (!supabase) throw new Error("Online features not configured");
  const clean = {};
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    if (!PROFILE_UPDATABLE_FIELDS.has(k)) continue;
    clean[k] = v;
  }
  if (typeof clean.username === "string" && !USERNAME_RE.test(clean.username)) {
    throw new Error("Username must be 3-20 characters: letters, numbers, and underscores only");
  }
  if (typeof clean.bio === "string" && clean.bio.length > 600) {
    throw new Error("Bio must be 600 characters or fewer");
  }
  if (typeof clean.display_name === "string" && clean.display_name.length > 60) {
    throw new Error("Display name must be 60 characters or fewer");
  }
  clean.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from("profiles")
    .update(clean)
    .eq("id", userId)
    .select()
    .single();
  if (error) {
    aerr("updateProfile error:", error);
    throw new Error(error.message || "Failed to save profile");
  }
  return data;
}

/**
 * Upload an avatar image to Supabase Storage and return the public URL.
 *
 * Uses a single `avatars` bucket keyed by user id so each user can
 * only see / write their own files (the bucket should have RLS that
 * restricts inserts to `auth.uid()::text = (storage.foldername(name))[1]`).
 *
 * @param {string} userId
 * @param {File} file
 * @returns {Promise<string>} public URL of the uploaded image
 */
export async function uploadAvatar(userId, file) {
  if (!supabase) throw new Error("Online features not configured");
  if (!file) throw new Error("No file selected");
  const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  if (!allowed.includes(file.type)) throw new Error("Avatar must be a PNG, JPEG, WEBP, or GIF image");
  const MAX_SIZE = 4 * 1024 * 1024;
  if (file.size > MAX_SIZE) throw new Error("Avatar must be under 4 MB");

  const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
  const path = `${userId}/${Date.now()}.${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from("avatars")
    .upload(path, file, { cacheControl: "3600", upsert: true, contentType: file.type });
  if (uploadErr) throw new Error(uploadErr.message || "Failed to upload avatar");

  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  const url = data?.publicUrl;
  if (!url) throw new Error("Couldn't read public URL for the uploaded image");

  // Best-effort: drop any older avatar files for this user so the
  // bucket doesn't accumulate one orphan per re-upload. Storage RLS
  // already restricts the user to their own folder, so the list +
  // delete here is scoped automatically. Failures don't block the
  // upload itself - the new avatar is already live, this is purely
  // disk-hygiene.
  try {
    const { data: existing } = await supabase.storage.from("avatars").list(userId, { limit: 100 });
    if (Array.isArray(existing)) {
      const orphans = existing
        .filter((f) => f && f.name && `${userId}/${f.name}` !== path)
        .map((f) => `${userId}/${f.name}`);
      if (orphans.length > 0) {
        await supabase.storage.from("avatars").remove(orphans);
      }
    }
  } catch { /* ignore - hygiene only */ }

  await updateProfile(userId, { avatar_url: url });
  return url;
}

export async function getRatings(userId) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.from("ratings").select("*").eq("user_id", userId);
    if (error) { aerr("getRatings error:", error.message, error.code, error.details); return []; }
    alog("getRatings:", data?.length || 0, "ratings for", userId);
    return data || [];
  } catch (e) { aerr("getRatings exception:", e); return []; }
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
