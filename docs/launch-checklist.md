# oChess - Launch Checklist

Everything you must do **outside the codebase** before oChess is ready for daily use. Items are grouped by priority. Skip nothing in the BLOCKER section.

The `stockfish.wasm` binary and the trimmed `puzzles.csv` are both committed to the repo - they are NOT manual setup items anymore.

---

## BLOCKER - must be done or the app is broken in production

### 1. Create a Supabase project and apply the schema

- New project at https://app.supabase.com.
- Open `Project -> SQL Editor -> New query`.
- Paste the entire contents of [`supabase/schema.sql`](../supabase/schema.sql) and run.
- The script is idempotent; re-running it converges to the target shape. On a project that has the legacy migrations applied, **read the dedup `DELETE` statements first** - they collapse duplicate seeks and friendships.
- Verify in `Database -> Tables` that you see all of:
  - `profiles`, `ratings`, `games`, `seeks`, `challenges`
  - `puzzle_progress`, `puzzle_attempts`
  - `review_cards`, `friendships`
  - `coach_calls` (powers the per-account AI rate limit)
- Verify in `Database -> Functions` that these RPCs exist:
  - `claim_seek`, `accept_challenge`, `create_rematch`, `glicko2_update`
  - `cleanup_stale_seeks`, `cleanup_stale_games`
  - `record_coach_call`

If you applied an earlier version of the schema and just need the rate-limit objects, run [`supabase/migrations/20260427000000_coach_rate_limit.sql`](../supabase/migrations/20260427000000_coach_rate_limit.sql) instead.

### 2. Configure auth providers

#### Email (always)

- `Authentication -> Providers -> Email` - enable.
- For dev, you can disable "Confirm email" so signups log straight in. For prod, leave it on.
- `Authentication -> Email Templates` - preview each template; the link should target your **Site URL** (set below), not localhost.
- Production deliverability: configure **custom SMTP** at `Project Settings -> Auth -> SMTP`. Default Supabase mail is rate-limited and spam-filtered - fine for testing only.

#### Google OAuth (optional but recommended)

- Google Cloud Console -> `APIs & Services -> Credentials -> OAuth 2.0 Client ID (Web)`:
  - **Authorized JavaScript origins**: your production origin and `http://localhost:5173` for dev.
  - **Authorized redirect URIs**: `https://<PROJECT_REF>.supabase.co/auth/v1/callback` - this is the **Supabase callback**, not your app origin. The app then redirects back to your origin.
- Supabase -> `Authentication -> Providers -> Google`: paste the Client ID + Client Secret; enable.

The client now uses `flowType: "pkce"` (committed in `lib/supabase.js`). PKCE exchanges an authorization code at the redirect URL instead of embedding the access token in the fragment - a real upgrade over the old implicit flow. Both Google and email-link flows go through the same redirect handler.

#### URL configuration

- Supabase -> `Authentication -> URL Configuration`:
  - **Site URL**: your production origin, e.g. `https://ochess.example.com`.
  - **Redirect URLs**: include the production origin, any preview URL pattern, and `http://localhost:5173` for dev.

### 3. Set the frontend env vars

Copy `ochess-app/.env.example` -> `ochess-app/.env` for local dev. On your hosting platform (Vercel / Netlify / etc.) add the same `VITE_*` vars to the production environment.

**Required:**
- `VITE_SUPABASE_URL` - from `Project Settings -> API -> Project URL`.
- `VITE_SUPABASE_ANON_KEY` - `Project Settings -> API -> anon public` key (NOT the service role key).

**Optional but recommended:**
- `VITE_SENTRY_DSN` - if set, Sentry crash reporting auto-initializes via `lib/monitoring.js`. Free tier covers low-traffic launches; sign up at https://sentry.io. Without this, render errors are logged to `console.error` only.
- `VITE_POSTHOG_KEY` (and optional `VITE_POSTHOG_HOST`) - if set, PostHog product analytics auto-initializes. Privacy defaults baked in: no auto-pageviews, no autocapture, no session recording, respect-DNT on.
- `VITE_DEBUG=true` - turns on verbose `[friends]` / `[online-game]` / `[play]` console logs in production.

**Never** put the `service_role` key in any `VITE_*` var or any client-shipped code. The Edge Functions read it from Supabase function-scope secrets (see #5).

### 4. Confirm the realtime publication

The `schema.sql` script tries to add `seeks`, `games`, `challenges`, `friendships` to the `supabase_realtime` publication. Verify in `Database -> Replication -> Tables` that all four are toggled on. If not, toggle them manually.

### 5. Deploy the AI Coach Edge Function (only if you want the Plan-tab AI feature)

The `coach` Edge Function bridges the client to Groq's free Llama 3.3 70B model. Without deploying it, the "Generate AI plan" button in the Plan tab returns "Online features not configured." Drill sets / mistake analysis still work without it.

```bash
cd ochess-app

# Sign up at https://console.groq.com (free, no credit card)
# Create an API key (starts with gsk_)

npx supabase --workdir .. login
npx supabase --workdir .. link --project-ref <your-project-ref>
npx supabase --workdir .. secrets set GROQ_API_KEY=gsk_xxxxxxxxxxxx
npx supabase --workdir .. functions deploy coach
```

Per-account rate limit: 3 calls per 5 minutes. Server-enforced via the `record_coach_call` RPC; the client surfaces a countdown banner and disables the Generate button while the cap is active.

CORS preflight already includes `apikey`, `x-client-info`, and `x-supabase-api-version`. If you deploy a stale version of the function, you'll see "Failed to send a request to the Edge Function" in the browser - re-deploy the current code from this repo.

### 6. Set up SPA routing on your host

oChess is a single-page app - the host must rewrite every non-asset request to `/index.html` so deep links (`/u/alice`, `/game/online/abc-123`, `/review?import=...`) hit the React router instead of returning 404.

| Host | Where |
|---|---|
| Vercel | `ochess-app/vercel.json` (already in repo) |
| Netlify | `_redirects` file with `/* /index.html 200` |
| Cloudflare Pages | already does this for static assets (no config) |
| S3 + CloudFront | Set the **error document** to `index.html` and return 200 for 403/404 |

Build command: `cd ochess-app && npm ci && npm run build`. Publish directory: `ochess-app/dist`.

---

## SHOULD-DO - works without these but you'll regret it

### 7. Verify scheduled jobs

`schema.sql` schedules two `pg_cron` jobs:
- `ochess-cleanup-stale-seeks` - runs every 5 min, deletes matchmaking seeks older than 15 min.
- `ochess-cleanup-stale-games` - runs every 6 hours, marks active timed games with no move in 24 hours as `aborted`.

Verify in `Database -> Cron Jobs` that both exist. The corresponding RPCs (`cleanup_stale_seeks`, `cleanup_stale_games`) are restricted to the `service_role` so a logged-in user can't grief matchmaking.

The Edge Function at `supabase/functions/cleanup-stale-seeks/` is shipped as a manual-invoke fallback (e.g. for ad-hoc cleanup). It is NOT required - `pg_cron` handles regular scheduling. Note: Supabase CLI v2.95+ dropped the `--schedule` flag from `functions deploy`; that's why scheduling lives in `pg_cron` now.

### 8. Lock down the `main` branch

`.github/workflows/ci.yml` runs build + test on every PR but doesn't enforce passing checks. Enforce in **GitHub -> Settings -> Branches -> Branch protection rules**:

- Require status check `Build & test` to pass.
- Require PR reviews (recommended, optional).
- Disallow force pushes.

### 9. Verify the email confirmation flow end-to-end

The app detects "email confirmation required" and tells the user to check their inbox. Verify your **Confirm signup** template links to your production Site URL and that the confirmation flow works end-to-end before launch. With Supabase's default SMTP, expect heavy spam-filtering on Gmail / Outlook.

### 10. Wire up production error reporting

`lib/monitoring.js` is already integrated with `ErrorBoundary`. Set `VITE_SENTRY_DSN` (see #3) and crashes will start reporting within minutes. Without it, prod crashes are invisible.

### 11. Privacy / Terms / Attribution

Already implemented in [`/legal/privacy`](../ochess-app/src/components/LegalPage.jsx), [`/legal/terms`](../ochess-app/src/components/LegalPage.jsx), [`/legal/attribution`](../ochess-app/src/components/LegalPage.jsx) (linked from the footer). Page content is grounded in:

- **Stockfish** - GPLv3. The repo's main code is Apache-2.0; bundling is consistent with the GPL's "system library exception" since Stockfish runs as a separate Web Worker.
- **Lichess puzzle DB** - ODbL, attribution required.
- **Lichess piece sets / sounds** - credited in `ochess-app/LICHESS-ATTRIBUTION.md`.
- **Privacy policy** - email + ratings + games + reviews are stored in your Supabase project; the page is grounded in the canonical schema.

The pages reference an individual operator (Helsinki, Finland) and `ijtihedk@gmail.com` as the contact. Update those constants at the top of `LegalPage.jsx` if you fork.

---

## NICE-TO-HAVE - polish or future work

### 12. Bundle size

The production build lazy-loads the heaviest routes (`AnalysisPage`, `PuzzlesPage`, `OnlineGameScreen`, `VariantGameScreen`) via `React.lazy` + `Suspense`. The main chunk is ~700 KB / ~200 KB gzipped, route chunks load on demand behind `LoadingScreen`. Sentry + PostHog are dynamically imported so they only land in the bundle when their env vars are set.

### 13. Custom domain + SSL

Most hosts handle this; ensure `Site URL` and OAuth redirect URIs use the final domain, not the temporary preview URL. Supabase + Vercel both auto-issue Let's Encrypt certs.

### 14. Analytics

PostHog already wired in `lib/monitoring.js`. Set `VITE_POSTHOG_KEY` (see #3) and product events (`auth.signed_in`, `auth.signed_out`) start flowing. Privacy policy already covers it.

### 15. Server-side rate limiting on game-import

`fetchLichessGames` / `fetchChesscomGames` go directly to public APIs from the browser. There's a hard 5,000-game cap, plus a client-side rolling-window throttle of 8 imports per source per hour (`lib/game-import.js`, `checkImportThrottle`). The throttle is NOT a security boundary - a determined user can clear localStorage. If abuse becomes a problem, proxy through a small Edge Function and enforce server-side counters.

### 16. Image / asset optimization

`vite.config.js` uses defaults. The puzzle CSV is the largest static asset (~1.8 MB after trimming).

---

## Pre-launch sanity checks

The repo ships three automated harnesses you should run before the manual pass:

```bash
cd ochess-app

# 1. Verify your Supabase project has the tables, RPCs, bucket, and
#    realtime endpoint the app expects. Reads VITE_SUPABASE_URL +
#    VITE_SUPABASE_ANON_KEY from .env. Currently 15/15 checks.
npm run check:supabase

# 2. Full unit suite (currently 496 tests across 57 files).
npx vitest run

# 3. End-to-end smoke covering the flows that don't need a second
#    user or real email: landing, guest mode, bot game route,
#    puzzles, analysis, public profile 404, signed-out profile,
#    mobile viewport. Boots the dev server automatically. (15/15.)
npx playwright install chromium
npm run e2e
```

All three must pass before you start the manual flow walkthrough.

## Pre-launch test pass (manual)

Once the automated checks above are green, walk through these flows on the deployed app - they cover the integrations the smoke can't simulate (real Realtime latency, OAuth round-trip, two real users, AI rate limit):

1. **Cold load `/`** - landing page renders, "Sign In" works, "Play as Guest" puts you in guest mode and shows the dashboard.
2. **Sign up with email** - after submit you see "Check your inbox", click the email link, return, sign in.
3. **Google sign-in** - redirects through Google, lands back on `/` signed in. Profile shows your Google name + avatar. (PKCE flow - watch for `?code=...` in the redirect URL, not `#access_token=...`.)
4. **Play a bot game** - start a 5+0, play 3 moves, click Menu, return to `/play`, click Resume - game restores correctly.
5. **Solve a puzzle** - Daily Puzzle on dashboard renders a real puzzle, click it, solve, see rating change.
6. **Online play (need 2 browsers / a friend)** - both click 5+0 -> match in <5s -> moves sync -> resign -> result saves and shows in profile.
7. **Challenge link** - create one in browser A, open in browser B (different account), both land in the game.
8. **Chess960 friend match** - both browsers must show the **same** starting position before any moves are played (deterministic from `gameData.id`).
9. **Hard refresh mid-game** - refresh both browsers - game state restores, clocks resume from server-stored state, chat persists, no duplicate messages.
10. **Rematch flow** - finish a game, A clicks Rematch, B sees "wants a rematch" + can Accept/Decline; declining shows A "Opponent declined the rematch."; canceling on A clears B's banner instantly.
11. **Friend system** - search a username, add friend, accept on the other side - friend appears in SocialPanel within 1-2s (realtime).
12. **Analysis** - open from a finished game, eval bar reads correctly when Black is on move, import 50 games from a small Lichess account, cancel mid-stream.
13. **Anki review** - save a failed puzzle, go to `/review`, drag your move, confirm: opponent's reply auto-plays, line ledger appears, rating buttons show predicted intervals ("Again 1m / Good 1d / Easy 4d"), state pill changes (NEW -> LEARNING -> MATURE) across multiple reviews.
14. **AI coach** - click Generate AI plan in the Plan tab. Confirm: each day in the response has working **Practice now** / **Save as drill** buttons; clicking Generate 4 times in a row shows the cooldown banner; usage chip says "X/3 calls in the last 5 min".
15. **Avatar upload** - change avatar, refresh - new avatar persists everywhere (header, profile, public profile). Storage should now contain only one file under `<userId>/` (older files are auto-cleaned).
16. **Mobile sweep** - open every page on a 360px-wide viewport - no horizontal scroll, board scales, modals usable.
17. **Sign out** - click Logout from profile - fully clears session, lands on landing.

If all 17 pass, you're good to launch.

---

## Operational dashboard bookmarks

Bookmark these in your Supabase project for daily ops:

- `Database -> Tables -> games` - sort by `created_at desc` to spot abuse.
- `Database -> Tables -> seeks` - should be empty most of the time. If it's not, your cleanup cron isn't running.
- `Database -> Tables -> coach_calls` - one row per successful AI coach call. Sort by `created_at desc` to see usage; old rows are auto-purged after 1 day by the `record_coach_call` RPC.
- `Authentication -> Users` - search by email for support cases.
- `Logs -> Postgres logs` - check for `glicko2_update` errors after games end.
- `Logs -> Edge Function logs` (coach) - watch for Groq 429s if usage spikes.
- `Realtime -> Connections` - peak concurrent online players.

If Sentry / PostHog are configured, also bookmark:
- Sentry project -> Issues - prod crashes
- PostHog project -> Events - user activity stream
