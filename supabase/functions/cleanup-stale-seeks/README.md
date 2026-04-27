# cleanup-stale-seeks (Edge Function)

Periodic job that deletes matchmaking seeks older than 15 minutes.

`schema.sql` ships the `cleanup_stale_seeks()` Postgres RPC and restricts it to the `service_role`. Without a scheduled caller, the `seeks` table grows forever and the open-seeks list pollutes with stale rows.

## Recommended: schedule via `pg_cron` in `schema.sql` (no function needed)

Since Supabase CLI v2.95 dropped `--schedule` from `functions deploy`, the simplest path is to skip Edge Functions entirely and let Postgres call the RPC directly. The bottom of [`../schema.sql`](../../schema.sql) contains a `pg_cron` block that does exactly this:

```sql
create extension if not exists pg_cron with schema extensions;
select cron.schedule(
  'ochess-cleanup-stale-seeks',
  '*/5 * * * *',
  $cron$select cleanup_stale_seeks()$cron$
);
```

Re-running `schema.sql` in the SQL Editor sets up the schedule idempotently. Verify in `Database → Cron Jobs`.

That is the launch path. The Edge Function below is optional.

## Optional: deploy this Edge Function for ad-hoc invocation

Useful if you want a one-off HTTP-callable cleanup endpoint (e.g. to trigger from a CI job, a webhook, or a manual `curl` during incident response).

```bash
# from ochess-app/
npx supabase --workdir .. login
npx supabase --workdir .. link --project-ref <your-project-ref>
npx supabase --workdir .. functions deploy cleanup-stale-seeks
```

To run on demand:

```bash
npx supabase --workdir .. functions invoke cleanup-stale-seeks --no-verify-jwt
```

To inspect logs:

```bash
npx supabase --workdir .. functions logs cleanup-stale-seeks
```

(Newer CLI versions render a paginated log table; there is no `--tail` flag any more — `Ctrl+R` in the table refreshes.)

## Security

- `SUPABASE_SERVICE_ROLE_KEY` is injected by the Supabase platform — never hardcoded.
- The RPC itself is `SECURITY DEFINER` and `revoke execute ... from public, authenticated, anon`, so even a misconfigured function can't be used by the client.
- The function does not accept request body input — no injection surface.
