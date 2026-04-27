/**
 * Client wrapper for the `coach` Supabase Edge Function.
 *
 * The heavy lifting (Groq call, prompt construction, JSON parsing) is
 * server-side. This file just packages the user's mistake corpus,
 * forwards it through the authenticated Supabase client, and returns
 * the structured plan.
 *
 * If Supabase is not configured (offline-only mode) or the function
 * isn't deployed yet, the wrapper returns `{ ok: false, error }` so
 * the UI can surface a clear "AI coach unavailable" state instead of
 * a thrown promise.
 */

import { supabase } from "./supabase";

/**
 * Send a mistake corpus + optional free-text query to the coach
 * function and return its structured response.
 *
 * @param {Array} mistakes - cards from `ochess_review_cards` filtered
 *   to `type === "mistake"` (and optionally `type === "puzzle"`).
 *   We send a slim subset of fields per card; the FEN is intentionally
 *   omitted because it isn't needed for the natural-language plan
 *   and keeping it out lowers token cost.
 * @param {string} [query] - free-text drill query, e.g. "endgame fork".
 * @param {number} [dailyQuota] - cards per day in the generated plan.
 * @returns {Promise<{
 *   ok: boolean,
 *   summary?: string,
 *   plan?: { day: number, focus: string, explanation: string, card_count: number }[],
 *   insights?: { game_id: string|null, ply: number|null, insight: string }[],
 *   model?: string,
 *   error?: string,
 * }>}
 */
export async function callCoach({ mistakes, query, dailyQuota = 5 } = {}) {
  if (!supabase) return { ok: false, error: "Online features not configured." };
  if (!Array.isArray(mistakes) || mistakes.length === 0) {
    return { ok: false, error: "Need at least 1 mistake to coach." };
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

  // Hard timeout. Groq's free tier is fast (~3s typical) but if the
  // function or network hangs we don't want the UI stuck on
  // "Thinking…" forever. 30 s is generous and well under the
  // user's patience threshold. supabase.functions.invoke doesn't
  // accept an AbortSignal as of @supabase/supabase-js 2.x, so we
  // race the invoke against a timer instead.
  const timeoutMs = 30_000;
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ __timeout: true }), timeoutMs)
  );

  try {
    const result = await Promise.race([
      supabase.functions.invoke("coach", {
        body: { mistakes: slim, query: query || "", daily_quota: dailyQuota },
      }),
      timeout,
    ]);
    if (result?.__timeout) {
      return { ok: false, error: "Coach took too long. Try again in a moment." };
    }
    const { data, error } = result;
    // Rate-limit detection. Edge Function returns 429 with a
    // structured body when the user hits the cap; supabase-js
    // surfaces that as `error.context.status === 429` with the
    // body still parseable in `data`. We pull the structured
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
      // Generic error path. Falls back to error.message when no
      // structured body is present.
      const msg = data?.error || error.message || "Coach unavailable";
      return { ok: false, error: msg };
    }
    if (!data || typeof data !== "object") {
      return { ok: false, error: "Empty response from coach." };
    }
    if (data.ok === false) return { ok: false, error: data.error || "Coach failed" };
    // Defensive: the LLM occasionally returns malformed JSON the
    // server tries to parse - if any of the structured fields are
    // missing, render whatever we got and skip the empty sections.
    // We normalize each plan day's `query` field client-side too,
    // because the new field arrived in a server bump that older
    // deployments may still be missing - keep the UI working with
    // either shape.
    return {
      ok: true,
      summary: typeof data.summary === "string" ? data.summary : null,
      plan: Array.isArray(data.plan)
        ? data.plan.map((d) => ({
            day: Number(d?.day) || 1,
            focus: typeof d?.focus === "string" ? d.focus : "Mixed practice",
            explanation: typeof d?.explanation === "string" ? d.explanation : "",
            card_count: Number(d?.card_count) || 5,
            query: typeof d?.query === "string" ? d.query.trim() : "",
          }))
        : [],
      insights: Array.isArray(data.insights) ? data.insights : [],
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
    return { ok: false, error: e?.message || "Coach unavailable" };
  }
}

/** Lightweight helper: is the coach feature reachable from the
 *  client? True iff Supabase is configured. We intentionally don't
 *  ping the function here - that would cost a real call. The UI
 *  handles 4xx/5xx gracefully so an undeployed function still
 *  surfaces a clean error message rather than a hang. */
export function isCoachAvailable() {
  return !!supabase;
}
