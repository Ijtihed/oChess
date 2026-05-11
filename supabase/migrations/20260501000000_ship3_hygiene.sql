-- ════════════════════════════════════════════════════════════════
-- Migration: Ship #3 robustness — DB hygiene
-- Date: 2026-05-01
-- Idempotent. Already merged into supabase/schema.sql; this file
-- is the focused diff for projects that already have the prior
-- schema applied and just need to bring these robustness improvements
-- online without re-running the full schema.
--
-- Apply via either:
--   - `supabase db push --linked`    (uses Supabase migrations history)
--   - Paste into Supabase Dashboard -> SQL Editor -> Run
--
-- What this migration does:
--   1. Adds a 32 KB size cap on arena_saved_variants.rules so a
--      single user can't fill the table with multi-megabyte
--      blobs.
--   2. Adds updated_by/updated_at audit columns to ai_settings
--      so kill-switch flips have an attribution trail.
--   3. Schedules nightly retention pruning for arena_visual_errors
--      (>30 days) and arena_moves (>180 days) via pg_cron.
--
-- Safe to re-run on a database that already has any subset of
-- these changes applied.
-- ════════════════════════════════════════════════════════════════

-- ── 1. Size cap on saved variants ──
-- A 32KB rules blob is enough for the largest realistic AI
-- variant (incl. all 7 slot draws + projectiles + overlays).
-- The largest legitimate variants we've seen during testing
-- are ~12KB; doubling that gives headroom for future schema
-- additions without legitimate users hitting the cap.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'arena_saved_variants'
      and constraint_name = 'arena_saved_variants_rules_size'
  ) then
    alter table arena_saved_variants
      add constraint arena_saved_variants_rules_size
      check (length(rules::text) <= 32768);
  end if;
end $$;

-- ── 2. ai_settings audit columns ──
-- updated_at already exists; add updated_by (nullable, since
-- changes from the SQL editor have no auth context).
alter table ai_settings
  add column if not exists updated_by uuid references profiles(id) on delete set null;

-- Trigger to maintain updated_at + updated_by on every UPDATE.
-- Replaces any existing trigger of the same name.
create or replace function ai_settings_audit_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  -- auth.uid() returns NULL for service-role / SQL editor
  -- changes; that's the right behavior - we record "system"
  -- as null rather than fabricating an owner.
  new.updated_by = auth.uid();
  return new;
end;
$$;

drop trigger if exists ai_settings_audit_touch_trg on ai_settings;
create trigger ai_settings_audit_touch_trg
  before update on ai_settings
  for each row
  execute function ai_settings_audit_touch();

-- ── 3. Retention pruning ──
-- Nightly cron at 03:15 UTC (off-peak for most regions). Keeps:
--   - arena_visual_errors:  30 days  (debug / analytics signal)
--   - arena_moves:         180 days  (long enough for replays + analytics)
--
-- arena_rooms cleanup is handled separately (see existing
-- cleanup_stale_arena_rooms job). Saved variants and ai_settings
-- are user data; never auto-prune.
-- arena_moves uses `ts`, NOT `created_at`. The earlier copy of
-- this function referenced a non-existent column and silently
-- failed every night.
create or replace function prune_arena_old_rows()
returns void
language plpgsql
set search_path = public
as $$
begin
  delete from arena_visual_errors where created_at < now() - interval '30 days';
  delete from arena_moves where ts < now() - interval '180 days';
end;
$$;

-- Unschedule any prior version of the job before re-scheduling.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'ochess-prune-arena-old-rows') then
    perform cron.unschedule('ochess-prune-arena-old-rows');
  end if;
exception when others then
  -- pg_cron not available in some local setups; ignore.
  null;
end $$;

do $$
begin
  perform cron.schedule(
    'ochess-prune-arena-old-rows',
    '15 3 * * *',
    $cron$select prune_arena_old_rows()$cron$
  );
exception when others then
  -- pg_cron not available locally; skipped.
  null;
end $$;
