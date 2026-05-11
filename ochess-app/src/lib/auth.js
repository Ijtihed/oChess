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

// Columns safe to expose on a public profile view. Internal flags
// like `crazy_arena_lab` (Crazy Arena lab opt-in) are explicitly
// not in this list - they're owner-only metadata.
const PUBLIC_PROFILE_COLUMNS =
  "id,username,display_name,avatar_url,bio,country,lichess_username,chesscom_username,created_at";

export async function getProfile(userId) {
  if (!supabase) return null;
  // Owner profile: include the (small) set of owner-readable columns.
  // We intentionally do NOT `select("*")` so a future internal-only
  // column landing on `profiles` doesn't accidentally leak into the
  // client surface area.
  const { data } = await supabase
    .from("profiles")
    .select(`${PUBLIC_PROFILE_COLUMNS},board_prefs,crazy_arena_lab,updated_at`)
    .eq("id", userId)
    .maybeSingle();
  return data;
}

export async function getProfileByUsername(username) {
  if (!supabase) return null;
  // Public lookup: only public columns. PublicProfile.jsx never
  // needs board_prefs or crazy_arena_lab, and exposing them here
  // would surface owner-only data to any other authenticated user
  // who knows the username.
  const { data } = await supabase
    .from("profiles")
    .select(PUBLIC_PROFILE_COLUMNS)
    .eq("username", username)
    .maybeSingle();
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

// Username format. Two valid shapes are accepted:
//
//   1. The strict shape we enforce on the AuthModal sign-up form
//      (lowercase letters, must start with a letter): 3-24 chars.
//   2. The legacy / OAuth-trigger shape from handle_new_user, which
//      tacks an md5 suffix onto whatever it could pull out of the
//      OAuth metadata: `<base>_<6 hex chars>`. The `<base>` part
//      can come from `email.split("@")[0]` for a Google user, so
//      it may contain uppercase letters or periods.
//
// We accept either shape on save so an OAuth user can keep their
// auto-generated username without forcing a rename, while a manual
// signup is held to the strict format. The DB does NOT have a
// `profiles_username_format` constraint - this is the only
// validation layer.
const USERNAME_STRICT_RE = /^[a-z][a-z0-9_]{2,23}$/;
const USERNAME_LEGACY_RE = /^[A-Za-z0-9._-]{3,40}$/;

function isValidUsername(name) {
  if (typeof name !== "string") return false;
  return USERNAME_STRICT_RE.test(name) || USERNAME_LEGACY_RE.test(name);
}

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
  // Username column is NOT NULL on the DB. The Profile form sends
  // `username: formData.username || null`, so a user who blanks
  // their username field would otherwise trigger a cryptic
  // "violates not-null constraint" Postgres error here. Catch
  // both `null` and empty/whitespace-only strings up front with
  // the same friendly message the strict-validation branch uses.
  if (clean.username === null || (typeof clean.username === "string" && clean.username.trim() === "")) {
    throw new Error("Username cannot be empty");
  }
  if (typeof clean.username === "string" && !isValidUsername(clean.username)) {
    throw new Error("Username must be 3-24 characters: letters, numbers, and underscores only");
  }
  if (typeof clean.bio === "string" && clean.bio.length > 600) {
    throw new Error("Bio must be 600 characters or fewer");
  }
  if (typeof clean.display_name === "string" && clean.display_name.length > 60) {
    throw new Error("Display name must be 60 characters or fewer");
  }
  // Mirror the DB length caps for the linked-account fields so a
  // typo like a pasted full URL gets a friendly client-side error
  // instead of a Postgres check-constraint rejection.
  if (typeof clean.lichess_username === "string" && clean.lichess_username.length > 40) {
    throw new Error("Lichess username must be 40 characters or fewer");
  }
  if (typeof clean.chesscom_username === "string" && clean.chesscom_username.length > 40) {
    throw new Error("Chess.com username must be 40 characters or fewer");
  }
  if (typeof clean.country === "string" && clean.country.length > 64) {
    throw new Error("Country must be 64 characters or fewer");
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
    // Friendlier surface for the common unique-constraint case so
    // the UI can show "That username is taken" instead of the raw
    // Postgres `duplicate key value violates unique constraint
    // "profiles_username_key"` blob.
    if (error.code === "23505" || /duplicate|unique/i.test(error.message || "")) {
      throw new Error("That username is taken. Pick another.");
    }
    // The NOT NULL constraint on username can still surface here
    // if a future code path bypasses the client-side guard above.
    // Surface a consistent message.
    if (error.code === "23502" || /null value/i.test(error.message || "")) {
      throw new Error("Username cannot be empty");
    }
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
