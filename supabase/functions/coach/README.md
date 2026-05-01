# coach (Edge Function)

AI deck generator + per-card explainer for the Anki review surface.

- **decks** mode: takes the user's mistake corpus + a natural-language query, returns 1-3 focused deck definitions.
- **explain** mode: takes a single card, returns a 2-3 sentence coaching note on why the engine line is better.

## Provider

Gemini 2.5 Flash via Google's OpenAI-compat endpoint. Same provider as `arena_rules`. Both functions share a single global monthly spending cap configured in the `ai_settings` DB table (default €100/month hard, €80/month soft warning) enforced by the `record_ai_spend_or_block` RPC.

## Deploy

Deploy via the Supabase Studio Edge Functions UI:

1. Get a Gemini API key from <https://aistudio.google.com>.
2. Project Settings → Edge Functions → Secrets:
   - Add `GEMINI_API_KEY` with your key.
   - Optionally add `GEMINI_MODEL` (defaults to `gemini-2.5-flash`).
3. Edge Functions → coach → paste the contents of `index.ts` and deploy. JWT verification: ON.

Or via the Supabase CLI:

```bash
npx supabase functions deploy coach
```

## How the client calls it

`ochess-app/src/lib/coach-llm.js` is the client wrapper. It reads the user's review cards, filters to mistakes, sends up to 30 of them to this function with the user's optional free-text query, and renders the structured response.

The Anki review surface (`/review`) exposes this as the AI deck generator and the per-card "Coach take" widget.

## Security

- **JWT verification ON**. Only authenticated oChess users can call. Anonymous calls return 401.
- **GEMINI_API_KEY** is injected from Supabase secrets — never reaches the browser.
- **No card content is logged**: positions are private to the user. We only forward them to Gemini for inference; the prompt explicitly does not include the FEN string in decks mode.
- **Per-call hard limits**: 30 mistakes max + 200-char query max bound the prompt size.

## Rate limits + spending

Two layers:

1. **Per-user rolling-window rate limit**: 3 calls / 5 min per user, enforced by `record_coach_call`. Returns 429 with a structured retry countdown.
2. **Global monthly $-cap**: configured in the `ai_settings` DB table (default €100/month hard, €80/month soft warning), shared with `arena_rules`. Enforced by `record_ai_spend_or_block`. Once hit, every call returns 503 with a friendly user-facing message including the date the cap resets.

The cap is the only line of defense against a runaway bill — Google AI Studio's per-key budget cap is NOT configured separately. To change the cap:

```sql
update ai_settings set monthly_cap_micro_usd = <micro-usd>,
                       soft_warning_micro_usd = <micro-usd>
                where id = 1;
```

To inspect current monthly spend:

```sql
select sum(micro_usd) / 1e6 as usd_this_month
  from ai_spend_log
 where created_at >= date_trunc('month', now() at time zone 'UTC');
```
