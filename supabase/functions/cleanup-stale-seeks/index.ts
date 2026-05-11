// Deno-based Supabase Edge Function.
//
// Purpose: invoke the `cleanup_stale_seeks()` SECURITY DEFINER RPC
// from `supabase/schema.sql`, which deletes matchmaking seeks older
// than 15 minutes. The RPC is restricted to the `service_role`, so it
// MUST run from a trusted server context — never from the browser.
//
// Deploy + schedule:
//   supabase login
//   supabase link --project-ref <your-project-ref>
//   supabase functions deploy cleanup-stale-seeks --schedule "*/5 * * * *"
//
// Verify:
//   supabase functions logs cleanup-stale-seeks --tail
//
// Security: the function reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// from the Supabase platform's automatic secrets. You do NOT set these
// yourself. NEVER hardcode keys here or commit them to the repo.

import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (_req) => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    return new Response(
      JSON.stringify({ error: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const startedAt = Date.now();
  const { error } = await supabase.rpc("cleanup_stale_seeks");
  const elapsedMs = Date.now() - startedAt;

  if (error) {
    // HARDENING: log details server-side, return a generic message
    // to the caller. Postgres error messages can leak schema /
    // policy details that aren't useful to legitimate ops callers
    // and are harmful to attackers probing the function.
    try {
      // eslint-disable-next-line no-console
      console.error("[cleanup-stale-seeks] RPC error", error.code, error.message);
    } catch { /* swallow */ }
    return new Response(
      JSON.stringify({ ok: false, elapsedMs, error: "cleanup failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ ok: true, elapsedMs, ranAt: new Date().toISOString() }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
