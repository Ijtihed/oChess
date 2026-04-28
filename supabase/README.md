# oChess - Supabase

This folder is the canonical database for oChess. The single source of truth is [`schema.sql`](./schema.sql); focused diffs for incremental updates live in [`migrations/`](./migrations/), and the older per-feature migrations now live in `legacy/` for historical reference only.

## Apply

You have two options:

### Option 1 - Paste the full schema (clean / first install)

1. Open the Supabase project for your environment (`Project -> SQL Editor`).
2. Paste the entire contents of [`schema.sql`](./schema.sql), run.
3. Verify with `npm run check:supabase` from `ochess-app/` (15 checks, exits 0 on full success).

### Option 2 - Apply incremental migrations (existing project)

If you already have an earlier version of the schema applied and just need the latest changes:

```bash
cd ochess-app
npx supabase --workdir .. login
npx supabase --workdir .. link --project-ref <your-project-ref>
npx supabase --workdir .. db push --linked
```

`db push` reads timestamped files from [`migrations/`](./migrations/) and applies them in order, tracking history in `supabase_migrations.schema_migrations` so re-runs are idempotent.

The full schema file is also idempotent: every `create` uses `if not exists`, every `policy` is dropped before recreation, every `alter table` adds columns conditionally, and the realtime publication step uses a `DO` block that checks `pg_publication_tables` first. It is safe to re-run.

For the full operational launch flow (env vars, OAuth, hosting, SPA rewrites) see [`../docs/launch-checklist.md`](../docs/launch-checklist.md).

## Environment variables

The frontend expects these in `ochess-app/.env` (see `ochess-app/.env.example`):

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```

If neither is set, the app falls back to fully local guest mode (bots, puzzles, analysis still work).

Edge Function secrets live separately, set via the CLI:

```bash
npx supabase --workdir .. secrets set GROQ_API_KEY=gsk_xxxxxxxxxxxx
npx supabase --workdir .. secrets list
```

`GROQ_API_KEY` is required for the AI coach in the Plan tab. Get one free at https://console.groq.com (no credit card).

## Auth provider settings

In the Supabase Dashboard:

- `Authentication -> Providers -> Email`: enabled, confirmations off for dev (or wired to your SMTP for prod).
- `Authentication -> Providers -> Google`: client id + secret from the Google Cloud Console.
  - The **Authorized redirect URI** must be Supabase's callback, NOT your app origin: `https://<PROJECT_REF>.supabase.co/auth/v1/callback`.
  - **Authorized JavaScript origins** should include your app origin and `http://localhost:5173`.
  - The app uses `flowType: "pkce"`. PKCE exchanges an authorization code at the redirect URL instead of embedding the access token in the fragment.
- `Authentication -> URL Configuration`: site URL = your deployed origin; add localhost variants to redirect URLs.

## RLS model

| Table | Read | Write |
|---|---|---|
| `profiles` | public | self |
| `ratings` | public | self insert; `glicko2_update` writes via `SECURITY DEFINER` |
| `games` | participants always; everyone after `status='completed'` | participants on active rows; immutable after completion |
| `seeks` | any authenticated user | self insert / delete; `claim_seek` deletes via `SECURITY DEFINER` |
| `challenges` | public | creator only; `accept_challenge` accepts via `SECURITY DEFINER` |
| `friendships` | participants | self insert / participants update / participants delete; `normalize_friend_pair` trigger rejects reverse-pair duplicates |
| `puzzle_progress` | self | self |
| `puzzle_attempts` | self | self (`auth.uid() = user_id` enforced) |
| `review_cards` | self | self (reserved for future cross-device sync) |
| `coach_calls` | RLS on, **no policies** | only the SECURITY DEFINER `record_coach_call` RPC can read / write |

Every `SECURITY DEFINER` RPC begins with an `auth.uid() = p_..._id` check (or `auth.uid() in (white_id, black_id)` for `glicko2_update`) so authenticated clients cannot forge actions for other users.

## Realtime

Live game subscriptions rely on `postgres_changes` events from these tables:

- `seeks` - UI updates the open-seeks list as players join / cancel.
- `games` - the authoritative move / clock / chat / draw / rematch feed.
- `challenges` - the challenge-link page polls for `status='accepted'`.
- `friendships` - accept / decline / remove propagates instantly to both sides of the pair.

`schema.sql` adds all four to `supabase_realtime` automatically.

## Cron / housekeeping

Two `pg_cron` jobs live at the bottom of `schema.sql`:

| Job | Schedule | What it does |
|---|---|---|
| `ochess-cleanup-stale-seeks` | every 5 min | Calls `cleanup_stale_seeks()` to delete matchmaking seeks older than 15 minutes |
| `ochess-cleanup-stale-games` | every 6 hours | Calls `cleanup_stale_games()` to mark active timed games with no move in 24 hours as `aborted` |

Both RPCs are restricted to the `service_role` so a logged-in user can't grief matchmaking. Verify in `Database -> Cron Jobs` that both jobs exist after applying the schema.

The Edge Function at `functions/cleanup-stale-seeks/` is shipped as a manual-invoke fallback. It is NOT required - `pg_cron` handles regular scheduling.

## Edge Functions

| Function | Purpose |
|---|---|
| [`coach`](./functions/coach/) | Bridges the client to Groq's free Llama 3.3 70B for the AI Plan tab. JWT-gated. Per-user rate limit (3 calls / 5 min) via `record_coach_call`. |
| [`cleanup-stale-seeks`](./functions/cleanup-stale-seeks/) | Manual-invoke fallback for the seek-cleanup job. Use `pg_cron` instead in normal operation. |

Deploy from `ochess-app/`:

```bash
npx supabase --workdir .. functions deploy coach
npx supabase --workdir .. functions deploy cleanup-stale-seeks
```

## Storage

The `avatars` bucket is created at the bottom of `schema.sql` with public read + per-user write RLS. Path convention: `<userId>/<timestamp>.<ext>`. The client uploads via `uploadAvatar()` in `lib/auth.js` and cleans up older files in the user's folder after a successful upload, so storage doesn't accumulate one orphan per re-upload.

Verify in `Storage` that the `avatars` bucket exists and is **public**.

## Legacy

The `legacy/` folder retains the original per-feature `add-*.sql` and `fix-*.sql` migrations that were used during early development. They are superseded by `schema.sql` and should not be applied to a new environment. Keep them as a historical record only.
