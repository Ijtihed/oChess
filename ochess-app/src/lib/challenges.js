/**
 * Challenge links for oChess.
 * Create a link, share it, opponent opens it → game starts.
 * All casual (unrated) to prevent abuse.
 *
 * Rules:
 * - One active challenge per user at a time
 * - Challenges expire after 15 minutes
 * - Acceptance is atomic via Postgres RPC (no orphan games)
 */

import { supabase } from "./supabase";
import { makeLogger } from "./log";

const { log, error: logErr } = makeLogger("challenge");

const EXPIRE_MINUTES = 15;

function generateCode() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export async function createChallenge(userId, userName, userRating, options) {
  if (!supabase) throw new Error("Not connected");
  log("createChallenge:", { userId, userName, userRating, tc: options.timeControl, color: options.colorPref });

  // Clean up existing challenges by this user
  const { error: delErr } = await supabase.from("challenges").delete().eq("creator_id", userId).eq("status", "waiting");
  if (delErr) logErr("cleanup old challenges error:", delErr.message);

  let attempts = 0;
  while (attempts < 3) {
    const code = generateCode();
    log("attempting insert, code:", code, "attempt:", attempts + 1);
    const { data, error } = await supabase.from("challenges").insert({
      code,
      creator_id: userId,
      creator_name: userName,
      creator_rating: userRating,
      time_control: options.timeControl || "10+0",
      color_pref: options.colorPref || "random",
      status: "waiting",
    }).select().single();
    if (!error) { log("createChallenge OK:", data.id, "code:", data.code); return data; }
    logErr("createChallenge error:", error.code, error.message, error.details, error.hint);
    if (error.code === "23505") { attempts++; continue; }
    throw new Error(error.message || "Failed to create challenge");
  }
  throw new Error("Failed to generate unique code. Try again.");
}

export async function getChallenge(code) {
  if (!supabase) return null;
  log("getChallenge:", code);
  try {
    const { data, error } = await supabase
      .from("challenges")
      .select("*")
      .eq("code", code)
      .eq("status", "waiting")
      .maybeSingle();
    if (error) { logErr("getChallenge error:", error.message); return null; }
    if (!data) { log("getChallenge: not found or not waiting"); return null; }
    const created = new Date(data.created_at).getTime();
    if (Date.now() - created > EXPIRE_MINUTES * 60 * 1000) {
      log("getChallenge: expired");
      try { await supabase.from("challenges").update({ status: "expired" }).eq("id", data.id); } catch {}
      return null;
    }
    log("getChallenge OK:", data.id);
    return data;
  } catch (e) { logErr("getChallenge exception:", e); return null; }
}

export async function acceptChallengeRPC(challengeId, joinerId, joinerName, joinerRating) {
  if (!supabase) throw new Error("Not connected");
  log("acceptChallengeRPC:", { challengeId, joinerId, joinerName, joinerRating });
  const { data, error } = await supabase.rpc("accept_challenge", {
    p_challenge_id: challengeId,
    p_joiner_id: joinerId,
    p_joiner_name: joinerName,
    p_joiner_rating: joinerRating,
  });
  if (error) { logErr("acceptChallengeRPC error:", error.message, error.details); throw new Error(error.message || "Failed to accept challenge"); }
  if (data?.error) { logErr("acceptChallengeRPC server error:", data.error); throw new Error(data.error); }
  log("acceptChallengeRPC OK — game:", data?.id);
  return data;
}

export async function deleteChallenge(challengeId) {
  if (!supabase) return;
  log("deleteChallenge:", challengeId);
  const { error } = await supabase.from("challenges").delete().eq("id", challengeId);
  if (error) logErr("deleteChallenge error:", error.message);
}

export function watchChallenge(challengeId, callback) {
  if (!supabase) return { unsubscribe: () => {} };
  log("watchChallenge:", challengeId);
  const channel = supabase
    .channel(`challenge:${challengeId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "challenges", filter: `id=eq.${challengeId}` }, (payload) => {
      log("challenge UPDATE received:", payload.new?.status);
      callback(payload.new);
    })
    .subscribe((status) => { log("watchChallenge subscription:", status); });
  return { unsubscribe: () => supabase.removeChannel(channel) };
}

export async function pollChallenge(challengeId) {
  if (!supabase) return null;
  const { data, error } = await supabase.from("challenges").select("*").eq("id", challengeId).maybeSingle();
  if (error) logErr("pollChallenge error:", error.message);
  return data;
}
