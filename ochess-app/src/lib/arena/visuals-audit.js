/**
 * Post a draw error from the iframe sandbox to the
 * arena_visual_errors audit table.
 *
 * The iframe runtime catches every draw exception inside its
 * own try/catch, then postMessages a DRAW_ERROR back to the
 * parent. ArenaVisualOverlay surfaces the message via the
 * onDrawError callback. ArenaRoom calls THIS function to
 * persist it - so we have:
 *
 *   - A history of which prompts produce buggy draws (for
 *     iterating on the system prompt).
 *   - A live feed for the in-room debug panel.
 *   - Eventually, alerting if a single variant exceeds N
 *     errors per minute (auto-disable).
 *
 * Best-effort: failures are swallowed. We don't want a logging
 * blip to break the in-game UX. The RPC itself rate-limits
 * inserts to 60 per user per minute server-side.
 *
 * The local in-memory ring buffer (visuals-error-buffer.js)
 * holds the last ~32 errors regardless of whether the audit
 * insert succeeded - the debug panel reads from it directly,
 * not from the DB.
 */

import { supabase } from "../supabase";

/**
 * Send one draw error to the audit log.
 *
 * @param {Object} err
 * @param {string} err.slot          e.g. "q.aura", "proj.fireball"
 * @param {string} err.message       err.message from the iframe
 * @param {string} [err.stack]       Top 3 lines of err.stack
 * @param {number} [err.ply]         Move counter when the error fired
 * @param {string} [roomId]          Current room id (UUID)
 * @param {string} [variantName]     Snapshot of rules.name for analytics
 */
export async function recordVisualError(err, roomId, variantName) {
  try {
    if (!err || typeof err !== "object") return;
    const slot = String(err.slot || "unknown").slice(0, 128);
    const message = String(err.message || "").slice(0, 4096);
    if (!message) return;
    const stack = err.stack ? String(err.stack).slice(0, 4096) : null;
    const ply = Number.isFinite(err.ply) ? err.ply : null;
    await supabase.rpc("record_arena_visual_error", {
      p_room_id: roomId || null,
      p_slot: slot,
      p_message: message,
      p_stack: stack,
      p_ply: ply,
      p_variant_name: variantName ? String(variantName).slice(0, 256) : null,
    });
  } catch {
    // best-effort; never throw from the logger
  }
}
