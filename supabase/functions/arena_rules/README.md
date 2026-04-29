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

3 calls per 600 seconds (10 minutes) per authenticated user. Enforced server-side by the `record_arena_rules_call` RPC. The client receives a 429 with `retry_after_seconds` when the user hits the cap.

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
