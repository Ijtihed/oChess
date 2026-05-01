# `arena_rules` Edge Function

AI rule generator for AI Arena. Takes a free-form prompt and returns a structured rule diff that the client engine resolves at runtime. Validator runs server-side before any AI output reaches a client.

## Deploy

1. Get a Gemini API key from <https://aistudio.google.com>.
2. Set the secret on the Supabase project:

   ```bash
   npx supabase --workdir .. secrets set GEMINI_API_KEY=...
   # Optional: override the default model (gemini-2.5-flash).
   npx supabase --workdir .. secrets set GEMINI_MODEL=gemini-2.5-pro
   ```

3. Deploy the function:

   ```bash
   npx supabase --workdir .. functions deploy arena_rules
   ```

## Rate limit

Two layers:

1. **Per-user rolling-window rate limit**: 10 calls / 10 min per user. Enforced server-side by the `record_arena_rules_call` RPC. The client receives a 429 with `retry_after_seconds` when the user hits the cap.
2. **Global monthly $-cap**: configured in the `ai_settings` DB table (single source of truth shared with the `coach` function). Default `monthly_cap_micro_usd = 100_000_000` (€100/month) and `soft_warning_micro_usd = 80_000_000` (€80). The Edge Function reads from the table on every call; nothing is hardcoded in the Edge Function source any more. To change:

```sql
update ai_settings set monthly_cap_micro_usd = <micro-usd>,
                       soft_warning_micro_usd = <micro-usd>
                where id = 1;
```

Once month-to-date spend reaches the hard cap, every call returns 503 with a friendly user-facing message that includes the date the cap resets. Once spend crosses the soft warning, the response includes `spend_warning: true` and the lobby surfaces a small notice but generation still works.

The $-cap is the only line of defense against a runaway bill — Google AI Studio's per-key budget cap is NOT configured separately. To inspect current monthly spend:

```sql
select sum(micro_usd) / 1e6 as usd_this_month
  from ai_spend_log
 where created_at >= date_trunc('month', now() at time zone 'UTC');
```

## Auto-retry

If the AI's first JSON output fails the structural validator, the function retries once with the validator's error report appended to the system prompt. If the second response also fails, the client gets a 422 with the validator errors so the user can refine their prompt.

The client (in `lib/arena/ai-rules.js`) does a second-pass full validation including the 50-game simulation check, so a stale Edge Function deployment can't sneak invalid rules into the lobby.

## Inputs / outputs

```ts
// Request
{ prompt: string }   // <= 600 chars

// Success response
{
  ok: true,
  rules: { extends: "vanilla", ...overrides },
  summary?: string,
  model: string,
  rate_limit: { calls_in_window, max_calls, window_seconds }
}

// Rate-limited response (HTTP 429)
{
  ok: false,
  error: "...",
  retry_after_seconds: number,
  rate_limit: { ... }
}

// Validator failure (HTTP 422)
{
  ok: false,
  error: "AI couldn't produce valid rules. Try rephrasing your prompt.",
  validatorErrors: string[],
  model: string
}
```

## Schema

The system prompt embedded in `index.ts` documents the rule object schema the engine consumes (move primitives, win conditions, capture effects, byColor asymmetry). It must stay in sync with `src/lib/arena/schema.js` on the client - the validator there is what runs the second-pass check.

## Per-IP rate limiting (operational concern)

The function enforces a **per-user** rate limit via `record_arena_rules_call`. This means one authenticated user can hit the function up to N times in the rolling window. It does NOT prevent:

- A bored attacker creating many accounts and hitting the function from each.
- A scraper running through TOR exits.

The cost cap (`record_ai_spend_or_block`) is the hard backstop: if a token-burning attack exhausts the global monthly budget, generation pauses for the rest of the month. So the financial damage is bounded.

If you want to harden further, two options:

1. **Vercel/Cloudflare WAF rule** in front of `*.supabase.co/functions/v1/arena_rules`: limit by IP to e.g. 30 requests / 5 min. This needs to live OUTSIDE Supabase (Supabase Edge Functions don't see the original IP through the standard request object).
2. **Cloudflare Turnstile / hCaptcha** challenge on the lobby's "Generate" button. Adds friction but stops most automated abuse.

Neither is implemented today; the existing per-user + global-cap defenses are deemed sufficient for hobby-app scale. Revisit if Supabase usage logs show abuse.

## Structured logs

Every important decision point emits a JSON line on stdout (see `log()` helper in `index.ts`). Filter in the Supabase Logs Explorer by:

- `event=request_received` — request volume
- `event=rate_limited` — per-user limit hits
- `event=cap_exhausted` — monthly cap blocks
- `event=gemini_call_failed` — Gemini API health
- `event=validation_failed_after_retry` — variants Gemini couldn't produce cleanly even with retry
- `event=request_succeeded` — success rate, with `elapsed_ms` for performance tracking
