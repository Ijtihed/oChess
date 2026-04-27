-- ════════════════════════════════════════════════════════════════
-- Migration: per-user rate limit for the AI coach Edge Function
-- Date: 2026-04-27
-- Idempotent. Already merged into supabase/schema.sql; this file
-- is the focused diff for projects that already have the prior
-- schema applied and just need to bring rate-limiting online
-- without re-running the full ~1000-line schema.
--
-- Apply via either:
--   - `supabase db push --linked`    (uses Supabase migrations history)
--   - Paste into Supabase Dashboard -> SQL Editor -> Run
--
-- After applying:
--   1. Re-deploy the coach function so the runtime gates calls:
--        cd ochess-app
--        npx supabase --workdir .. functions deploy coach
--   2. Verify with:
--        npm run check:supabase
-- ════════════════════════════════════════════════════════════════

-- 1. Log table (RLS on, no policies → opaque to clients).
create table if not exists coach_calls (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists idx_coach_calls_user_created
  on coach_calls(user_id, created_at desc);
alter table coach_calls enable row level security;

-- 2. SECURITY DEFINER RPC. Counts the user's recent calls; if under
-- the cap, inserts a fresh row and returns allowed=true. If over,
-- returns the exact retry-after seconds.
create or replace function record_coach_call(
  p_window_seconds int default 300,
  p_max_calls int default 3
)
returns table (
  allowed boolean,
  retry_after_seconds int,
  calls_in_window int,
  window_seconds int,
  max_calls int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_count int;
  v_oldest timestamptz;
  v_retry int;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return query select false, p_window_seconds, 0, p_window_seconds, p_max_calls;
    return;
  end if;

  delete from coach_calls where created_at < now() - interval '1 day';

  select count(*), min(created_at)
    into v_count, v_oldest
    from coach_calls
   where user_id = v_uid
     and created_at > now() - (p_window_seconds || ' seconds')::interval;

  if v_count >= p_max_calls then
    v_retry := greatest(1, ceil(extract(epoch from
      (v_oldest + (p_window_seconds || ' seconds')::interval - now())))::int);
    return query select false, v_retry, v_count, p_window_seconds, p_max_calls;
    return;
  end if;

  insert into coach_calls(user_id) values (v_uid);
  return query select true, 0, v_count + 1, p_window_seconds, p_max_calls;
end;
$$;

revoke all on function record_coach_call(int, int) from public, anon;
grant execute on function record_coach_call(int, int) to authenticated, service_role;
