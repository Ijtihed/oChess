# cleanup-stale-seeks (Edge Function)

Periodic job that deletes matchmaking seeks older than 15 minutes.

`schema.sql` ships the `cleanup_stale_seeks()` Postgres RPC and restricts it to the `service_role`. Without a scheduled caller, the `seeks` table grows forever and the open-seeks list pollutes with stale rows. This function is the recommended way to call it.

## Why this and not `pg_cron`

`pg_cron` works too if you have it enabled and prefer to keep cleanup inside the database. The Edge Function approach is preferred because:

- It's visible in the Supabase dashboard logs (`Functions → cleanup-stale-seeks → Logs`).
- It works on Supabase free / pro projects without enabling extra extensions.
- The schedule is part of the function manifest — re-deploying redeploys the cron.

## Deploy

You only need to do this once.

```bash
# 1. Authenticate the Supabase CLI with your account.
supabase login

# 2. Link this folder to your project.
#    Project ref is the slug part of your Supabase URL,
#    e.g. https://abcdefghijkl.supabase.co  →  abcdefghijkl
supabase link --project-ref <your-project-ref>

# 3. Deploy with a 5-minute cron schedule.
supabase functions deploy cleanup-stale-seeks --schedule "*/5 * * * *"
```

The CLI uploads `index.ts`, registers the schedule, and wires up `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` automatically.

## Verify

```bash
supabase functions logs cleanup-stale-seeks --tail
```

You should see a `{ ok: true, elapsedMs: ..., ranAt: ... }` line every 5 minutes after deploy.

You can also invoke it on-demand to confirm correctness:

```bash
supabase functions invoke cleanup-stale-seeks --no-verify-jwt
```

## Security

- `SUPABASE_SERVICE_ROLE_KEY` is injected by the Supabase platform — never hardcoded.
- The RPC itself is `SECURITY DEFINER` and `revoke execute ... from public, authenticated, anon`, so even if this function were misconfigured, no client-side caller can run it.
- The function does not accept any input from the request body, so there is no injection surface.
