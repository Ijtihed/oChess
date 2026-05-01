/**
 * Client wrapper for the `arena_rules` Supabase Edge Function.
 *
 * Sends a free-form prompt and receives a structured rule diff
 * the engine can resolve. The pipeline is:
 *
 *   1. Pre-flight prompt sanity (cheap, no AI call).
 *   2. Edge Function: planner → factory → structural validate.
 *   3. Local: structural re-validation (defense in depth).
 *   4. Local: BEHAVIORAL verification (verifyRules in
 *      verification.js) - confirms abilities are reachable in
 *      the opening, win conditions can fire, sim runs sanely.
 *   5. Local: auto-repair (repair.js) for the deterministic
 *      failure mode of "ability offsets too narrow." Re-verifies.
 *   6. If verification still fails after auto-repair, ONE
 *      Gemini retry where we feed the verifier errors back as
 *      a hint ("previous attempt was rejected because ...").
 *   7. If retry still fails, return a friendly error - the
 *      variant isn't playable and a third attempt likely won't
 *      help.
 *
 * The structural validator is the SECURITY boundary (no
 * malformed JSON / unknown effect kinds reaches the engine);
 * the behavioral verifier is the PLAYABILITY boundary (no
 * variant where the AI's intent is invisible at game start).
 *
 * Errors are normalized into a single shape so the UI can
 * render them consistently:
 *
 *   { ok: false, error: "...", rateLimited?: bool,
 *     retryAfterSeconds?: number, validatorErrors?: string[] }
 *
 * Successful responses include the resolver-ready diff:
 *
 *   { ok: true, rules: {...}, summary?: "...", model?: "...",
 *     repairs?: string[] // human-readable list of auto-fixes
 *     applied to the AI's output }
 */

import { supabase } from "../supabase";
import { validateRules } from "./validator";
import { compileVisuals } from "./visual-sandbox/compile-draws";
import { verifyRules } from "./verification";
import { repairRules } from "./repair";
import { checkPromptSanity } from "./error-messages";

// Verification budget. The Edge Function is a remote call, so we
// can afford one retry with verifier-error feedback. Beyond that
// we surface a friendly error rather than burn rate-limit tokens
// on calls that keep failing.
const MAX_VERIFICATION_RETRIES = 1;

/**
 * Generate a rule diff from a natural-language prompt. Returns
 * a normalized result the lobby UI consumes directly.
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
 *   repairs?: string[],
 * }>}
 */
export async function generateArenaRules(prompt, opts = {}) {
  if (!supabase) return { ok: false, error: "Online features not configured." };
  // Pre-flight prompt sanity. Catches obvious bad inputs (empty,
  // ultra-short, emoji-only, single-word) BEFORE we burn an API
  // call. Friendly errors surfaced to the user with no rate-
  // limit cost.
  const promptError = checkPromptSanity(prompt);
  if (promptError) {
    return { ok: false, error: promptError, promptInvalid: true };
  }

  const signal = opts?.signal;
  // Bail out helper: returns the cancellation outcome without
  // throwing so callers don't need to wrap in try/catch.
  function cancelled() {
    return signal?.aborted
      ? { ok: false, error: "Cancelled.", cancelled: true }
      : null;
  }
  if (cancelled()) return cancelled();

  // First attempt: plain prompt, no retry context.
  let attempt = await runOneGenerationAttempt(prompt, null, signal);
  if (cancelled()) return cancelled();
  if (!attempt.ok) return attempt;

  // Behavioral verification on the AI's output.
  let verified = verifyAndRepair(attempt.rules);
  if (verified.ok) {
    return finalizeSuccess(attempt, verified);
  }

  // Verification failed even after auto-repair. Try ONE more
  // Gemini call, this time feeding the verifier errors back
  // as a hint so the model knows what to fix.
  if (MAX_VERIFICATION_RETRIES > 0) {
    if (cancelled()) return cancelled();
    const retryHint = buildVerificationRetryHint(verified.errors);
    attempt = await runOneGenerationAttempt(prompt, retryHint, signal);
    if (cancelled()) return cancelled();
    if (!attempt.ok) return attempt;
    verified = verifyAndRepair(attempt.rules);
    if (verified.ok) {
      return finalizeSuccess(attempt, verified);
    }
  }

  // Still failing. Return a clear friendly error. The user can
  // rephrase and try again.
  return {
    ok: false,
    error: friendlyVerificationFailure(verified.errors),
    validatorErrors: verified.errors,
  };
}

// ── Single generation attempt ──────────────────────────────

/**
 * Make ONE call to the Edge Function with optional retry hint.
 * Surfaces the structural validator's verdict as well as
 * connection / rate-limit errors. Pure I/O - no behavioral
 * verification here.
 *
 * @param {string} prompt
 * @param {string|null} retryHint  Extra context for the AI when
 *   we're asking it to fix a previous failed attempt.
 * @returns {Promise<{ ok: boolean, rules?: object, ...meta }>}
 */
async function runOneGenerationAttempt(prompt, retryHint, abortSignal) {
  const timeoutMs = 30_000;
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ __timeout: true }), timeoutMs),
  );

  // The Edge Function accepts an optional `retryHint` field. If
  // present, it gets appended to the user-facing prompt before
  // the factory call so Gemini sees the previous failure
  // context. Backwards-compatible: older Edge Function deploys
  // ignore unknown fields.
  const body = retryHint
    ? { prompt: prompt.trim(), retryHint }
    : { prompt: prompt.trim() };

  // The user can cancel mid-flight via opts.signal. We can't
  // truly abort the in-flight HTTP request from supabase-js
  // (its functions.invoke doesn't accept AbortSignal in all
  // versions), but we can resolve the race early so the caller
  // sees the cancellation immediately and we can ignore the
  // late response when it eventually arrives.
  const abortPromise = abortSignal
    ? new Promise((resolve) => {
        if (abortSignal.aborted) {
          resolve({ __cancelled: true });
        } else {
          abortSignal.addEventListener("abort", () => resolve({ __cancelled: true }), { once: true });
        }
      })
    : null;

  let result;
  try {
    const racers = [
      supabase.functions.invoke("arena_rules", { body }),
      timeout,
    ];
    if (abortPromise) racers.push(abortPromise);
    result = await Promise.race(racers);
  } catch (e) {
    return { ok: false, error: e?.message || "AI request failed." };
  }
  if (result?.__cancelled) {
    return { ok: false, error: "Cancelled.", cancelled: true };
  }
  if (result?.__timeout) {
    return { ok: false, error: "AI took too long. Try again." };
  }
  const { data, error } = result;
  const errBody = await readErrorBody(error);
  const merged = data && typeof data === "object" ? data : errBody;

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
      // Hard global cap hit. The Edge Function included a
      // friendly dated message in `error`; surface a flag so
      // the lobby can render a calmer "service paused" UI
      // rather than a generic error toast.
      capExhausted: merged.capExhausted === true,
    };
  }
  if (!merged.rules || typeof merged.rules !== "object") {
    return { ok: false, error: "AI returned malformed rules." };
  }

  // Local structural re-validation (defense in depth - protects
  // against a stale Edge Function deploy that dropped a check).
  const localReport = validateRules(merged.rules);
  if (!localReport.valid) {
    return {
      ok: false,
      error: "AI rules failed local validation. Try rephrasing the prompt.",
      validatorErrors: localReport.errors,
    };
  }

  // Visuals (Ship #3): if the AI emitted any drawn visuals,
  // run them through the AST validator HERE to surface errors
  // immediately and DROP invalid draws so we don't even store
  // them on the rules row. We keep the raw (validated) source
  // strings on rules.visuals; the iframe overlay re-compiles
  // them at mount time. Storing raw rather than compiled keeps
  // the stored shape readable for debugging and lets the
  // compile pipeline evolve without invalidating older rows.
  let visualErrors = [];
  if (merged.rules.visuals && typeof merged.rules.visuals === "object") {
    const filtered = filterValidVisuals(merged.rules.visuals);
    visualErrors = filtered.errors;
    merged.rules.visuals = filtered.cleaned;
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
    // Soft-cap warning: the global monthly AI budget is past
    // the soft threshold but not yet exhausted. The lobby
    // surfaces this so users aren't surprised when generation
    // eventually hard-blocks.
    spendWarning: merged.spend_warning === true,
    // Visual draws that failed validation. Empty array on
    // success or when no visuals were emitted at all.
    visualErrors,
  };
}

/**
 * Run each draw through compileVisuals (which validates +
 * loop-guards) and produce a cleaned visuals block containing
 * only the RAW sources of draws that passed validation. The
 * actual compiled function-decl strings are NOT stored; the
 * iframe overlay re-compiles at mount time so the storage shape
 * stays human-readable.
 *
 * Returns { cleaned, errors }. cleaned is undefined if
 * everything dropped.
 *
 * Exported for direct unit testing of the cleaning logic
 * (see ai-rules-visuals.test.js).
 */
export function filterValidVisuals(raw) {
  const compiled = compileVisuals(raw);
  const cleaned = {};
  // Slots: keep raw source for keys that compiled successfully.
  if (compiled.compiled.slots && raw.slots) {
    const okKeys = Object.keys(compiled.compiled.slots);
    if (okKeys.length > 0) {
      cleaned.slots = {};
      for (const k of okKeys) cleaned.slots[k] = raw.slots[k];
    }
  }
  if (compiled.compiled.projectiles && raw.projectiles) {
    const okKeys = Object.keys(compiled.compiled.projectiles);
    if (okKeys.length > 0) {
      cleaned.projectiles = {};
      for (const k of okKeys) cleaned.projectiles[k] = raw.projectiles[k];
    }
  }
  if (Array.isArray(compiled.compiled.overlays) && Array.isArray(raw.overlays)) {
    // Overlays are positional. The compiled array preserves
    // input order with bad ones dropped, but we don't get an
    // explicit index map back. Recompute by re-validating each.
    const goodIndices = new Set();
    for (let i = 0; i < raw.overlays.length; i++) {
      const r = compileVisuals({ overlays: [raw.overlays[i]] });
      if (r.errors.length === 0) goodIndices.add(i);
    }
    if (goodIndices.size > 0) {
      cleaned.overlays = raw.overlays.filter((_, i) => goodIndices.has(i));
    }
  }
  if (compiled.compiled.brains && raw.brains) {
    const okKeys = Object.keys(compiled.compiled.brains);
    if (okKeys.length > 0) {
      cleaned.brains = {};
      for (const k of okKeys) cleaned.brains[k] = raw.brains[k];
    }
  }
  return {
    cleaned: Object.keys(cleaned).length > 0 ? cleaned : undefined,
    errors: compiled.errors,
  };
}

// ── Behavioral verification + auto-repair ─────────────────

/**
 * Run the behavioral verifier and, if it surfaces deterministic
 * failures, apply auto-repair and re-verify. Returns the final
 * (possibly repaired) rules + a list of any repairs we applied.
 */
function verifyAndRepair(rulesIn) {
  // First pass: verify as-is.
  let rules = rulesIn;
  let report = verifyRules(rules);
  let appliedRepairs = [];
  if (report.ok) {
    return { ok: true, rules, repairs: [], report };
  }

  // Second pass: auto-repair what we can, re-verify.
  const { repaired, applied } = repairRules(rules, report);
  if (applied.length > 0) {
    rules = repaired;
    appliedRepairs = applied;
    report = verifyRules(rules);
  }
  if (report.ok) {
    return { ok: true, rules, repairs: appliedRepairs, report };
  }

  return {
    ok: false,
    rules,
    repairs: appliedRepairs,
    errors: report.errors,
    warnings: report.warnings,
    report,
  };
}

/**
 * Build a hint string the Edge Function will pass to Gemini on
 * the verification-retry path. We feed back the most actionable
 * subset of the verifier errors (the model gets confused by
 * dumping every internal field).
 */
function buildVerificationRetryHint(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const lines = errors.slice(0, 4).map((e) => `  - ${e}`).join("\n");
  return `The previous response was structurally valid but failed the playability check:\n${lines}\n\nPlease fix specifically these issues. Keep the variant's overall flavor and gating, just adjust offsets/ranges/win conditions so the abilities are USABLE FROM THE OPENING.`;
}

/**
 * Translate verifier errors into a one-liner the user can act on.
 * The internal messages are useful for the AI retry loop but too
 * technical to dump on the user.
 */
function friendlyVerificationFailure(errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return "AI couldn't produce a playable variant. Try rephrasing.";
  }
  // The most common case is "too narrow" abilities. Detect that
  // and use a tailored message; fall back to a generic one.
  const tooNarrow = errors.some((e) => /too narrow|unreachable/.test(e));
  if (tooNarrow) {
    return "The AI's variant produced abilities that aren't usable from the opening. Try rephrasing with broader range (e.g. 'reaches the back rank', 'long-range spell').";
  }
  const noTermination = errors.some((e) => /never terminate|loops forever/.test(e));
  if (noTermination) {
    return "The AI's variant doesn't produce games that end. Try rephrasing with a clearer win condition.";
  }
  return "AI couldn't produce a playable variant. Try rephrasing the prompt.";
}

/**
 * Wrap a successful generate-and-verify result in the public
 * response shape.
 */
function finalizeSuccess(attempt, verified) {
  return {
    ok: true,
    rules: verified.rules,
    summary: attempt.summary,
    planner: attempt.planner,
    model: attempt.model,
    callsInWindow: attempt.callsInWindow,
    maxCalls: attempt.maxCalls,
    windowSeconds: attempt.windowSeconds,
    repairs: verified.repairs || [],
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
