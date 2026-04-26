# oChess — Launch Checklist

Everything you must do **outside the codebase** before oChess is ready for daily use. Items are grouped by priority. Skip nothing in the BLOCKER section.

---

## BLOCKER — must be done or the app is broken in production

### 1. Add the Stockfish WASM binary

The app loads `/stockfish.js`, which in turn fetches `stockfish.wasm` from the same directory. Without the `.wasm` file, **bot levels 4–7, post-game evaluation, and the analysis engine all fail**.

```
ochess-app/
  public/
    stockfish.js     ← already in repo
    stockfish.wasm   ← MISSING — you must add this
```

- Get the matching `stockfish.wasm` from the same Stockfish 18 release as the bundled `stockfish.js` (e.g. https://github.com/lichess-org/stockfish.wasm/releases or the upstream stockfish.js repo).
- Drop it next to `stockfish.js` in `ochess-app/public/`.
- After deploy, verify in DevTools → Network that `stockfish.wasm` returns 200.

### 2. Add the Lichess puzzle CSV

`.gitignore` excludes the puzzle DB to keep the repo small. Without it the puzzle page errors out.

- Download `lichess_db_puzzle.csv` from https://database.lichess.org/#puzzles (license: ODbL, attribution required).
- Place it at `ochess-app/public/puzzledb/lichess_db_puzzle.csv`.
- For production, either commit a trimmed copy to a private branch or add it as a deploy step (e.g. download in CI and bundle into the static output).

### 3. Create a Supabase project and apply the schema

- New project at https://app.supabase.com.
- Open `Project → SQL Editor → New query`.
- Paste the entire contents of [`supabase/schema.sql`](../supabase/schema.sql) and run.
- The script is idempotent; it can be re-run safely. On a project that has the legacy migrations applied, **read the dedup `DELETE` statements first** — they collapse duplicate seeks and friendships.
- Verify in `Database → Tables` that you see: `profiles`, `ratings`, `games`, `seeks`, `challenges`, `puzzle_progress`, `puzzle_attempts`, `review_cards`, `friendships`.

### 4. Configure auth providers

#### Email (always)

- `Authentication → Providers → Email` — enable.
- For dev, you can disable "Confirm email" so signups log straight in. For prod, leave it on.
- `Authentication → Email Templates` — preview each template; the link should target your **Site URL** (set below), not localhost.
- Production deliverability: configure **custom SMTP** at `Project Settings → Auth → SMTP`. Default Supabase mail is fine for testing only.

#### Google OAuth (optional but recommended)

- Google Cloud Console → `APIs & Services → Credentials → OAuth 2.0 Client ID (Web)`:
  - **Authorized JavaScript origins**: your production origin and `http://localhost:5173` for dev.
  - **Authorized redirect URIs**: `https://<PROJECT_REF>.supabase.co/auth/v1/callback` — this is the **Supabase callback**, not your app origin. The app then redirects back to your origin via `redirectTo: window.location.origin`.
- Supabase → `Authentication → Providers → Google`: paste the Client ID + Client Secret; enable.

#### URL configuration

- Supabase → `Authentication → URL Configuration`:
  - **Site URL**: your production origin, e.g. `https://ochess.example.com`.
  - **Redirect URLs**: include the production origin, any preview URL pattern, and `http://localhost:5173` for dev.

### 5. Set the frontend env vars

- Copy `ochess-app/.env.example` → `ochess-app/.env` for local dev.
- Required:
  - `VITE_SUPABASE_URL` — from `Project Settings → API → Project URL`.
  - `VITE_SUPABASE_ANON_KEY` — `Project Settings → API → anon public` key (NOT the service role key).
- Optional:
  - `VITE_DEBUG=true` — turns on the verbose `[friends]` / `[online-game]` / `[play]` console logs in production. Leave unset for normal users.
- On your hosting platform, add the same `VITE_*` vars to the production environment.
- **Never** put the `service_role` key in any `VITE_*` var or any client-shipped code.

### 6. Confirm the realtime publication

The `schema.sql` script tries to add `seeks`, `games`, `challenges`, `friendships` to the `supabase_realtime` publication. Verify in `Database → Replication → Tables` that all four are toggled on. If not, toggle them manually.

### 7. Confirm the `avatars` storage bucket

The script also creates the `avatars` bucket and attaches per-user RLS. Verify in `Storage` that `avatars` exists and is **public**. If it's missing, create it manually as a public bucket and re-run the storage policy block from `schema.sql`.

### 8. Set up SPA routing on your host

oChess is a single-page app — the host must rewrite every non-asset request to `/index.html` so deep links (`/u/alice`, `/game/online/abc-123`, etc.) hit the React router instead of returning 404.

| Host | Where |
|---|---|
| Vercel | `vercel.json` rewrite: `[{"source": "/(.*)", "destination": "/index.html"}]` |
| Netlify | `_redirects` file with `/* /index.html 200` |
| Cloudflare Pages | already does this for static assets (no config) |
| S3 + CloudFront | Set the **error document** to `index.html` and return 200 for 403/404. |

Build command: `cd ochess-app && npm ci && npm run build`. Publish directory: `ochess-app/dist`.

---

## SHOULD-DO — works without these but you'll regret it

### 9. Schedule `cleanup_stale_seeks`

`schema.sql` defines `cleanup_stale_seeks()` that deletes matchmaking seeks older than 15 minutes. It's restricted to the `service_role` so it can't be called from the client.

Pick one:

- **Supabase Edge Function + cron**: create a small function that runs `await supabase.rpc("cleanup_stale_seeks")` with the service role key and schedule it every 5 minutes via `cron: "*/5 * * * *"` in `supabase/functions/<name>/index.ts`.
- **External cron**: any platform with cron (GitHub Actions on a schedule, Cloudflare Workers Cron, etc.) calling the RPC with the service role key.

### 10. Lock down the `main` branch

`.github/workflows/ci.yml` runs build + test on every PR but doesn't enforce passing checks. Enforce in **GitHub → Settings → Branches → Branch protection rules**:

- Require status check `Build & test` to pass.
- Require PR reviews (recommended, optional).
- Disallow force pushes.

### 11. Add a sign-up email confirmation flow

The app now detects "email confirmation required" and tells the user to check their inbox. Verify your **Confirm signup** template links to your production Site URL and that the confirmation flow works end-to-end before launch.

### 12. Enable error reporting

The repo has no error reporting. Crashes in production are invisible. Pick one:

- **Sentry** — free tier covers low-traffic launches; add `@sentry/react` and wrap `App`.
- **Logtail / Datadog / etc.** — overkill for a chess app at launch.
- **Browser-only fallback** — add a top-level `window.onerror` + `unhandledrejection` listener that logs to a Supabase `errors` table (write your own simple intake).

### 13. Privacy / Terms / Attribution

You're shipping with code under multiple licenses. Add a footer link to a **Legal** page (or markdown) covering at least:

- **Stockfish** is GPLv3. The repo's main code is Apache-2.0; verify your bundling/distribution model is compatible.
- **Lichess puzzle DB** is ODbL — requires attribution.
- **Lichess piece sets / sounds** — credit Lichess (already noted in `docs/architecture.md`).
- **Privacy policy** if you store accounts (you do — emails, ratings, games).

### 14. Migrate to PKCE auth flow

`ochess-app/src/lib/supabase.js` uses `flowType: "implicit"`. Supabase recommends PKCE for SPAs today. Plan a migration to PKCE for tighter security.

---

## NICE-TO-HAVE — polish or future work

### 15. Bundle size

The current production build emits a ~720 KB main chunk. Acceptable for desktop launch; consider lazy-loading routes (`React.lazy` + `Suspense`) for `AnalysisPage`, `GameScreen`, and `OnlineGameScreen` if you target slow networks.

### 16. Custom domain + SSL

Most hosts handle this; ensure `Site URL` and OAuth redirect URIs use the final domain, not the temporary preview URL.

### 17. Analytics

The post-launch loop (per the product context) needs retention data. Pick a privacy-respecting analytics tool (Plausible, PostHog) only after privacy policy is ready.

### 18. Rate limiting on imports

`fetchLichessGames` / `fetchChesscomGames` go directly to public APIs from the browser. There's a 5,000-game cap (Phase 5). If you see abuse, proxy through a small backend.

### 19. Image / asset optimization

`vite.config.js` uses defaults. If you add image optimization (e.g. `vite-imagetools`), do it before publishing the puzzle CSV which is the largest static asset.

---

## Pre-launch test pass

Once everything above is done, walk through these flows on the deployed app:

1. **Cold load `/`** — landing page renders, "Sign In" works, "Play as Guest" actually puts you in guest mode and shows the dashboard.
2. **Sign up with email** — after submit you see "Check your inbox", click the email link, return, sign in.
3. **Google sign-in** — redirects through Google, lands back on `/` signed in. Profile shows your Google name + avatar.
4. **Play a bot game** — start a 5+0, play 3 moves, click Menu, return to `/play`, click Resume — game restores correctly.
5. **Solve a puzzle** — Daily Puzzle on dashboard renders a real puzzle, click it, solve, see rating change.
6. **Online play (need 2 browsers / a friend)** — both click 5+0 → match in <5s → moves sync → resign → result saves and shows in profile.
7. **Challenge link** — create one in browser A, open in browser B (different account), both land in the game.
8. **Hard refresh mid-game** — refresh both browsers — game state restores, clocks resume from server-stored state.
9. **Friend system** — search a username, add friend, accept on the other side — friend appears in SocialPanel within 1–2s (realtime).
10. **Analysis** — open from a finished game, eval bar reads correctly when Black is on move (Phase 4 fix), import 50 games from a small Lichess account, cancel mid-stream.
11. **Avatar upload** — change avatar, refresh — new avatar persists everywhere (header, profile, public profile).
12. **Mobile sweep** — open every page on a 360px-wide viewport — no horizontal scroll, board scales, modals usable.
13. **Sign out** — click Logout from profile — fully clears session, lands on landing.

If all 13 pass, you're good to launch.

---

## Operational dashboard bookmarks

Bookmark these in your Supabase project for daily ops:

- `Database → Tables → games` — sort by `created_at desc` to spot abuse.
- `Database → Tables → seeks` — should be empty most of the time. If it's not, your cleanup cron isn't running.
- `Authentication → Users` — search by email for support cases.
- `Logs → Postgres logs` — check for `glicko2_update` errors after games end.
- `Realtime → Connections` — peak concurrent online players.
