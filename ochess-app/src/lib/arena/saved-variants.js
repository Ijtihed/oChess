/**
 * Client API for the saved-variants library.
 *
 * Backed by the arena_saved_variants table + save_arena_variant
 * RPC. Per-user RLS handles read/write authorization; the RPC
 * enforces the 200-per-user cap server-side.
 *
 * Best-effort surfaces: callers should swallow failures rather
 * than treat them as user-visible errors unless they have a
 * specific UI for it (e.g. "save failed - try again later").
 */

import { supabase } from "../supabase";

/**
 * List the caller's saved variants, newest first.
 * @returns {Promise<{ ok: boolean, variants?: Array, error?: string }>}
 */
export async function listSavedVariants(limit = 50) {
  try {
    const { data, error } = await supabase
      .from("arena_saved_variants")
      .select("id, name, description, prompt, rules, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return { ok: false, error: error.message };
    return { ok: true, variants: data || [] };
  } catch (e) {
    return { ok: false, error: e?.message || "list failed" };
  }
}

/**
 * Save a new variant.
 * @param {{ name: string, description?: string, prompt?: string, rules: object }} v
 * @returns {Promise<{ ok: boolean, id?: string, error?: string }>}
 */
export async function saveVariant({ name, description, prompt, rules }) {
  if (!name || !rules) return { ok: false, error: "name and rules required" };
  try {
    const { data, error } = await supabase.rpc("save_arena_variant", {
      p_name: String(name).slice(0, 80),
      p_description: description ? String(description).slice(0, 500) : null,
      p_prompt: prompt ? String(prompt).slice(0, 2000) : null,
      p_rules: rules,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: data };
  } catch (e) {
    return { ok: false, error: e?.message || "save failed" };
  }
}

/**
 * Delete one of the caller's saved variants.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function deleteSavedVariant(id) {
  if (!id) return { ok: false, error: "id required" };
  try {
    const { error } = await supabase
      .from("arena_saved_variants")
      .delete()
      .eq("id", id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || "delete failed" };
  }
}
