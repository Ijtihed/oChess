/**
 * Online game service for oChess.
 * All database operations use the Supabase SDK (supabase.from / supabase.rpc)
 * so auth headers are managed automatically — no manual getSession() needed.
 */

import { supabase, getRealtimeClient } from "./supabase";
import { makeLogger } from "./log";

const { log, error: logErr } = makeLogger("online-game");

/**
 * One-shot auth diagnostic — call from a UI surface where you actually
 * want to verify the live session (e.g. a debug button), not from
 * module load. Logging at import time is misleading because the SDK
 * may not have rehydrated the session yet, and the call can race with
 * the AuthProvider listener.
 */
export async function logAuthState() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) logErr("auth session error:", error.message);
    else if (data?.session) log("auth OK — user:", data.session.user?.id, "expires:", new Date(data.session.expires_at * 1000).toLocaleTimeString());
    else log("auth: NO SESSION — requests will use anon key, RLS will block most queries");
  } catch (e) { logErr("logAuthState exception:", e); }
}

// ── Matchmaking ──

export async function createSeek(userId, username, rating, options) {
  if (!supabase) throw new Error("Not connected");
  log("createSeek:", { userId, username, rating, tc: options.timeControl });
  const row = {
    user_id: userId,
    username,
    rating,
    time_control: options.timeControl,
    category: options.category || "blitz",
    variant: options.variant || "standard",
    color_pref: options.colorPref || "random",
    is_rated: options.isRated !== false,
    min_rating: rating - 300,
    max_rating: rating + 300,
  };
  const { data, error } = await supabase.from("seeks").insert(row).select().single();
  if (error) {
    logErr("createSeek error:", error.code, error.message, error.details, error.hint);
    if (error.code === "23505") {
      log("createSeek: unique constraint hit, deleting old seek and retrying");
      await supabase.from("seeks").delete().eq("user_id", userId);
      const retry = await supabase.from("seeks").insert(row).select().single();
      if (retry.error) { logErr("createSeek retry error:", retry.error); throw new Error(retry.error.message || "Failed to create seek"); }
      log("createSeek retry OK:", retry.data?.id);
      return retry.data;
    }
    throw new Error(error.message || "Failed to create seek");
  }
  log("createSeek OK:", data?.id);
  return data;
}

export async function cancelSeek(seekId) {
  if (!supabase) return { ok: false };
  log("cancelSeek:", seekId);
  const { error } = await supabase.from("seeks").delete().eq("id", seekId);
  if (error) logErr("cancelSeek error:", error.message);
  else log("cancelSeek OK");
  return { ok: !error };
}

export async function findMatch(userId, rating, options) {
  if (!supabase) return null;
  log("findMatch:", { userId, rating, tc: options.timeControl });
  try {
    const { data, error } = await supabase
      .from("seeks")
      .select("*")
      .neq("user_id", userId)
      .eq("time_control", options.timeControl)
      .eq("variant", options.variant || "standard")
      .gte("max_rating", rating - 100)
      .lte("min_rating", rating + 100)
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) { logErr("findMatch error:", error.message); return null; }
    log("findMatch result:", data?.length ? data[0].id : "none");
    if (!data?.length) return null;
    return data[0];
  } catch (e) { logErr("findMatch exception:", e); return null; }
}

export async function claimSeekRPC(seekId, claimerId, claimerName, claimerRating) {
  if (!supabase) throw new Error("Not connected");
  log("claimSeekRPC:", { seekId, claimerId, claimerName, claimerRating });
  const { data, error } = await supabase.rpc("claim_seek", {
    p_seek_id: seekId,
    p_claimer_id: claimerId,
    p_claimer_name: claimerName,
    p_claimer_rating: claimerRating,
  });
  if (error) { logErr("claimSeekRPC error:", error.message, error.details, error.hint); throw new Error(error.message || "Failed to claim seek"); }
  if (data?.error) { logErr("claimSeekRPC server error:", data.error); throw new Error(data.error); }
  log("claimSeekRPC OK — game:", data?.id);
  return data;
}

// ── Live game channel ──

export function joinGameChannel(gameId, callbacks) {
  log("joinGameChannel:", gameId);
  const client = getRealtimeClient();
  if (!client) { logErr("joinGameChannel: no realtime client"); return null; }

  const channel = client.channel(`game:${gameId}`, {
    config: { broadcast: { self: false } },
  });

  channel
    .on("broadcast", { event: "move" }, (payload) => { callbacks.onMove?.(payload.payload); })
    .on("broadcast", { event: "resign" }, (payload) => { callbacks.onResign?.(payload.payload); })
    .on("broadcast", { event: "draw_offer" }, (payload) => { callbacks.onDrawOffer?.(payload.payload); })
    .on("broadcast", { event: "draw_accept" }, (payload) => { callbacks.onDrawAccept?.(payload.payload); })
    .on("broadcast", { event: "draw_decline" }, (payload) => { callbacks.onDrawDecline?.(payload.payload); })
    .on("broadcast", { event: "game_over" }, (payload) => { callbacks.onGameOver?.(payload.payload); })
    .on("broadcast", { event: "chat" }, (payload) => { callbacks.onChat?.(payload.payload); })
    .on("broadcast", { event: "rematch_offer" }, (payload) => { callbacks.onRematchOffer?.(payload.payload); })
    .on("broadcast", { event: "rematch_accept" }, (payload) => { callbacks.onRematchAccept?.(payload.payload); })
    .on("broadcast", { event: "rematch_decline" }, (payload) => { callbacks.onRematchDecline?.(payload.payload); })
    .on("presence", { event: "sync" }, () => { callbacks.onPresenceSync?.(channel.presenceState()); })
    .subscribe(async (status) => {
      log("joinGameChannel status:", status);
      if (status === "SUBSCRIBED") {
        try { await channel.track({ online: true, user_id: callbacks.userId }); } catch {}
        callbacks.onConnected?.();
      }
    });

  return {
    channel,
    sendMove(move) { channel.send({ type: "broadcast", event: "move", payload: move }); },
    sendResign(userId) { channel.send({ type: "broadcast", event: "resign", payload: { userId } }); },
    sendDrawOffer(userId) { channel.send({ type: "broadcast", event: "draw_offer", payload: { userId } }); },
    sendDrawAccept(userId) { channel.send({ type: "broadcast", event: "draw_accept", payload: { userId } }); },
    sendDrawDecline(userId) { channel.send({ type: "broadcast", event: "draw_decline", payload: { userId } }); },
    sendGameOver(result) { channel.send({ type: "broadcast", event: "game_over", payload: result }); },
    sendChat(userId, text, name) { channel.send({ type: "broadcast", event: "chat", payload: { userId, text, name } }); },
    sendRematchOffer(userId) { channel.send({ type: "broadcast", event: "rematch_offer", payload: { userId } }); },
    sendRematchAccept(gameData) { channel.send({ type: "broadcast", event: "rematch_accept", payload: gameData }); },
    sendRematchDecline(userId) { channel.send({ type: "broadcast", event: "rematch_decline", payload: { userId } }); },
    leave() { try { channel.untrack(); client.removeChannel(channel); } catch {} },
  };
}

// ── Game completion (server-side rating via RPC) ──

export async function completeGame(gameId, pgn, result, reason, movesCount) {
  if (!supabase) return { ok: false, error: "Not connected" };
  log("completeGame:", { gameId, result, reason, movesCount });
  const { data, error } = await supabase.rpc("glicko2_update", {
    p_game_id: gameId,
    p_result: result,
    p_result_reason: reason,
    p_pgn: pgn,
    p_moves_count: movesCount,
  });
  if (error) { logErr("completeGame error:", error.message); return { ok: false, error: error.message }; }
  if (data?.error) { logErr("completeGame server error:", data.error); return { ok: false, error: data.error }; }
  log("completeGame OK");
  return { ok: true };
}

// ── Save game state to DB (the authoritative write) ──
// Returns a promise so callers *can* await, but the UI never blocks on it.
// The opponent receives this via their Postgres Changes subscription.

export function saveGameStateToDB(gameId, fields) {
  if (!supabase || !gameId) return Promise.resolve();
  return supabase.from("games").update(fields).eq("id", gameId)
    .then(({ error }) => { if (error) logErr("saveGameStateToDB error:", error.message); })
    .catch((e) => logErr("saveGameStateToDB exception:", e));
}

// ── Fetch game row ──

export async function fetchGame(gameId) {
  if (!supabase) return null;
  log("fetchGame:", gameId);
  const { data, error } = await supabase.from("games").select("*").eq("id", gameId).maybeSingle();
  if (error) logErr("fetchGame error:", error.message);
  else log("fetchGame OK:", data ? `status=${data.status}` : "not found");
  return data || null;
}

// ── Subscribe to a game row (Postgres Changes) ──
// Returns a channel handle with an unsubscribe method.
// `onChange(row)` fires every time the row is UPDATEd in the DB.
//
// On (re)connect we also fetch the current row once so any UPDATEs
// that the realtime stream may have missed during a network blip
// are reconciled. This is what keeps a game's state correct when a
// laptop wakes from sleep mid-match.

export function subscribeToGameRow(gameId, onChange) {
  if (!supabase || !gameId) return null;
  log("subscribeToGameRow:", gameId);
  let lastStatus = null;
  const channel = supabase
    .channel(`db-game:${gameId}`)
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${gameId}` },
      (payload) => { log("game row UPDATE received:", payload.new?.status, "moves:", payload.new?.moves_count); onChange(payload.new); }
    )
    .subscribe((status) => {
      log("subscribeToGameRow status:", status);
      // Initial subscribe AND every later resubscribe — refetch.
      if (status === "SUBSCRIBED") {
        const reconnect = lastStatus !== null && lastStatus !== "SUBSCRIBED";
        if (reconnect) log("subscribeToGameRow reconnected — refetching row");
        supabase.from("games").select("*").eq("id", gameId).maybeSingle()
          .then(({ data }) => { if (data) onChange(data); })
          .catch(() => {});
      }
      lastStatus = status;
    });
  return {
    unsubscribe() { supabase.removeChannel(channel); },
  };
}

// ── Fetch user's active game (for resume) ──

export async function getActiveGame(userId) {
  if (!supabase || !userId) return null;
  log("getActiveGame:", userId);
  const { data, error } = await supabase
    .from("games")
    .select("*")
    .or(`white_id.eq.${userId},black_id.eq.${userId}`)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) logErr("getActiveGame error:", error.message);
  else log("getActiveGame:", data ? `found game ${data.id}` : "no active game");
  return data || null;
}

// ── Cancel all seeks by a user (cleanup before creating a new one) ──

export async function cancelAllMySeeks(userId) {
  if (!supabase || !userId) return;
  log("cancelAllMySeeks:", userId);
  const { error } = await supabase.from("seeks").delete().eq("user_id", userId);
  if (error) logErr("cancelAllMySeeks error:", error.message);
  else log("cancelAllMySeeks OK");
}

// ── Create rematch game (atomic, idempotent) ──
// Calls the `create_rematch` RPC, which locks the source row and
// either creates the rematch + stamps `rematch_game_id` in one
// transaction, or returns the already-linked rematch when the
// other client got there first. That way two simultaneous Accepts
// always converge to the same new game row.

export async function createRematchGame(sourceGameId, userId) {
  if (!supabase) return null;
  log("createRematchGame:", { sourceGameId, userId });
  const { data, error } = await supabase.rpc("create_rematch", {
    p_source_game_id: sourceGameId,
    p_user_id: userId,
  });
  if (error) { logErr("createRematchGame error:", error.message); return null; }
  if (data?.error) { logErr("createRematchGame server error:", data.error); return null; }
  log("createRematchGame OK — game:", data?.id);
  return data;
}
