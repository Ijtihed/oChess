/**
 * Friends system for oChess.
 * All queries use the Supabase SDK so auth headers are managed automatically.
 */

import { supabase } from "./supabase";
import { makeLogger } from "./log";

const { log, error: logErr } = makeLogger("friends");

export async function searchUsers(query, currentUserId) {
  if (!supabase || !query.trim()) return [];
  const q = `%${query.trim()}%`;
  log("searchUsers:", query);
  try {
    const [r1, r2] = await Promise.all([
      supabase.from("profiles").select("id,username,display_name,avatar_url").ilike("username", q).neq("id", currentUserId || "none").limit(10),
      supabase.from("profiles").select("id,username,display_name,avatar_url").ilike("display_name", q).neq("id", currentUserId || "none").limit(10),
    ]);
    const seen = new Set();
    const results = [...(r1.data || []), ...(r2.data || [])]
      .filter((u) => { if (seen.has(u.id)) return false; seen.add(u.id); return true; })
      .slice(0, 10);
    log("searchUsers →", results.length, "results");
    return results;
  } catch (e) { log("searchUsers exception:", e); return []; }
}

export async function sendFriendRequest(userId, friendId) {
  if (!supabase) throw new Error("Not connected");
  if (userId === friendId) throw new Error("Cannot friend yourself");

  const { data: existing } = await supabase
    .from("friendships")
    .select("id,status")
    .or(`and(user_id.eq.${userId},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${userId})`);
  if (existing?.length > 0) {
    if (existing[0].status === "accepted") throw new Error("Already friends");
    throw new Error("Request already pending");
  }

  const { data, error } = await supabase.from("friendships").insert({ user_id: userId, friend_id: friendId, status: "pending" }).select().single();
  if (error) {
    if (error.message?.includes("already exists") || error.code === "23505") throw new Error("Request already pending");
    throw new Error("Failed to send request");
  }
  log("sendFriendRequest ok, id:", data?.id);
  return data;
}

export async function acceptFriendRequest(requestId) {
  if (!supabase) return;
  log("acceptFriendRequest:", requestId);
  const { error } = await supabase.from("friendships").update({ status: "accepted" }).eq("id", requestId);
  if (error) log("acceptFriendRequest failed:", error.message);
}

export async function declineFriendRequest(requestId) {
  if (!supabase) return;
  log("declineFriendRequest:", requestId);
  const { error } = await supabase.from("friendships").delete().eq("id", requestId);
  if (error) log("declineFriendRequest failed:", error.message);
}

export async function removeFriend(friendshipId) {
  if (!supabase) return;
  log("removeFriend:", friendshipId);
  const { error } = await supabase.from("friendships").delete().eq("id", friendshipId);
  if (error) log("removeFriend failed:", error.message);
}

async function getProfilesById(ids) {
  if (!supabase || ids.length === 0) return {};
  log("getProfilesById:", ids.length, "ids:", ids);
  try {
    const { data, error, status } = await supabase.from("profiles").select("id,username,display_name,avatar_url").in("id", ids);
    if (error) logErr("getProfilesById error: HTTP", status, error.message, error.code);
    const map = {};
    for (const p of (data || [])) map[p.id] = p;
    log("getProfilesById →", Object.keys(map).length, "profiles");
    return map;
  } catch (e) { logErr("getProfilesById exception:", e); return {}; }
}

export async function getFriends(userId) {
  if (!supabase) { log("getFriends: no supabase client"); return []; }
  log("getFriends for user:", userId);
  try {
    const { data, error, status } = await supabase
      .from("friendships")
      .select("id,user_id,friend_id")
      .eq("status", "accepted")
      .or(`user_id.eq.${userId},friend_id.eq.${userId}`);
    log("getFriends response: HTTP", status, error ? `ERROR: ${error.message} (code: ${error.code}, details: ${error.details})` : `${data?.length} rows`);
    if (error || !data?.length) return [];
    const otherIds = data.map((f) => f.user_id === userId ? f.friend_id : f.user_id);
    const profiles = await getProfilesById(otherIds);
    const result = data.map((f) => {
      const otherId = f.user_id === userId ? f.friend_id : f.user_id;
      return { friendshipId: f.id, id: otherId, ...(profiles[otherId] || {}) };
    });
    log("getFriends returning:", result.length, "friends:", result.map(f => f.username || f.id));
    return result;
  } catch (e) { logErr("getFriends exception:", e); return []; }
}

export async function getPendingRequests(userId) {
  if (!supabase) { log("getPendingRequests: no supabase"); return { incoming: [], outgoing: [] }; }
  log("getPendingRequests for user:", userId);
  try {
    const [inRes, outRes] = await Promise.all([
      supabase.from("friendships").select("id,user_id").eq("friend_id", userId).eq("status", "pending"),
      supabase.from("friendships").select("id,friend_id").eq("user_id", userId).eq("status", "pending"),
    ]);
    if (inRes.error) logErr("getPendingRequests incoming error:", inRes.error.message, inRes.error.code);
    if (outRes.error) logErr("getPendingRequests outgoing error:", outRes.error.message, outRes.error.code);
    log("getPendingRequests incoming:", inRes.data?.length, "outgoing:", outRes.data?.length);
    const incomingIds = (inRes.data || []).map((r) => r.user_id);
    const profiles = await getProfilesById(incomingIds);
    return {
      incoming: (inRes.data || []).map((r) => ({ requestId: r.id, id: r.user_id, ...(profiles[r.user_id] || {}) })),
      outgoing: (outRes.data || []).map((r) => r.friend_id),
    };
  } catch (e) { logErr("getPendingRequests exception:", e); return { incoming: [], outgoing: [] }; }
}
