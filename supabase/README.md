# oChess — Supabase

This folder is the canonical database for oChess. The single source of truth is [`schema.sql`](./schema.sql); the older per-feature migrations now live in [`legacy/`](./legacy/) for historical reference only.

## Apply

1. Open the Supabase project for your environment (`Project → SQL Editor`).
2. Paste the entire contents of `schema.sql`, run.
3. Verify in `Database → Replication → Tables` that `seeks`, `games`, and `challenges` are all part of the `supabase_realtime` publication.

The script is idempotent: every `create` uses `if not exists`, every `policy` is dropped before recreation, every `alter table` adds columns conditionally, and the realtime publication step uses a `DO` block that checks `pg_publication_tables` first. It is safe to re-run on any environment to converge to the target shape.

## Environment variables

The frontend expects these in `ochess-app/.env` (see `ochess-app/.env.example`):

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```

If neither is set, the app falls back to fully local guest mode (bots, puzzles, analysis still work).

## Auth provider settings

In the Supabase Dashboard:

- `Authentication → Providers → Email`: enabled, confirmations off for dev (or wired to your SMTP for prod).
- `Authentication → Providers → Google`: client id + secret from the Google Cloud Console; redirect to `<app-origin>/`.
- `Authentication → URL Configuration`: site URL = your deployed origin; add localhost variants to redirect URLs.

## RLS model

| Table | Read | Write |
|---|---|---|
| `profiles` | public | self |
| `ratings` | public | self insert; `glicko2_update` writes via `SECURITY DEFINER` |
| `games` | participants always; everyone after `status='completed'` | participants on active rows; immutable after completion |
| `seeks` | any authenticated user | self insert / delete; `claim_seek` deletes via `SECURITY DEFINER` |
| `challenges` | public | creator only; `accept_challenge` accepts via `SECURITY DEFINER` |
| `friendships` | participants | self insert / participants update / participants delete |
| `puzzle_progress` | self | self |
| `puzzle_attempts` | self | self (`auth.uid() = user_id` enforced) |
| `review_cards` | self | self |

Every `SECURITY DEFINER` RPC begins with a `auth.uid() = p_…_id` (or `auth.uid() in (white_id, black_id)` for `glicko2_update`) check so that authenticated clients cannot forge actions for other users.

## Realtime

Live game subscriptions rely on `postgres_changes` events from these tables:

- `seeks` — UI updates the open-seeks list as players join / cancel.
- `games` — the authoritative move / clock / chat / draw / rematch feed.
- `challenges` — the challenge-link page polls for `status='accepted'`.

`schema.sql` adds all three to `supabase_realtime` automatically.

## Cron / housekeeping

`cleanup_stale_seeks()` removes seeks older than 15 minutes. There is no cron extension dependency in this folder; you can wire it up via `pg_cron` or call it manually:

```sql
select cleanup_stale_seeks();
```

## Legacy

The `legacy/` folder retains the original per-feature `add-*.sql` and `fix-*.sql` migrations that were used during development. They are superseded by `schema.sql` and should not be applied to a new environment. Keep them as a historical record only; consult them if you need to understand how the schema evolved.
