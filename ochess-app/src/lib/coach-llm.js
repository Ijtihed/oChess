/**
 * Client wrapper for the `coach` Supabase Edge Function.
 *
 * The function used to return a multi-day study plan + per-card
 * insights. That surface was removed in favour of an AI-driven
 * deck generator: the user types a natural-language query in the
 * Plan tab, this wrapper forwards it to the Edge Function, and we
 * receive 1-3 focused decks back ({ name, query, summary }) that
 * the user can save into the deck browser.
 *
 * If Supabase is not configured (offline-only mode) or the
 * function isn't deployed yet, the wrapper returns
 * `{ ok: false, error }` so the UI can surface a clear "AI
 * unavailable" state instead of a thrown promise.
 */

import { supabase } from "./supabase";

/**
 * Send a mistake corpus + a free-text query to the coach Edge
 * Function and return its structured deck list.
 *
 * @param {Array}  mistakes  Cards filtered to type === "mistake"
 *   or "puzzle". We send a slim subset of fields per card; the
 *   FEN is intentionally omitted to lower token cost (the LLM
 *   doesn't need it to pick filters).
 * @param {string} [query]   Free-text drill query. The whole
 *   point of this surface is the user steering with their own
 *   words ("hanging knights in the najdorf"). Optional, but
 *   strongly recommended.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   summary?: string,
 *   decks?: { name: string, query: string, summary: string }[],
 *   model?: string|null,
 *   rateLimit?: { callsInWindow: number, maxCalls: number, windowSeconds: number },
 *   error?: string,
 *   rateLimited?: boolean,
 *   retryAfterSeconds?: number,
 *   callsInWindow?: number,
 *   maxCalls?: number,
 *   windowSeconds?: number,
 * }>}
 */
export async function generateAIDecks({ mistakes, query } = {}) {
  if (!supabase) return { ok: false, error: "Online features not configured." };
  if (!Array.isArray(mistakes) || mistakes.length === 0) {
    return { ok: false, error: "Run analysis first - the AI needs at least one mistake card to work from." };
  }

  const slim = mistakes.slice(0, 30).map((c) => ({
    played_san: c.played_san || null,
    best_san: c.best_san || null,
    eval_loss_cp: c.eval_loss_cp || 0,
    phase: c.phase || null,
    themes: Array.isArray(c.themes) ? c.themes.slice(0, 4) : [],
    opening: c.opening || null,
    source: c.source || null,
    ply: typeof c.ply === "number" ? c.ply : null,
    game_id: c.game_id || null,
  }));

  // Hard timeout. Groq's free tier is fast (~3 s typical) but if
  // the function or network hangs we don't want the UI stuck
  // forever. 30 s is generous and well under the user's patience
  // threshold. supabase.functions.invoke doesn't accept an
  // AbortSignal as of @supabase/supabase-js 2.x, so we race the
  // invoke against a timer instead.
  const timeoutMs = 30_000;
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ __timeout: true }), timeoutMs)
  );

  try {
    const result = await Promise.race([
      supabase.functions.invoke("coach", {
        body: { mistakes: slim, query: query || "" },
      }),
      timeout,
    ]);
    if (result?.__timeout) {
      return { ok: false, error: "AI took too long. Try again in a moment." };
    }
    const { data, error } = result;
    // Rate-limit detection. Edge Function returns 429 with a
    // structured body when the user hits the cap; supabase-js
    // surfaces that as `error.context.status === 429` with the
    // body still parseable in `data`. Pull the structured
    // retry-after fields off either side and pass them up so the
    // UI can render an exact countdown.
    const rateData = data && typeof data === "object" && Number.isFinite(data.retry_after_seconds)
      ? data
      : null;
    const isRateLimited = error?.context?.status === 429 || (rateData && rateData.ok === false && rateData.retry_after_seconds);
    if (isRateLimited && rateData) {
      return {
        ok: false,
        error: rateData.error || `Rate limit reached. Try again in ${rateData.retry_after_seconds}s.`,
        rateLimited: true,
        retryAfterSeconds: Number(rateData.retry_after_seconds) || 0,
        callsInWindow: Number(rateData.calls_in_window) || 0,
        maxCalls: Number(rateData.max_calls) || 0,
        windowSeconds: Number(rateData.window_seconds) || 0,
      };
    }
    if (error) {
      const msg = data?.error || error.message || "AI unavailable";
      return { ok: false, error: msg };
    }
    if (!data || typeof data !== "object") {
      return { ok: false, error: "Empty response from AI." };
    }
    if (data.ok === false) return { ok: false, error: data.error || "AI failed" };

    // Defensive: normalise per-deck fields. Some models hand back
    // wrapper quotes, missing fields, or an empty decks array if
    // the user's query genuinely doesn't match anything in the
    // corpus - all should render as "0 decks generated, refine
    // your query" instead of crashing the UI.
    return {
      ok: true,
      summary: typeof data.summary === "string" ? data.summary : null,
      decks: Array.isArray(data.decks)
        ? data.decks.map((d) => ({
            name: typeof d?.name === "string" ? d.name.trim() : "Untitled deck",
            query: typeof d?.query === "string" ? d.query.trim() : "",
            summary: typeof d?.summary === "string" ? d.summary.trim() : "",
          })).filter((d) => d.name && d.query)
        : [],
      model: data.model || null,
      rateLimit: data.rate_limit && typeof data.rate_limit === "object"
        ? {
            callsInWindow: Number(data.rate_limit.calls_in_window) || 0,
            maxCalls: Number(data.rate_limit.max_calls) || 0,
            windowSeconds: Number(data.rate_limit.window_seconds) || 0,
          }
        : null,
    };
  } catch (e) {
    return { ok: false, error: e?.message || "AI unavailable" };
  }
}

/** Lightweight helper: is the AI deck generator reachable from
 *  the client? True iff Supabase is configured. We intentionally
 *  don't ping the function here - that would cost a real call.
 *  The UI handles 4xx/5xx gracefully so an undeployed function
 *  still surfaces a clean error message rather than a hang. */
export function isAIAvailable() {
  return !!supabase;
}

// Backward-compat shims. Kept so old imports keep working until
// the next round of cleanup. New callers should use
// `generateAIDecks` / `isAIAvailable`.
export const callCoach = generateAIDecks;
export const isCoachAvailable = isAIAvailable;
