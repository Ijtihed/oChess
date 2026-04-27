# coach (Edge Function)

Generates a natural-language study plan from a user's chess mistake corpus by calling Groq's free-tier Llama 3.3 70B (with Llama 3.1 8B as the fallback).

## Why Groq

- **Free tier is generous**: 30 requests/min on Llama 3.3 70B without a credit card.
- **Fast**: typical 70B response in ~2-3 seconds.
- **Drop-in OpenAI-compatible API**: easy to swap to OpenRouter / Together / Gemini later by editing one URL.

For oChess at hobby scale (single-digit users solving puzzles + reviewing games), Groq's free tier is sufficient. If usage grows, swap providers without changing the client.

## Deploy

You only need to do this once.

```bash
# 1. Sign up at https://console.groq.com (free, no credit card).
# 2. Click "API Keys" → Create. Copy the key (starts with gsk_...).
# 3. From ochess-app/, store it as a Supabase function secret:
cd ochess-app
npx supabase --workdir .. secrets set GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 4. Deploy:
npx supabase --workdir .. functions deploy coach
```

Verify the secret:

```bash
npx supabase --workdir .. secrets list
```

## How the client calls it

`ochess-app/src/lib/coach-llm.js` is the client wrapper. It reads the user's review cards, filters to mistakes, sends up to 30 of them to this function with the user's optional free-text query, and renders the structured response.

The Plan tab in `/review` exposes this as the **Generate AI plan** button.

## Security

- **JWT verification ON** (default). Only authenticated oChess users can call this function. Anonymous calls return 401.
- **GROQ_API_KEY** is injected from Supabase secrets — never reaches the browser.
- **No card content is logged**: positions are private to the user. We only forward them to Groq for inference; the prompt explicitly does not include the FEN string.
- **Per-call hard limits**: 30 mistakes max + 200-char query max keep the prompt under Groq's 8k context budget and prevent any single user from burning the rate budget.

## Cost guard

If a user spams the button, the worst case is rate-limited Groq responses (Groq returns 429). The function surfaces the error cleanly; the client backs off. There is no per-call cost since Groq's tier is free.

If you want to add a per-user rate limit beyond Groq's account-level limit, the canonical place is a Postgres `coach_calls` table + a check inside this function before we call Groq. Skipped for the launch.
