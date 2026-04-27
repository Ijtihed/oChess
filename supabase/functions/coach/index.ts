// Deno-based Supabase Edge Function — chess study-plan coach.
//
// Takes the user's recent mistake corpus + an optional free-text
// query, calls Groq's free-tier Llama 3.1 70B, and returns:
//
//   1. A short natural-language summary of the user's weakness
//      profile ("you drop pieces in the middlegame, especially…")
//   2. A multi-day study plan grouping the mistakes into themed
//      sessions.
//   3. Per-card one-line insights (rephrasing eval-loss + theme tags
//      into something a human actually wants to read).
//
// Why an Edge Function and not a direct browser call?
//   - The Groq key stays on the platform side. Browser code can't
//     leak it.
//   - Lets us swap providers (Groq → OpenRouter → Gemini → …)
//     without changing the client.
//   - Centralises the prompt + JSON-shape contract; the client just
//     consumes structured data.
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
  daily_quota?: number;
}

interface CoachResponse {
  ok: boolean;
  summary?: string;
  plan?: {
    day: number;
    focus: string;
    explanation: string;
    card_count: number;
    // NEW: short filter phrase that narrows the user's mistake
    // corpus to JUST the cards relevant for this day. Maps onto
    // our client-side free-text filter (substring AND-match
    // against phase/themes/played_san/best_san/opening/source).
    // The client uses this to one-click-save a drill set.
    query?: string;
  }[];
  insights?: { game_id: string | null; ply: number | null; insight: string }[];
  error?: string;
  model?: string;
}

// ── Auth gate ──

async function getAuthedUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return null;
  const supabase = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

// ── Prompt construction ──

function compactMistake(m: MistakeInput): string {
  // Keep the per-mistake line short — cumulative token count matters.
  const themes = (m.themes || []).slice(0, 3).join(",");
  const evalNote = m.eval_loss_cp ? ` -${(m.eval_loss_cp / 100).toFixed(1)}` : "";
  const opening = m.opening ? ` [${m.opening}]` : "";
  return `${m.phase || "?"} ${m.played_san || "?"} (best ${m.best_san || "?"})${evalNote} ${themes}${opening}`;
}

function buildPrompt(mistakes: MistakeInput[], query: string | undefined, dailyQuota: number): string {
  const corpus = mistakes.slice(0, MAX_MISTAKES_PER_CALL).map((m, i) => `${i + 1}. ${compactMistake(m)}`).join("\n");
  const focusLine = query
    ? `The user specifically wants to drill: "${query.slice(0, MAX_QUERY_CHARS)}".`
    : "Group by the weakness pattern you see most.";

  // The client converts each day's "query" into a saveable drill
  // set by passing it through a substring AND-match filter against
  // these card fields: phase, themes (array), played_san, best_san,
  // opening, source. So the model needs to pick query phrases from
  // a vocabulary that actually matches stored card data, not just
  // free poetic English. Listing the known values keeps drill sets
  // from collapsing to "0 matching cards".
  const filterVocabulary = `
Filter vocabulary (use these in the "query" field):
  Phase:    opening / middlegame / endgame
  Themes:   blunder / mistake / missed_mate / missed_capture / capture_blunder /
            hanging_queen / hanging_rook / hanging_bishop / hanging_knight
  Source:   chesscom / lichess
  You may also include a piece letter from played_san (Q, R, B, N, K) or an
  opening name token if it appears in the corpus.
`.trim();

  return `You are a chess coach reading one player's recent mistakes. Be direct and concrete.

Mistakes:
${corpus}

${focusLine}

${filterVocabulary}

Reply with ONLY a JSON object, no prose around it. Schema:

{
  "summary": "1-3 sentences naming the player's most recurring weakness in plain English. No flattery.",
  "plan": [
    {
      "day": 1,
      "focus": "Specific theme name as a human-readable title (e.g. 'Hanging knights in the middlegame')",
      "explanation": "1 sentence why this matters",
      "card_count": ${dailyQuota},
      "query": "1-3 words from the filter vocabulary above that select the relevant mistakes (e.g. 'middlegame hanging_knight'). At least one token MUST come from the vocabulary."
    },
    { "day": 2, "focus": "...", "explanation": "...", "card_count": ${dailyQuota}, "query": "..." },
    { "day": 3, "focus": "...", "explanation": "...", "card_count": ${dailyQuota}, "query": "..." }
  ],
  "insights": [
    { "index": 1, "insight": "1 sentence - what went wrong + what to look for next time" },
    { "index": 2, "insight": "..." }
  ]
}

Guidelines:
- 3 to 5 days in the plan. Each day a different theme. Card counts must total <= ${dailyQuota * 5}.
- The "query" for each day MUST match real cards above. Don't invent themes that aren't in the data.
- Prefer compound queries over single tokens when possible (e.g. "endgame hanging_rook" beats just "endgame") because they pinpoint the user's actual weakness.
- "insights" should cover the 5 most instructive mistakes (or all of them if there are fewer).
- Indices in "insights" refer to the 1-based mistake list above.
- Don't quote chess engine output verbatim - explain it.`;
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
      plan: Array.isArray(parsed.plan) ? parsed.plan.slice(0, 5).map((p: Record<string, unknown>) => ({
        day: Number(p.day) || 1,
        focus: String(p.focus || "Mixed practice"),
        explanation: String(p.explanation || ""),
        card_count: Number(p.card_count) || 5,
        // The client uses this to one-click-save / one-click-practice
        // each day. Trim defensively - some models like to hand back
        // wrapper quotes or leading "Query: " labels.
        query: typeof p.query === "string"
          ? String(p.query).trim().replace(/^["']|["']$/g, "").replace(/^query:\s*/i, "")
          : "",
      })) : undefined,
      insights: Array.isArray(parsed.insights) ? parsed.insights.slice(0, 10).map((ins: Record<string, unknown>) => ({
        game_id: null,
        ply: typeof ins.index === "number" ? ins.index : null,
        insight: String(ins.insight || ""),
      })) : undefined,
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

  let body: CoachRequest;
  try {
    body = await req.json();
  } catch {
    return jsonErr("Invalid JSON body", 400);
  }

  if (!Array.isArray(body.mistakes) || body.mistakes.length === 0) {
    return jsonErr("Provide at least 1 mistake", 400);
  }

  const dailyQuota = Math.min(20, Math.max(1, Number(body.daily_quota) || 5));
  const prompt = buildPrompt(body.mistakes, body.query, dailyQuota);

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

  return jsonOk({ ...parsed, model: modelUsed });
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
