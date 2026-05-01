/**
 * Read the global ai_settings.disable_drawn_visuals flag and
 * cache it briefly so we don't hammer the DB on every render.
 *
 * The kill switch is a single boolean column on the
 * `ai_settings` singleton row. When set to true, the
 * ArenaVisualOverlay short-circuits to render-nothing across
 * all rooms, regardless of whether the variant emitted visuals.
 *
 * Use case: bad sandbox deploy lands, error volume spikes, an
 * operator flips the flag in the SQL editor, every active
 * client picks up the change within ~30s without redeploying.
 *
 * The cache is per-tab (module-level), 30s TTL. On error we
 * default to "visuals enabled" so the kill switch failing-open
 * (visuals on) is the safer side - we don't want a transient
 * Supabase blip to break visuals globally.
 */

import { supabase } from "../supabase";

let cached = null;
let cacheExpires = 0;
const TTL_MS = 30_000;

/**
 * Returns true iff the operator has flipped the kill switch.
 * On any error, returns false (fail-open).
 *
 * Callers should treat this as a HINT, not a security
 * boundary - the AST validator + sandbox iframe are the real
 * defenses. This is just a "turn it all off if something
 * weird happens" lever.
 */
export async function isVisualsKilled() {
  const now = Date.now();
  if (cached !== null && now < cacheExpires) return cached;
  try {
    const { data, error } = await supabase
      .from("ai_settings")
      .select("disable_drawn_visuals")
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      // Don't poison the cache on transient errors; just don't
      // cache the result so the next call retries.
      return false;
    }
    cached = !!data?.disable_drawn_visuals;
    cacheExpires = now + TTL_MS;
    return cached;
  } catch {
    return false;
  }
}

/**
 * Force-invalidate the cache. Useful when an operator
 * acknowledged a kill-switch flip and wants to verify it took
 * effect immediately.
 */
export function invalidateVisualsKilledCache() {
  cached = null;
  cacheExpires = 0;
}
