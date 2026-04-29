// Deno-based Supabase Edge Function - AI Arena rule generator.
//
// Takes a free-form natural-language prompt and returns a
// structured rule diff that the client engine resolves at
// runtime. The Edge Function is the only sanctioned path -
// keys stay server-side, rate limit is enforced via the
// `record_arena_rules_call` RPC, and the structural validator
// runs server-side BEFORE any AI output reaches a client.
//
// Flow per request:
//   1. JWT-auth the caller (handled by Supabase platform).
//   2. Burn one rate-limit token via record_arena_rules_call.
//      If the user is over the cap, return 429 with retry
//      countdown.
//   3. Build the prompt from the user's natural-language
//      description + the schema spec the client engine
//      consumes.
//   4. Call Gemini. Parse JSON.
//   5. Run the structural validator. If it passes, return
//      the rules. If it fails, do ONE auto-retry with the
//      validator errors appended to the system prompt, and
//      validate again. If that fails too, return a hard error.
//   6. The client does a second-pass full validation
//      (including 50-game simulation) on receipt - defense
//      in depth.
//
// Deploy:
//   1. Get a Gemini API key from https://aistudio.google.com.
//   2. Set as a function secret:
//        npx supabase --workdir .. secrets set GEMINI_API_KEY=...
//      (optionally GEMINI_MODEL=gemini-2.5-flash)
//   3. Deploy:
//        npx supabase --workdir .. functions deploy arena_rules

import { createClient } from "jsr:@supabase/supabase-js@2";

// ── Hard limits ──
const MAX_PROMPT_CHARS = 600;
const DEFAULT_MODEL = "gemini-2.5-flash";

// ── Rate limit defaults (must match the SQL RPC defaults) ──
const RATE_LIMIT_WINDOW_SECONDS = 600; // 10 min
const RATE_LIMIT_MAX_CALLS = 3;

// ── Types ──

interface ArenaRulesRequest {
  /** Natural-language description of the variant. */
  prompt?: string;
}

interface ArenaRulesResponse {
  ok: boolean;
  /** Structured rule diff with extends="vanilla" + overrides. */
  rules?: Record<string, unknown>;
  /** Brief human-readable summary the model returned alongside the diff. */
  summary?: string;
  /** Validator errors when ok=false and we couldn't recover. */
  validatorErrors?: string[];
  error?: string;
  model?: string;
  rate_limit?: {
    calls_in_window: number;
    max_calls: number;
    window_seconds: number;
  };
  retry_after_seconds?: number;
}

interface RateLimitResult {
  ok: boolean;
  allowed: boolean;
  retryAfterSeconds: number;
  callsInWindow: number;
  maxCalls: number;
  windowSeconds: number;
  error?: string;
}

// ── Auth + rate limit (lifted from coach/index.ts) ──

function makeAuthedClient(req: Request) {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return null;
  return createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function recordRateLimitedCall(req: Request): Promise<RateLimitResult> {
  const supabase = makeAuthedClient(req);
  if (!supabase) {
    return {
      ok: false, allowed: false, retryAfterSeconds: 0,
      callsInWindow: 0, maxCalls: RATE_LIMIT_MAX_CALLS,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
      error: "Supabase client unavailable",
    };
  }
  const { data, error } = await supabase.rpc("record_arena_rules_call", {
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
    p_max_calls: RATE_LIMIT_MAX_CALLS,
  });
  if (error) {
    return {
      ok: false, allowed: false, retryAfterSeconds: 0,
      callsInWindow: 0, maxCalls: RATE_LIMIT_MAX_CALLS,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
      error: error.message,
    };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return {
      ok: false, allowed: false, retryAfterSeconds: 0,
      callsInWindow: 0, maxCalls: RATE_LIMIT_MAX_CALLS,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
      error: "Empty rate-limit response",
    };
  }
  return {
    ok: true,
    allowed: !!row.allowed,
    retryAfterSeconds: Number(row.retry_after_seconds) || 0,
    callsInWindow: Number(row.calls_in_window) || 0,
    maxCalls: Number(row.max_calls) || RATE_LIMIT_MAX_CALLS,
    windowSeconds: Number(row.window_seconds) || RATE_LIMIT_WINDOW_SECONDS,
  };
}

// ── Prompt construction ──

const SYSTEM_PROMPT = `You are an expert chess variant designer. The user describes a variant in natural language; you produce a strict JSON rule diff that an engine can read directly.

The engine accepts diffs that EXTEND vanilla chess. The shape:

{
  "extends": "vanilla",
  "name": "Short label (1-3 words)",
  "description": "1-2 sentences: what this variant does in plain English.",
  "overrides": {
    "startingFen": "8/8/8/8/8/8/8/8 w - - 0 1",   // optional, must be a valid FEN
    "maxPlies": 400                                  // optional, 10..2000
  },
  "pieces": {                                        // optional, only the pieces being changed
    "p" | "n" | "b" | "r" | "q" | "k": {
      "moves": [ MovePrimitive, ... ],
      "castling": { kingside?, queenside?, requireUnmoved?, requireEmpty: [], requireSafe: [] },
      "promotion": { "type": ["n","b","r","q"] }
    }
  },
  "byColor": {                                       // optional, per-color overrides (asymmetric variants)
    "w" | "b": { "p" | "n" | "b" | "r" | "q" | "k": <piece spec same shape as above> }
  },
  "capture": {                                       // optional capture mechanics
    "explosionRadius": 0..3,                        // 0 = standard, 1 = atomic-style
    "convert": false                                // currently always false
  },
  "winConditions": [                                 // ORDERED, first to fire ends the game
    { "type": "checkmate" } |
    { "type": "capture_king" } |
    { "type": "first_to_n_captures", "target": 1..64 } |
    { "type": "race_to_squares", "piece": "p|n|b|r|q|k", "squaresWhite": ["e8"], "squaresBlack": ["e1"] } |
    { "type": "last_standing" }
  ]
}

Move primitives - all coordinates are (file, rank) pairs from White's POV; the engine flips dr automatically for Black:

  { "kind": "slide", "dirs": [[df,dr], ...], "maxRange"?: 1..8 }
    Slide in directions until blocked. Like rook/bishop/queen.

  { "kind": "leap", "offsets": [[df,dr], ...] }
    Single-square jump per offset. Like knight/king. Multiple offsets = multiple targets.

  { "kind": "step", "dirs": [[df,dr], ...], "conditions"?: { "onlyFirstMove"?: bool, "onlyCapture"?: bool, "onlyNonCapture"?: bool, "enPassant"?: bool } }
    Single-square step with conditions. Used for pawn-style moves.

Constraints / common pitfalls:
- DO NOT include [0,0] in any dirs/offsets - it loops forever.
- maxRange must be 1..8 if specified.
- Slide and step ALWAYS need a "dirs" array; leap ALWAYS needs an "offsets" array.
- "extends" is always "vanilla".
- If a piece doesn't change, omit it. Don't restate vanilla moves.
- Only set "byColor" when the variant is asymmetric (e.g. "Only black can castle"). Otherwise put all overrides under "pieces".
- Win conditions are evaluated in order. Put variant-specific conditions BEFORE checkmate so they fire first.
- Keep "name" punchy (3 words max). Keep "description" to 1-2 sentences.
- Vanilla baseline DEFAULTS:
    p: 1-step forward (no capture), 2-step forward from rank 2 (no capture, only first move), diagonal capture, diagonal en passant, promotion to n/b/r/q.
    n: leap to all 8 knight offsets.
    b: slide along 4 diagonals.
    r: slide along 4 orthogonals.
    q: slide along 8 directions.
    k: leap to 8 surrounding squares + castling kingside/queenside if rights remain.

Be CREATIVE. Lean into the user's intent and make the variant feel distinct, not just a tiny tweak of vanilla. If they say "kings start in the middle", actually rewrite the FEN and put the kings on d4/d5. If they say "knight wars", make knights powerful and the rest weak. If their prompt is sparse, embellish a bit while staying playable.

Tested example variants for inspiration (don't copy verbatim - use them as patterns):

  "Kings in the middle":
  {
    "extends": "vanilla",
    "name": "Royal Center",
    "description": "Kings start on d4/d5 with their armies behind them. Move fast or get smothered.",
    "overrides": { "startingFen": "rnbqnbnr/pppppppp/8/3kK3/8/8/PPPPPPPP/RNBQNBNR w - - 0 1" }
  }

  "Knights move twice":
  {
    "extends": "vanilla",
    "name": "Knight Storm",
    "description": "Knights leap to either standard knight squares or anywhere two knight-hops away.",
    "pieces": { "n": { "moves": [
      { "kind": "leap", "offsets": [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]] },
      { "kind": "leap", "offsets": [[2,4],[4,2],[4,-2],[2,-4],[-2,-4],[-4,-2],[-4,2],[-2,4],[3,3],[3,-3],[-3,-3],[-3,3]] }
    ] } }
  }

  "Pawns can move backward":
  {
    "extends": "vanilla",
    "name": "Reverse Pawns",
    "description": "Pawns may step back to your own first rank to reset and try again.",
    "pieces": { "p": { "moves": [
      { "kind": "step", "dirs": [[0,1]], "conditions": { "onlyNonCapture": true } },
      { "kind": "step", "dirs": [[0,2]], "conditions": { "onlyFirstMove": true, "onlyNonCapture": true } },
      { "kind": "step", "dirs": [[1,1],[-1,1]], "conditions": { "onlyCapture": true } },
      { "kind": "step", "dirs": [[1,1],[-1,1]], "conditions": { "enPassant": true } },
      { "kind": "step", "dirs": [[0,-1]], "conditions": { "onlyNonCapture": true } }
    ] } }
  }

  "First to capture 3 wins":
  {
    "extends": "vanilla",
    "name": "Three Strikes",
    "description": "First side to capture three enemy pieces wins immediately. Defenders fall fast.",
    "winConditions": [{ "type": "first_to_n_captures", "target": 3 }, { "type": "checkmate" }]
  }

  "Atomic chess":
  {
    "extends": "vanilla",
    "name": "Atomic",
    "description": "Captures explode and detonate adjacent non-pawn pieces. Kings cannot capture.",
    "capture": { "explosionRadius": 1 },
    "winConditions": [{ "type": "capture_king" }]
  }

  "Race to e8/e1":
  {
    "extends": "vanilla",
    "name": "King Race",
    "description": "First king to reach the opposite back rank wins. No need for checkmate.",
    "winConditions": [
      { "type": "race_to_squares", "piece": "k", "squaresWhite": ["e8"], "squaresBlack": ["e1"] },
      { "type": "checkmate" }
    ]
  }

  "Last Standing":
  {
    "extends": "vanilla",
    "name": "Annihilation",
    "description": "Win by reducing the opponent to king only. Material matters more than position.",
    "winConditions": [{ "type": "last_standing" }, { "type": "checkmate" }]
  }

Reply with ONLY a JSON object, no prose around it.`;

function buildPrompt(prompt: string, validatorErrors?: string[]): string {
  const trimmed = (prompt || "").trim().slice(0, MAX_PROMPT_CHARS);
  let retryNote = "";
  if (validatorErrors?.length) {
    retryNote = `\n\nIMPORTANT: your previous response was rejected by the structural validator with these errors:
${validatorErrors.map((e) => `  - ${e}`).join("\n")}

Fix the errors and try again. Stay within the schema above; do not invent new fields.\n`;
  }
  return `User's variant description:
"""
${trimmed}
"""
${retryNote}
Produce a JSON rule diff matching the schema. ONLY the JSON object. No prose, no markdown fences.`;
}

// ── Gemini call + cost estimation ──

interface GeminiResult {
  ok: boolean;
  content?: string;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

// Gemini 2.5 Flash pricing (per 1M tokens, USD).
// As of late 2025 - check https://ai.google.dev/pricing if
// these change. Also used for the post-call cost log.
const GEMINI_FLASH_INPUT_USD_PER_M = 0.075;
const GEMINI_FLASH_OUTPUT_USD_PER_M = 0.30;

/** Convert (in, out) token counts to micro-USD using Flash pricing. */
function estimateMicroUsd(inputTokens: number, outputTokens: number): number {
  const inUsd = (inputTokens * GEMINI_FLASH_INPUT_USD_PER_M) / 1_000_000;
  const outUsd = (outputTokens * GEMINI_FLASH_OUTPUT_USD_PER_M) / 1_000_000;
  return Math.ceil((inUsd + outUsd) * 1_000_000);
}

/**
 * Conservative pre-call cost estimate. Rough heuristic: 1 token
 * ~= 4 characters. Multiply by 2 for safety so the budget guard
 * never under-counts. Output tokens are capped by max_tokens
 * below, but we use that ceiling for the estimate.
 */
function estimateMicroUsdFromPromptChars(promptChars: number, maxOutputTokens: number): number {
  const estIn = Math.ceil((promptChars / 4) * 2);
  return estimateMicroUsd(estIn, maxOutputTokens);
}

async function callGemini(systemPrompt: string, userPrompt: string, model: string, maxTokens = 2000): Promise<GeminiResult> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return { ok: false, error: "GEMINI_API_KEY not configured" };
  const url = `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.5,
        max_tokens: maxTokens,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { ok: false, error: `Gemini returned ${resp.status}: ${body.slice(0, 300)}` };
    }
    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: "Empty response from Gemini" };
    // OpenAI-compat usage object. Gemini may or may not include it
    // depending on model version - default to 0 if missing.
    const usage = json?.usage || {};
    return {
      ok: true,
      content,
      inputTokens: Number(usage.prompt_tokens) || 0,
      outputTokens: Number(usage.completion_tokens) || 0,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Monthly $-cap guard ──

interface SpendCheckResult {
  ok: boolean;
  allowed: boolean;
  usedMicroUsd: number;
  capMicroUsd: number;
  remainingMicroUsd: number;
  error?: string;
}

const MONTHLY_CAP_MICRO_USD = 50_000_000; // $50.00 per calendar month

/**
 * Atomically check + record an AI spend event. Pre-call use:
 * pass an estimate; if denied, do NOT make the API call.
 * Post-call use: pass the actual cost as a true-up, ignoring
 * the result.
 */
async function recordSpendOrBlock(
  req: Request,
  feature: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  microUsd: number,
): Promise<SpendCheckResult> {
  const supabase = makeAuthedClient(req);
  if (!supabase) {
    return { ok: false, allowed: false, usedMicroUsd: 0, capMicroUsd: MONTHLY_CAP_MICRO_USD, remainingMicroUsd: MONTHLY_CAP_MICRO_USD, error: "Supabase client unavailable" };
  }
  const { data, error } = await supabase.rpc("record_ai_spend_or_block", {
    p_feature: feature,
    p_provider: "gemini",
    p_model: model,
    p_input_tokens: inputTokens,
    p_output_tokens: outputTokens,
    p_micro_usd: microUsd,
    p_monthly_cap_micro_usd: MONTHLY_CAP_MICRO_USD,
  });
  if (error) {
    return { ok: false, allowed: false, usedMicroUsd: 0, capMicroUsd: MONTHLY_CAP_MICRO_USD, remainingMicroUsd: MONTHLY_CAP_MICRO_USD, error: error.message };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return { ok: false, allowed: false, usedMicroUsd: 0, capMicroUsd: MONTHLY_CAP_MICRO_USD, remainingMicroUsd: MONTHLY_CAP_MICRO_USD, error: "Empty spend response" };
  }
  return {
    ok: true,
    allowed: !!row.allowed,
    usedMicroUsd: Number(row.used_micro_usd) || 0,
    capMicroUsd: Number(row.cap_micro_usd) || MONTHLY_CAP_MICRO_USD,
    remainingMicroUsd: Number(row.remaining_micro_usd) || 0,
  };
}

function parseRulesJson(content: string): { ok: boolean; rules?: Record<string, unknown>; error?: string } {
  try {
    // Defensive: strip markdown fences if the model leaked them.
    const cleaned = content
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, error: "Top-level JSON wasn't an object" };
    }
    return { ok: true, rules: parsed };
  } catch (e) {
    return { ok: false, error: `Couldn't parse JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── Server-side structural validator ──
//
// Mirrors lib/arena/validator.js's layer-1 checks - just
// enough to reject obviously-broken rules without needing the
// engine. The client runs a full validator (including
// simulation) on receipt as defense in depth.

const KNOWN_PRIMITIVE_KINDS = new Set(["slide", "leap", "step"]);
const KNOWN_WIN_CONDITIONS = new Set([
  "checkmate", "capture_king", "first_to_n_captures", "race_to_squares", "last_standing",
]);
const PIECE_TYPES = new Set(["p", "n", "b", "r", "q", "k"]);

function validateStructure(rules: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (rules.extends !== "vanilla") {
    errors.push(`extends must be "vanilla" (got ${JSON.stringify(rules.extends)})`);
  }

  // Pieces
  if (rules.pieces !== undefined) {
    if (typeof rules.pieces !== "object" || rules.pieces === null || Array.isArray(rules.pieces)) {
      errors.push("pieces must be an object keyed by piece type");
    } else {
      for (const [pt, spec] of Object.entries(rules.pieces as Record<string, unknown>)) {
        if (!PIECE_TYPES.has(pt)) {
          errors.push(`pieces.${pt}: unknown piece type (must be one of p/n/b/r/q/k)`);
          continue;
        }
        validatePieceSpec(`pieces.${pt}`, spec, errors);
      }
    }
  }

  // byColor
  if (rules.byColor !== undefined) {
    if (typeof rules.byColor !== "object" || rules.byColor === null) {
      errors.push("byColor must be an object");
    } else {
      for (const [color, perColor] of Object.entries(rules.byColor as Record<string, unknown>)) {
        if (color !== "w" && color !== "b") {
          errors.push(`byColor.${color}: unknown color (must be "w" or "b")`);
          continue;
        }
        if (typeof perColor !== "object" || perColor === null) continue;
        for (const [pt, spec] of Object.entries(perColor as Record<string, unknown>)) {
          if (!PIECE_TYPES.has(pt)) {
            errors.push(`byColor.${color}.${pt}: unknown piece type`);
            continue;
          }
          validatePieceSpec(`byColor.${color}.${pt}`, spec, errors);
        }
      }
    }
  }

  // Win conditions
  if (rules.winConditions !== undefined) {
    if (!Array.isArray(rules.winConditions) || rules.winConditions.length === 0) {
      errors.push("winConditions must be a non-empty array");
    } else {
      for (let i = 0; i < (rules.winConditions as unknown[]).length; i++) {
        const wc = (rules.winConditions as Record<string, unknown>[])[i];
        if (!wc || typeof wc !== "object" || !KNOWN_WIN_CONDITIONS.has(String(wc.type))) {
          errors.push(`winConditions[${i}].type "${(wc as Record<string, unknown>)?.type}" is unknown`);
          continue;
        }
        if (wc.type === "first_to_n_captures") {
          const target = Number(wc.target);
          if (!Number.isFinite(target) || target < 1 || target > 64) {
            errors.push(`winConditions[${i}].target must be 1..64`);
          }
        }
        if (wc.type === "race_to_squares") {
          if (!Array.isArray(wc.squaresWhite) || (wc.squaresWhite as unknown[]).length === 0) {
            errors.push(`winConditions[${i}].squaresWhite must be a non-empty array`);
          }
          if (!Array.isArray(wc.squaresBlack) || (wc.squaresBlack as unknown[]).length === 0) {
            errors.push(`winConditions[${i}].squaresBlack must be a non-empty array`);
          }
        }
      }
    }
  }

  // Capture effects
  if (rules.capture !== undefined) {
    const cap = rules.capture as Record<string, unknown>;
    if (cap?.explosionRadius !== undefined) {
      const r = Number(cap.explosionRadius);
      if (!Number.isFinite(r) || r < 0 || r > 3) {
        errors.push("capture.explosionRadius must be 0..3");
      }
    }
  }

  // overrides.startingFen + maxPlies
  const ov = (rules.overrides as Record<string, unknown>) || {};
  if (ov.startingFen !== undefined && typeof ov.startingFen !== "string") {
    errors.push("overrides.startingFen must be a string");
  }
  if (ov.maxPlies !== undefined) {
    const m = Number(ov.maxPlies);
    if (!Number.isFinite(m) || m < 10 || m > 2000) {
      errors.push("overrides.maxPlies must be 10..2000");
    }
  }

  // Top-level startingFen / maxPlies / name / description
  if (rules.startingFen !== undefined && typeof rules.startingFen !== "string") {
    errors.push("startingFen must be a string");
  }
  if (rules.maxPlies !== undefined) {
    const m = Number(rules.maxPlies);
    if (!Number.isFinite(m) || m < 10 || m > 2000) {
      errors.push("maxPlies must be 10..2000");
    }
  }
  if (rules.name !== undefined && typeof rules.name !== "string") {
    errors.push("name must be a string");
  }
  if (rules.description !== undefined && typeof rules.description !== "string") {
    errors.push("description must be a string");
  }

  return errors;
}

function validatePieceSpec(path: string, spec: unknown, errors: string[]): void {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  const s = spec as Record<string, unknown>;
  if (s.moves !== undefined) {
    if (!Array.isArray(s.moves)) {
      errors.push(`${path}.moves must be an array`);
    } else {
      for (let i = 0; i < (s.moves as unknown[]).length; i++) {
        const prim = (s.moves as Record<string, unknown>[])[i];
        const subPath = `${path}.moves[${i}]`;
        if (!prim || typeof prim !== "object") {
          errors.push(`${subPath}: must be an object`);
          continue;
        }
        if (!KNOWN_PRIMITIVE_KINDS.has(String(prim.kind))) {
          errors.push(`${subPath}.kind "${prim.kind}" is unknown (must be slide/leap/step)`);
          continue;
        }
        if (prim.kind === "slide" || prim.kind === "step") {
          if (!Array.isArray(prim.dirs) || (prim.dirs as unknown[]).length === 0) {
            errors.push(`${subPath}.dirs must be a non-empty array of [df,dr] tuples`);
          } else {
            for (let j = 0; j < (prim.dirs as unknown[]).length; j++) {
              const d = (prim.dirs as unknown[])[j];
              if (!Array.isArray(d) || d.length !== 2 || !Number.isFinite(d[0]) || !Number.isFinite(d[1])) {
                errors.push(`${subPath}.dirs[${j}]: must be a [df,dr] tuple of finite numbers`);
              } else if ((d as number[])[0] === 0 && (d as number[])[1] === 0) {
                errors.push(`${subPath}.dirs[${j}]: [0,0] would loop forever`);
              }
            }
          }
          if (prim.kind === "slide" && prim.maxRange !== undefined) {
            const r = Number(prim.maxRange);
            if (!Number.isFinite(r) || r < 1 || r > 8) {
              errors.push(`${subPath}.maxRange must be 1..8`);
            }
          }
        } else if (prim.kind === "leap") {
          if (!Array.isArray(prim.offsets) || (prim.offsets as unknown[]).length === 0) {
            errors.push(`${subPath}.offsets must be a non-empty array of [df,dr] tuples`);
          } else {
            for (let j = 0; j < (prim.offsets as unknown[]).length; j++) {
              const off = (prim.offsets as unknown[])[j];
              if (!Array.isArray(off) || off.length !== 2 || !Number.isFinite(off[0]) || !Number.isFinite(off[1])) {
                errors.push(`${subPath}.offsets[${j}]: must be a [df,dr] tuple of finite numbers`);
              }
            }
          }
        }
      }
    }
  }
}

// ── CORS ──

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Handler ──

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let body: ArenaRulesRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Body must be JSON" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (!body.prompt || typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return new Response(JSON.stringify({ ok: false, error: "prompt is required" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Rate limit (also serves as auth gate - non-authed users
  // can't make the RPC succeed).
  const rl = await recordRateLimitedCall(req);
  if (!rl.ok) {
    return new Response(JSON.stringify({ ok: false, error: rl.error || "Rate limit failed" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  if (!rl.allowed) {
    const resp: ArenaRulesResponse = {
      ok: false,
      error: `You can request up to ${rl.maxCalls} variant rules per ${Math.round(rl.windowSeconds / 60)} min. Try again in ${rl.retryAfterSeconds}s.`,
      retry_after_seconds: rl.retryAfterSeconds,
      rate_limit: {
        calls_in_window: rl.callsInWindow,
        max_calls: rl.maxCalls,
        window_seconds: rl.windowSeconds,
      },
    };
    return new Response(JSON.stringify(resp), {
      status: 429,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const model = Deno.env.get("GEMINI_MODEL") || DEFAULT_MODEL;

  // ── Pre-flight $-cap check ──
  // Worst-case estimate: full system prompt (~3-4 KB chars) +
  // user prompt + the auto-retry budget (~2x output). If the
  // estimated cost would push us over the monthly cap, refuse
  // BEFORE making the API call so we never get billed for it.
  const promptCharsEst = SYSTEM_PROMPT.length + body.prompt.length + 500;
  const estMicroUsd = estimateMicroUsdFromPromptChars(promptCharsEst, 2000) * 2;
  const preCheck = await recordSpendOrBlock(req, "arena_rules", model, 0, 0, 0);
  if (preCheck.ok && !preCheck.allowed && preCheck.usedMicroUsd + estMicroUsd > preCheck.capMicroUsd) {
    return new Response(JSON.stringify({
      ok: false,
      error: "AI variant generation is temporarily unavailable - the monthly spending budget has been reached. Try again next month.",
      model,
    }), {
      status: 503,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  // Hard pre-block when over cap regardless. The 0-cost row
  // above just lets us inspect the current spend; the real
  // cost-bearing record happens after each successful call.
  if (preCheck.ok && preCheck.usedMicroUsd >= preCheck.capMicroUsd) {
    return new Response(JSON.stringify({
      ok: false,
      error: "AI variant generation is temporarily unavailable - the monthly spending budget has been reached. Try again next month.",
      model,
    }), {
      status: 503,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // First attempt.
  const firstPrompt = buildPrompt(body.prompt);
  const first = await callGemini(SYSTEM_PROMPT, firstPrompt, model);
  if (!first.ok) {
    return new Response(JSON.stringify({ ok: false, error: first.error || "AI call failed", model }), {
      status: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  // Record the actual spend for the first call.
  if (first.inputTokens || first.outputTokens) {
    const cost = estimateMicroUsd(first.inputTokens || 0, first.outputTokens || 0);
    await recordSpendOrBlock(req, "arena_rules", model, first.inputTokens || 0, first.outputTokens || 0, cost);
  }
  const parsedFirst = parseRulesJson(first.content!);
  if (!parsedFirst.ok) {
    return new Response(JSON.stringify({ ok: false, error: parsedFirst.error || "Bad AI output", model }), {
      status: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  let rules = parsedFirst.rules!;
  let errors = validateStructure(rules);

  // Auto-retry once with the validator errors fed back.
  if (errors.length > 0) {
    const retryPrompt = buildPrompt(body.prompt, errors);
    const second = await callGemini(SYSTEM_PROMPT, retryPrompt, model);
    if (second.ok) {
      // Record the retry's spend too.
      if (second.inputTokens || second.outputTokens) {
        const cost = estimateMicroUsd(second.inputTokens || 0, second.outputTokens || 0);
        await recordSpendOrBlock(req, "arena_rules", model, second.inputTokens || 0, second.outputTokens || 0, cost);
      }
      const parsedSecond = parseRulesJson(second.content!);
      if (parsedSecond.ok) {
        rules = parsedSecond.rules!;
        errors = validateStructure(rules);
      }
    }
  }

  if (errors.length > 0) {
    const resp: ArenaRulesResponse = {
      ok: false,
      error: "AI couldn't produce valid rules. Try rephrasing your prompt.",
      validatorErrors: errors,
      model,
      rate_limit: {
        calls_in_window: rl.callsInWindow,
        max_calls: rl.maxCalls,
        window_seconds: rl.windowSeconds,
      },
    };
    return new Response(JSON.stringify(resp), {
      status: 422,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Defensive: ensure extends="vanilla" so the client resolver
  // doesn't reject. The validator above already enforces this
  // but a future loosening of the validator shouldn't open the
  // hole.
  rules.extends = "vanilla";

  const summary = typeof rules.description === "string" ? rules.description : undefined;

  const resp: ArenaRulesResponse = {
    ok: true,
    rules,
    summary,
    model,
    rate_limit: {
      calls_in_window: rl.callsInWindow,
      max_calls: rl.maxCalls,
      window_seconds: rl.windowSeconds,
    },
  };
  return new Response(JSON.stringify(resp), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
});
