/**
 * Supabase service layer for AI Arena rooms.
 *
 * Mirrors the patterns in `lib/online-game.js` so the new
 * route gets the same auth-via-SDK and realtime-channel shape
 * the existing online flow uses. The DB lifecycle is:
 *
 *   createRoom()      INSERT arena_rooms (creator, rules)
 *      |
 *      v
 *   joinRoom()        UPDATE arena_rooms set joiner_*
 *      |
 *      v
 *   updateRoom()      UPDATE arena_rooms set status / round_state /
 *                     match_result. Either side may advance the
 *                     room as the orchestrator dictates.
 *      |
 *      v
 *   appendMove()      INSERT arena_moves (round, ply, move)
 *
 *   subscribeRoom()   on UPDATE arena_rooms WHERE id = roomId
 *   subscribeMoves()  on INSERT arena_moves WHERE room_id = roomId
 *
 * This module is intentionally thin: no orchestration, no
 * client-side rule resolution, no UI knowledge. The /arena
 * components do the orchestration; this module only knows
 * how to read / write rows.
 */

import { supabase, getRealtimeClient } from "../supabase";
import { makeLogger } from "../log";

const { log, error: logErr } = makeLogger("arena/service");

// ── CRUD ───────────────────────────────────────────────────

/**
 * Create a new arena room owned by the signed-in user.
 *
 * @param {Object} params
 * @param {string} params.creatorId
 * @param {string} params.creatorName
 * @param {Object} [params.rulesCreator]   Optional rule diff. Phase 1 may set this immediately at room creation; Phase 2 will gate the prompting step behind a separate UI step.
 * @returns {Promise<{ ok: boolean, room?: Object, error?: string }>}
 */
export async function createRoom({ creatorId, creatorName, rulesCreator } = {}) {
  if (!supabase) return { ok: false, error: "Online features not configured." };
  if (!creatorId) return { ok: false, error: "Sign in required." };
  try {
    const { data, error } = await supabase
      .from("arena_rooms")
      .insert({
        creator_id: creatorId,
        creator_name: creatorName || null,
        rules_creator: rulesCreator || null,
        status: rulesCreator ? "prompting" : "waiting_for_joiner",
      })
      .select()
      .single();
    if (error) {
      logErr("createRoom failed:", error);
      return { ok: false, error: error.message };
    }
    return { ok: true, room: data };
  } catch (e) {
    logErr("createRoom exception:", e);
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

/**
 * Fetch a single room by id. Used by the join page to render
 * the lobby state when the user lands via share link.
 */
export async function getRoom(roomId) {
  if (!supabase) return { ok: false, error: "Online features not configured." };
  if (!roomId) return { ok: false, error: "Missing room id." };
  try {
    const { data, error } = await supabase
      .from("arena_rooms")
      .select("*")
      .eq("id", roomId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: "Room not found." };
    return { ok: true, room: data };
  } catch (e) {
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

/**
 * Claim a waiting room as the joiner. Only succeeds when the
 * row's `joiner_id` is NULL and the caller isn't the creator
 * (RLS enforces both, but we surface a clean error if the
 * UPDATE returns zero rows). Once both rules are stamped, the
 * room is moved to 'prompting' / further status states by
 * `updateRoom`.
 */
export async function joinRoom({ roomId, joinerId, joinerName, rulesJoiner } = {}) {
  if (!supabase) return { ok: false, error: "Online features not configured." };
  if (!roomId || !joinerId) return { ok: false, error: "Missing arguments." };
  try {
    const updates = {
      joiner_id: joinerId,
      joiner_name: joinerName || null,
      updated_at: new Date().toISOString(),
    };
    if (rulesJoiner) updates.rules_joiner = rulesJoiner;
    const { data, error } = await supabase
      .from("arena_rooms")
      .update(updates)
      .eq("id", roomId)
      .is("joiner_id", null)
      .neq("creator_id", joinerId)
      .select()
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: "Couldn't join: room is full or doesn't exist." };
    return { ok: true, room: data };
  } catch (e) {
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

/**
 * Delete a room. Restricted by RLS to the creator. Useful for
 * the host's "Cancel" button while the room is still waiting
 * for an opponent. After both seats are filled, the room is
 * effectively shared property and we shouldn't let one side
 * unilaterally nuke it; the UI gates the cancel affordance to
 * `joiner_id === null`.
 */
export async function deleteRoom(roomId) {
  if (!supabase) return { ok: false, error: "Online features not configured." };
  if (!roomId) return { ok: false, error: "Missing room id." };
  try {
    const { error } = await supabase
      .from("arena_rooms")
      .delete()
      .eq("id", roomId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

/**
 * Generic update: set any subset of fields on the room and
 * touch updated_at. The orchestrator uses this to advance
 * status / round_state / match_result. Realtime subscribers
 * pick up the change via postgres_changes.
 */
export async function updateRoom(roomId, patch) {
  if (!supabase) return { ok: false, error: "Online features not configured." };
  if (!roomId) return { ok: false, error: "Missing room id." };
  try {
    const updates = { ...patch, updated_at: new Date().toISOString() };
    const { data, error } = await supabase
      .from("arena_rooms")
      .update(updates)
      .eq("id", roomId)
      .select()
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: "Update rejected." };
    return { ok: true, room: data };
  } catch (e) {
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

/**
 * Append a move to the round's move log. Called after each
 * confirmed 1v1 move so spectators / refreshes can replay.
 */
export async function appendMove({ roomId, round, ply, fen, move }) {
  if (!supabase) return { ok: false, error: "Online features not configured." };
  if (!roomId || !move?.from || !move?.to) return { ok: false, error: "Missing arguments." };
  try {
    const { error } = await supabase.from("arena_moves").insert({
      room_id: roomId,
      round,
      ply,
      fen,
      move_from: move.from,
      move_to: move.to,
      promotion: move.promotion || null,
      san: move.san || null,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

/**
 * Persist a finished round as a row in the `games` table so it
 * shows up in the players' profile activity. Arena rows are
 * tagged with variant='arena' and is_rated=false so the
 * Glicko-2 update logic skips them - variant rules break the
 * standard rating model.
 *
 * @param {Object} args
 * @param {string} args.roomId
 * @param {Object} args.round                    Round entry from buildRoundEntry().
 * @param {Object} args.creator                  { id, name, color, ratingBefore? }
 * @param {Object} args.joiner                   { id, name, color }
 * @param {string} args.pgn                      Full PGN of the round.
 * @param {Object} args.rulesDiff                The rule diff this round used.
 * @param {string} args.timeControl              "10+0", "1+0", etc.
 */
export async function recordRoundGame({
  roomId, round, creator, joiner, pgn, rulesDiff, timeControl,
} = {}) {
  if (!supabase) return { ok: false, error: "Online features not configured." };
  if (!roomId || !round) return { ok: false, error: "Missing arguments." };
  // Resolve "winner role" -> "result" string for the games
  // table. Same encoding as the regular play flow:
  //   1-0 = white won, 0-1 = black won, 1/2-1/2 = draw.
  let result = "1/2-1/2";
  if (round.winner === "creator") {
    result = creator.color === "w" ? "1-0" : "0-1";
  } else if (round.winner === "joiner") {
    result = joiner.color === "w" ? "1-0" : "0-1";
  }
  const whitePlayer = creator.color === "w" ? creator : joiner;
  const blackPlayer = creator.color === "w" ? joiner : creator;
  // PGN with proper headers so external readers (Lichess /
  // chess.com analysis boards, downloaded PGN viewers) can
  // open the file. The `[Variant "arena"]` tag is non-standard
  // but documents that vanilla rules don't apply.
  const fullPgn = buildArenaPgn({
    whiteName: whitePlayer.name,
    blackName: blackPlayer.name,
    result,
    reason: round.reason,
    endedAt: round.endedAt,
    timeControl,
    moves: pgn,
    arenaRound: String(round.round),
    rulesName: rulesDiff?.name || rulesDiff?.overrides?.name,
  });
  try {
    const { error } = await supabase.from("games").insert({
      white_id: whitePlayer.id,
      black_id: blackPlayer.id,
      white_name: whitePlayer.name || null,
      black_name: blackPlayer.name || null,
      pgn: fullPgn,
      result,
      result_reason: round.reason || "unknown",
      time_control: timeControl || null,
      category: "arena",
      variant: "arena",
      variant_rules: rulesDiff || null,
      arena_room_id: roomId,
      arena_round: String(round.round),
      moves_count: round.plyCount || 0,
      is_rated: false,                  // Glicko skip - see schema comment.
      status: "completed",
      ended_at: round.endedAt || new Date().toISOString(),
    });
    if (error) {
      logErr("recordRoundGame failed:", error);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) {
    logErr("recordRoundGame exception:", e);
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

/**
 * Fetch the move log for a round (or all rounds if omitted).
 * Used to repaint the board on rejoin / spectate.
 */
export async function loadMoves(roomId, round) {
  if (!supabase) return { ok: false, error: "Online features not configured." };
  if (!roomId) return { ok: false, error: "Missing room id." };
  try {
    let q = supabase.from("arena_moves").select("*").eq("room_id", roomId);
    if (Number.isFinite(round)) q = q.eq("round", round);
    q = q.order("round", { ascending: true }).order("ply", { ascending: true });
    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    return { ok: true, moves: data || [] };
  } catch (e) {
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

// ── Realtime ───────────────────────────────────────────────

// ── PGN building ───────────────────────────────────────────

/**
 * Build a complete PGN with the standard seven-tag roster + a
 * couple of arena-specific tags. The body comes from caller-
 * supplied move tokens; we wrap it in headers so viewers /
 * downloads work outside oChess. Non-standard tags (Variant,
 * ArenaRound) are still parseable by every PGN reader I've
 * tested.
 */
function buildArenaPgn({ whiteName, blackName, result, reason, endedAt, timeControl, moves, arenaRound, rulesName }) {
  const dateStamp = (() => {
    try {
      const d = endedAt ? new Date(endedAt) : new Date();
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return `${yyyy}.${mm}.${dd}`;
    } catch { return "????.??.??"; }
  })();
  const safeResult = result || "*";
  const headers = [
    `[Event "oChess Arena"]`,
    `[Site "oChess"]`,
    `[Date "${dateStamp}"]`,
    `[Round "${arenaRound || "?"}"]`,
    `[White "${escapePgnTag(whiteName || "Anonymous")}"]`,
    `[Black "${escapePgnTag(blackName || "Anonymous")}"]`,
    `[Result "${safeResult}"]`,
    `[Variant "arena${rulesName ? `:${escapePgnTag(rulesName)}` : ""}"]`,
    timeControl ? `[TimeControl "${escapePgnTag(timeControl)}"]` : null,
    reason ? `[Termination "${escapePgnTag(reason)}"]` : null,
  ].filter(Boolean);
  const body = (moves || "").trim();
  return `${headers.join("\n")}\n\n${body}${body ? " " : ""}${safeResult}`;
}

/** Escape characters that would break a PGN tag value. */
function escapePgnTag(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").slice(0, 200);
}

/**
 * Subscribe to UPDATE events on a single room row. Called by
 * the lobby + session UI to react when the OTHER player's
 * actions land. Returns an unsubscribe function. Caller must
 * call it on unmount.
 */
export function subscribeRoom(roomId, onUpdate) {
  if (!supabase || !roomId) return () => {};
  const client = getRealtimeClient();
  if (!client) return () => {};
  const channel = client
    .channel(`arena_room_${roomId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "arena_rooms", filter: `id=eq.${roomId}` },
      (payload) => {
        try {
          onUpdate?.(payload.new);
        } catch (e) {
          logErr("subscribeRoom callback threw:", e);
        }
      },
    )
    .subscribe((status) => {
      log(`arena_room_${roomId} channel:`, status);
    });
  return () => {
    try {
      client.removeChannel(channel);
    } catch { /* ignore */ }
  };
}

/**
 * Subscribe to INSERT events on the move log. Used by the
 * board UI to apply incoming opponent moves in real time.
 * Returns an unsubscribe function.
 */
export function subscribeMoves(roomId, onMove) {
  if (!supabase || !roomId) return () => {};
  const client = getRealtimeClient();
  if (!client) return () => {};
  const channel = client
    .channel(`arena_moves_${roomId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "arena_moves", filter: `room_id=eq.${roomId}` },
      (payload) => {
        try {
          onMove?.(payload.new);
        } catch (e) {
          logErr("subscribeMoves callback threw:", e);
        }
      },
    )
    .subscribe((status) => {
      log(`arena_moves_${roomId} channel:`, status);
    });
  return () => {
    try {
      client.removeChannel(channel);
    } catch { /* ignore */ }
  };
}
