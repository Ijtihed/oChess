// Deno-based Supabase Edge Function - AI deck generator.
//
// Takes the user's recent mistake corpus + a natural-language
// search query, calls Groq's free-tier Llama 3.3 70B, and returns
// 1-3 focused deck definitions:
//
//   - name:    short scannable title for the deck list
//   - query:   filter phrase from a constrained vocabulary that
//              maps onto the client-side card index
//   - summary: 1-2 sentence "what this deck is and why it matters
//              for THIS player" - shown as a banner above the
//              board when they study the deck
//
// The earlier multi-day plan + per-card insights surface was
// removed in favour of this deck-creation model. The client now
// owns the "today" loop entirely; the Edge Function's only job is
// to translate one query into focused decks the user can save.
//
// Why an Edge Function and not a direct browser call?
//   - The Groq key stays on the platform side. Browser code can't
//     leak it.
//   - Lets us swap providers (Groq -> OpenRouter -> Gemini -> ...)
//     without changing the client.
//   - Per-user rate limit is enforced server-side via the
//     `record_coach_call` RPC.
//
// Deploy:
//   1. Sign up at https://console.groq.com — free, no credit card.
//   2. Create an API key. Copy it.
//   3. Set it as a function secret:
//        npx supabase --workdir .. secrets set GROQ_API_KEY=gsk_xxx
//   4. Deploy:
//        npx supabase --workdir .. functions deploy coach
//
// Security:
//   - JWT verification ON: only authenticated oChess users can call.
//   - Per-call hard limits below cap how much corpus the user can
//     submit so a single user can't burn the whole rate budget.
//   - We do not log card content (positions are private to the user).

import { createClient } from "jsr:@supabase/supabase-js@2";

// ── Hard limits ──
// 30 mistakes per call covers ~2 months of typical play and keeps
// the prompt under Groq's 8k context budget for the 70B model.
const MAX_MISTAKES_PER_CALL = 30;
const MAX_QUERY_CHARS = 200;
const MODEL = "llama-3.3-70b-versatile";
const FALLBACK_MODEL = "llama-3.1-8b-instant";

interface MistakeInput {
  fen?: string;
  played_san?: string;
  best_san?: string | null;
  eval_loss_cp?: number;
  phase?: "opening" | "middlegame" | "endgame";
  themes?: string[];
  opening?: string | null;
  source?: string;
  ply?: number;
  game_id?: string;
}

interface CoachRequest {
  mistakes: MistakeInput[];
  query?: string;
}

/**
 * Response from the AI deck generator.
 *
 * The function used to return a multi-day plan + per-mistake
 * insights; that surface was removed in favor of a deck-creation
 * model. The user types a natural-language query in the Plan tab,
 * clicks "Generate decks with AI", and receives 1-3 focused decks
 * back. Each deck has a name, a filter query (mapped against the
 * client-side card metadata index), and a 1-2 sentence summary
 * shown as a banner inside the review session.
 */
interface CoachResponse {
  ok: boolean;
  /** Optional one-line interpretation of the user's query. */
  summary?: string;
  /** 1-3 focused decks. Empty array if the model couldn't pick any
   *  reasonable angles from the user's corpus + query. */
  decks?: {
    name: string;
    query: string;
    summary: string;
  }[];
  error?: string;
  model?: string;
  rate_limit?: {
    calls_in_window: number;
    max_calls: number;
    window_seconds: number;
  };
}

// ── Rate limit ──
// Per-user rolling-window cap, enforced server-side. The defaults
// here MUST stay in sync with the schema RPC (3 calls / 300 s) so a
// stale Edge Function deployment can't loosen the limit.
const RATE_LIMIT_WINDOW_SECONDS = 300;
const RATE_LIMIT_MAX_CALLS = 3;

interface RateLimitResult {
  ok: boolean;
  allowed: boolean;
  retryAfterSeconds: number;
  callsInWindow: number;
  maxCalls: number;
  windowSeconds: number;
  error?: string;
}

// ── Auth + RPC client ──

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

async function getAuthedUserId(req: Request): Promise<string | null> {
  const supabase = makeAuthedClient(req);
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

async function recordRateLimitedCall(req: Request): Promise<RateLimitResult> {
  const supabase = makeAuthedClient(req);
  if (!supabase) {
    return { ok: false, allowed: false, retryAfterSeconds: 0, callsInWindow: 0, maxCalls: RATE_LIMIT_MAX_CALLS, windowSeconds: RATE_LIMIT_WINDOW_SECONDS, error: "Supabase client unavailable" };
  }
  const { data, error } = await supabase.rpc("record_coach_call", {
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
    p_max_calls: RATE_LIMIT_MAX_CALLS,
  });
  if (error) {
    return { ok: false, allowed: false, retryAfterSeconds: 0, callsInWindow: 0, maxCalls: RATE_LIMIT_MAX_CALLS, windowSeconds: RATE_LIMIT_WINDOW_SECONDS, error: error.message };
  }
  // The RPC returns a SETOF result; supabase-js gives us either an
  // array or the first row depending on version. Normalize both.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return { ok: false, allowed: false, retryAfterSeconds: 0, callsInWindow: 0, maxCalls: RATE_LIMIT_MAX_CALLS, windowSeconds: RATE_LIMIT_WINDOW_SECONDS, error: "Empty rate-limit response" };
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

function compactMistake(m: MistakeInput): string {
  // Keep the per-mistake line short — cumulative token count matters.
  const themes = (m.themes || []).slice(0, 3).join(",");
  const evalNote = m.eval_loss_cp ? ` -${(m.eval_loss_cp / 100).toFixed(1)}` : "";
  const opening = m.opening ? ` [${m.opening}]` : "";
  return `${m.phase || "?"} ${m.played_san || "?"} (best ${m.best_san || "?"})${evalNote} ${themes}${opening}`;
}

function buildPrompt(mistakes: MistakeInput[], query: string | undefined): string {
  const corpus = mistakes.slice(0, MAX_MISTAKES_PER_CALL).map((m, i) => `${i + 1}. ${compactMistake(m)}`).join("\n");
  const focusLine = query
    ? `The user typed this query in the search: "${query.slice(0, MAX_QUERY_CHARS)}".`
    : "The user didn't type a query - pick the strongest pattern in the corpus.";

  // The client converts each deck's "query" into a saveable drill
  // set by passing it through a substring AND-match filter against
  // these card fields: phase, themes (array), played_san, best_san,
  // opening, source. So the model needs to pick query phrases from
  // a vocabulary that actually matches stored card data, not just
  // free poetic English. Listing the known values keeps decks from
  // collapsing to "0 matching cards".
  const filterVocabulary = `
Filter vocabulary (use these in each deck's "query" field):
  Phase:    opening / middlegame / endgame
  Themes:   blunder / mistake / missed_mate / missed_capture / capture_blunder /
            hanging_queen / hanging_rook / hanging_bishop / hanging_knight
  Source:   chesscom / lichess
  You may also include a piece letter from played_san (Q, R, B, N, K) or an
  opening name token if it appears in the corpus.
`.trim();

  return `You are a chess coach helping a player turn their natural-language search into focused study decks.

Mistake corpus (their recent mistakes):
${corpus}

${focusLine}

${filterVocabulary}

Reply with ONLY a JSON object, no prose around it. Schema:

{
  "summary": "1 sentence interpreting the user's query against this player's actual weaknesses. No flattery.",
  "decks": [
    {
      "name": "Short, scannable deck title (3-5 words). Will appear in the user's deck list (e.g. 'Hanging queens in the middlegame').",
      "query": "1-3 tokens from the filter vocabulary above that select the relevant cards (e.g. 'middlegame hanging_queen'). At least one token MUST come from the vocabulary.",
      "summary": "1-2 sentences. WHAT this deck contains and WHY it matters for this player. Plain English, concrete, no chess-engine speak. Shown as a banner above the board when they study the deck."
    }
  ]
}

Guidelines:
- Return 1, 2, or 3 decks. Prefer 1 sharp deck over 3 broad ones.
- ONLY return more than one deck if the user's query is broad (e.g. "my middlegame mistakes" can split into "Hanging pieces" + "Bad trades" + "Missed tactics"). For a focused query like "hanging queens", return exactly one deck.
- Each deck's "query" MUST match real cards above. Don't invent themes that aren't in the data.
- Prefer compound queries (e.g. "endgame hanging_rook") over single tokens - they pinpoint the actual weakness.
- The "summary" is the most important field. It's the user's daily reminder of what they're working on. Make it personal and specific to THIS player's corpus, not generic chess advice.
- Don't quote engine output verbatim - explain it in plain English.`;
}

// ── Groq call ──

async function callGroq(prompt: string, model: string): Promise<{ ok: boolean; content?: string; error?: string }> {
  const key = Deno.env.get("GROQ_API_KEY");
  if (!key) return { ok: false, error: "GROQ_API_KEY not configured" };

  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a concise, honest chess study coach. Reply only with valid JSON." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.4,
        max_tokens: 1200,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { ok: false, error: `Groq returned ${resp.status}: ${body.slice(0, 200)}` };
    }
    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: "Empty response from Groq" };
    return { ok: true, content };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function parseCoachJson(content: string): CoachResponse | null {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      ok: true,
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      decks: Array.isArray(parsed.decks) ? parsed.decks.slice(0, 3).map((d: Record<string, unknown>) => ({
        name: typeof d?.name === "string" ? d.name.trim() : "Untitled deck",
        // Trim defensively - some models like to hand back wrapper
        // quotes or leading "Query:" labels.
        query: typeof d?.query === "string"
          ? String(d.query).trim().replace(/^["']|["']$/g, "").replace(/^query:\s*/i, "")
          : "",
        summary: typeof d?.summary === "string" ? d.summary.trim() : "",
      })).filter((d) => d.name && d.query) : [],
    };
  } catch {
    return null;
  }
}

// ── CORS ──
// Supabase JS sends `apikey`, `x-client-info`, and `authorization`
// alongside `content-type` on every functions.invoke() call. The
// browser rejects the preflight if any of those aren't in the
// Allow-Headers list, which manifests as the cryptic
// "Failed to send a request to the Edge Function" error on the
// client side. List every header @supabase/supabase-js 2.x is known
// to send so a future minor bump doesn't silently break us again.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-supabase-api-version",
  "Access-Control-Max-Age": "86400",
};

// ── Handler ──

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonErr("Method not allowed", 405);
  }

  const userId = await getAuthedUserId(req);
  if (!userId) return jsonErr("Not authenticated", 401);

  // Per-user rate limit. Records the call in `coach_calls` and
  // returns the rolling-window status. We deliberately gate BEFORE
  // request body parsing / Groq dispatch so an abusive client
  // can't burn through the LLM budget by spamming malformed
  // requests that would otherwise be rejected later.
  //
  // `record_coach_call` only records when the call is allowed - a
  // blocked attempt does NOT consume a slot. That keeps the
  // surfaced "retry in Ns" countdown stable from one click to the
  // next instead of shifting forward with every blocked retry.
  const rate = await recordRateLimitedCall(req);
  if (!rate.ok) {
    return jsonErr(rate.error || "Rate-limit check failed", 500);
  }
  if (!rate.allowed) {
    return jsonRateLimited(
      `You're generating decks a lot. Try again in ${rate.retryAfterSeconds}s.`,
      rate
    );
  }

  let body: CoachRequest;
  try {
    body = await req.json();
  } catch {
    return jsonErr("Invalid JSON body", 400);
  }

  if (!Array.isArray(body.mistakes) || body.mistakes.length === 0) {
    return jsonErr("Provide at least 1 mistake", 400);
  }

  const prompt = buildPrompt(body.mistakes, body.query);

  // Try the bigger model first; fall back to the smaller (faster +
  // higher rate limit) model if the 70B model is unavailable.
  let groq = await callGroq(prompt, MODEL);
  let modelUsed = MODEL;
  if (!groq.ok) {
    const fb = await callGroq(prompt, FALLBACK_MODEL);
    if (fb.ok) { groq = fb; modelUsed = FALLBACK_MODEL; }
  }
  if (!groq.ok) return jsonErr(groq.error || "Coach unavailable", 502);

  const parsed = parseCoachJson(groq.content!);
  if (!parsed) return jsonErr("Coach returned malformed JSON", 502);

  return jsonOk({ ...parsed, model: modelUsed, rate_limit: {
    calls_in_window: rate.callsInWindow,
    max_calls: rate.maxCalls,
    window_seconds: rate.windowSeconds,
  }});
});

function jsonOk(payload: CoachResponse): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function jsonErr(error: string, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Dedicated 429 response carrying the retry-after metadata the
// client UI needs to render an exact countdown. We surface BOTH a
// standard `Retry-After` HTTP header (in seconds, per RFC 7231) and
// a structured JSON body so generic intermediaries and our own
// client both have what they need.
function jsonRateLimited(message: string, rate: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: message,
      retry_after_seconds: rate.retryAfterSeconds,
      calls_in_window: rate.callsInWindow,
      max_calls: rate.maxCalls,
      window_seconds: rate.windowSeconds,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(rate.retryAfterSeconds),
        ...CORS_HEADERS,
      },
    }
  );
}
