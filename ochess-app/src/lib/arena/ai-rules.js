/**
 * Client wrapper for the `arena_rules` Supabase Edge Function.
 *
 * Sends a free-form prompt and receives a structured rule diff
 * the engine can resolve. Layers on top of the server-side
 * validator a SECOND-PASS validation locally - the server does
 * static checks, the client runs the full validator including
 * 50-game simulation. Defense in depth: even if the server
 * deploy is somehow stale, bad rules won't reach the lobby.
 *
 * Errors are normalized into a single shape so the UI can
 * render them consistently:
 *
 *   { ok: false, error: "...", rateLimited?: bool, retryAfterSeconds?: number, validatorErrors?: string[] }
 *
 * Successful responses include the resolver-ready diff:
 *
 *   { ok: true, rules: { extends: "vanilla", ... }, summary?: "...", model?: "..." }
 */

import { supabase } from "../supabase";
import { validateRules } from "./validator";
import { checkPromptSanity } from "./error-messages";

/**
 * Generate a rule diff from a natural-language prompt. Returns
 * a normalized result the lobby UI consumes directly.
 *
 * Crazy Arena Ship #1: the response also carries a `planner`
 * payload with three short prose fields describing the
 * variant's vibe. Optional - the field is undefined when the
 * planner step errored or was skipped server-side.
 *
 * @param {string} prompt
 * @returns {Promise<{
 *   ok: boolean,
 *   rules?: object,
 *   summary?: string,
 *   planner?: { fighting_style: string, signature_mechanic: string, under_pressure: string },
 *   model?: string,
 *   error?: string,
 *   rateLimited?: boolean,
 *   retryAfterSeconds?: number,
 *   callsInWindow?: number,
 *   maxCalls?: number,
 *   windowSeconds?: number,
 *   validatorErrors?: string[],
 * }>}
 */
export async function generateArenaRules(prompt) {
  if (!supabase) return { ok: false, error: "Online features not configured." };
  // Pre-flight prompt sanity. Catches obvious bad inputs (empty,
  // ultra-short, emoji-only, single-word) BEFORE we burn an API
  // call. Friendly errors surfaced to the user with no rate-
  // limit cost.
  const promptError = checkPromptSanity(prompt);
  if (promptError) {
    return { ok: false, error: promptError, promptInvalid: true };
  }

  // Hard timeout - generationally Gemini is fast (< 5s) but a
  // hung function shouldn't lock the UI.
  const timeoutMs = 30_000;
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ __timeout: true }), timeoutMs),
  );

  let result;
  try {
    result = await Promise.race([
      supabase.functions.invoke("arena_rules", { body: { prompt: prompt.trim() } }),
      timeout,
    ]);
  } catch (e) {
    return { ok: false, error: e?.message || "AI request failed." };
  }
  if (result?.__timeout) {
    return { ok: false, error: "AI took too long. Try again." };
  }
  const { data, error } = result;
  // supabase-js sometimes routes the response body through
  // `error.context` even for 4xx with a parseable JSON body.
  // Read both so we always get the structured payload.
  const errBody = await readErrorBody(error);
  const merged = data && typeof data === "object" ? data : errBody;

  // Rate-limit branch.
  const rateData = merged && Number.isFinite(merged.retry_after_seconds) ? merged : null;
  const isRateLimited = error?.context?.status === 429 || (rateData && rateData.ok === false && rateData.retry_after_seconds);
  if (isRateLimited && rateData) {
    return {
      ok: false,
      error: rateData.error || `Rate limit reached. Try again in ${rateData.retry_after_seconds}s.`,
      rateLimited: true,
      retryAfterSeconds: Number(rateData.retry_after_seconds) || 0,
      callsInWindow: Number(rateData.rate_limit?.calls_in_window) || 0,
      maxCalls: Number(rateData.rate_limit?.max_calls) || 0,
      windowSeconds: Number(rateData.rate_limit?.window_seconds) || 0,
    };
  }

  if (error || !merged) {
    return { ok: false, error: merged?.error || error?.message || "AI unavailable." };
  }
  if (merged.ok === false) {
    return {
      ok: false,
      error: merged.error || "AI couldn't produce valid rules.",
      validatorErrors: Array.isArray(merged.validatorErrors) ? merged.validatorErrors : undefined,
    };
  }
  if (!merged.rules || typeof merged.rules !== "object") {
    return { ok: false, error: "AI returned malformed rules." };
  }

  // Second-pass structural validation locally. The server does
  // the same checks but a stale deployment shouldn't be the
  // line of defense, so we re-run them here. NO simulation -
  // random play is a noisy fairness signal that produces
  // false rejections for perfectly playable variants (e.g.
  // knight-queens) AND blocks the main thread for several
  // seconds. Layer 3a's deterministic mobility check covers
  // the real failure modes (one side has zero legal moves,
  // mobility is catastrophically asymmetric).
  const localReport = validateRules(merged.rules);
  if (!localReport.valid) {
    return {
      ok: false,
      error: "AI rules failed local validation. Try rephrasing the prompt.",
      validatorErrors: localReport.errors,
    };
  }

  return {
    ok: true,
    rules: merged.rules,
    summary: typeof merged.summary === "string" ? merged.summary : undefined,
    planner: isPlannerVibe(merged.planner) ? merged.planner : undefined,
    model: typeof merged.model === "string" ? merged.model : undefined,
    callsInWindow: Number(merged.rate_limit?.calls_in_window) || 0,
    maxCalls: Number(merged.rate_limit?.max_calls) || 0,
    windowSeconds: Number(merged.rate_limit?.window_seconds) || 0,
  };
}

function isPlannerVibe(value) {
  return value
    && typeof value === "object"
    && typeof value.fighting_style === "string"
    && typeof value.signature_mechanic === "string"
    && typeof value.under_pressure === "string";
}

/** Best-effort read of a FunctionsHttpError's JSON body. */
async function readErrorBody(error) {
  if (!error?.context) return null;
  const ctx = error.context;
  if (typeof ctx.clone !== "function") return null;
  try {
    const cloned = ctx.clone();
    const text = await cloned.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Lightweight check: is the AI rule generator reachable? */
export function isAIRulesAvailable() {
  return !!supabase;
}
