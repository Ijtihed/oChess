-- ════════════════════════════════════════════════════════════════
-- Migration: Release hardening (May 11, 2026)
-- Date: 2026-05-11
-- Idempotent. Safe to re-run on a database that already has the
-- prior schema applied.
--
-- Closes the security gaps discovered in the pre-release audit.
-- All changes are mirrored into supabase/schema.sql so a fresh
-- apply gets the same shape in one shot. This file is the focused
-- diff for projects that already have the prior schema online.
--
-- What this migration does:
--
--   1.  profiles: column-allowlist trigger (block self-grant of
--       crazy_arena_lab) + admin-only `grant_crazy_arena_lab`.
--   2.  profiles: free-text length / format caps (bio, names).
--   3.  ratings: revoke direct UPDATE; only glicko2_update can mutate.
--   4.  record_coach_call / record_arena_rules_call: clamp client-
--       supplied window/max parameters to the hard caps.
--   5.  record_ai_spend_or_block: validate p_micro_usd >= 0, clamp
--       to 5 USD/call, skip ledger insert when charge is zero.
--   6.  arena_rooms_guard_writes: cover match_result and terminal
--       status transitions; bypass via session GUC for definer RPCs.
--   7.  arena_finalize_match RPC: orchestrator-only path to set
--       match_result + status='done'.
--   8.  arena_apply_move / arena_apply_move_v2: idempotent retry
--       compares stored FEN to p_fen and errors on mismatch
--       instead of silently masking desync.
--   9.  prune_arena_old_rows: use arena_moves.ts (the actual column
--       name) instead of the non-existent created_at.
--  10.  challenges: drop "Anyone can view challenges"; restrict
--       SELECT to creator + waiting rows (code lookup).
--  11.  ai_settings: restrict SELECT to authenticated callers.
--  12.  arena_visual_errors / challenges: bound text columns.
--
-- Apply via either:
--   - `supabase db push --linked`    (Supabase migrations history)
--   - Paste into Supabase Dashboard -> SQL Editor -> Run
-- ════════════════════════════════════════════════════════════════

-- ── 1. profiles: column-allowlist trigger ──
create or replace function profiles_guard_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.id is distinct from old.id then
    raise exception 'profiles.id is immutable';
  end if;
  if new.created_at is distinct from old.created_at then
    new.created_at := old.created_at;
  end if;
  if new.crazy_arena_lab is distinct from old.crazy_arena_lab then
    raise exception 'profiles.crazy_arena_lab is read-only from clients (use grant_crazy_arena_lab)';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_guard_writes_trg on profiles;
create trigger profiles_guard_writes_trg
  before update on profiles
  for each row
  execute function profiles_guard_writes();

create or replace function grant_crazy_arena_lab(p_user_id uuid, p_value boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (current_setting('request.jwt.claim.role', true) = 'service_role'
          or session_user = 'postgres') then
    raise exception 'admin only';
  end if;
  update profiles set crazy_arena_lab = coalesce(p_value, false) where id = p_user_id;
end;
$$;
revoke all on function grant_crazy_arena_lab(uuid, boolean) from public, anon, authenticated;
grant execute on function grant_crazy_arena_lab(uuid, boolean) to service_role;

-- ── 2. profiles: free-text caps ──
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_bio_len') then
    alter table profiles add constraint profiles_bio_len
      check (bio is null or length(bio) <= 600);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_display_name_len') then
    alter table profiles add constraint profiles_display_name_len
      check (display_name is null or length(display_name) <= 60);
  end if;
  -- HARDENING update: the original 4-char cap was meant for ISO
  -- codes, but the UI persists full country names. Drop+recreate
  -- to 64 so legitimate saves succeed.
  if exists (select 1 from pg_constraint where conname = 'profiles_country_len') then
    alter table profiles drop constraint profiles_country_len;
  end if;
  alter table profiles add constraint profiles_country_len
    check (country is null or length(country) <= 64);
  if not exists (select 1 from pg_constraint where conname = 'profiles_lichess_username_len') then
    alter table profiles add constraint profiles_lichess_username_len
      check (lichess_username is null or length(lichess_username) <= 40);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_chesscom_username_len') then
    alter table profiles add constraint profiles_chesscom_username_len
      check (chesscom_username is null or length(chesscom_username) <= 40);
  end if;
end $$;

-- ── 3. Ratings: revoke direct UPDATE + clamp self-repair INSERT ──
drop policy if exists "Users can update own ratings" on ratings;
-- Tighten the self-repair INSERT path so a hostile client cannot
-- bootstrap a ratings row with rating=9000. The columns must hit
-- the Glicko-2 starting defaults to land.
drop policy if exists "Users can insert own ratings" on ratings;
create policy "Users can insert own ratings" on ratings
  for insert with check (
    auth.uid() = user_id
    and category in ('bullet','blitz','rapid','classical')
    and rating between 100 and 3000
    and rd between 50 and 500
    and volatility between 0.0 and 0.5
    and games_played = 0
    and wins = 0
    and losses = 0
    and draws = 0
  );

-- ── 4. Rate-limit RPCs: clamp client params ──
drop function if exists record_coach_call(int, int);
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
  v_window_seconds int;
  v_max_calls int;
begin
  v_window_seconds := least(coalesce(p_window_seconds, 300), 300);
  v_max_calls := least(coalesce(p_max_calls, 3), 3);

  v_uid := auth.uid();
  if v_uid is null then
    return query select false, v_window_seconds, 0, v_window_seconds, v_max_calls;
    return;
  end if;

  delete from coach_calls where created_at < now() - interval '1 day';

  select count(*), min(created_at)
    into v_count, v_oldest
    from coach_calls
   where user_id = v_uid
     and created_at > now() - (v_window_seconds || ' seconds')::interval;

  if v_count >= v_max_calls then
    v_retry := greatest(1, ceil(extract(epoch from
      (v_oldest + (v_window_seconds || ' seconds')::interval - now())))::int);
    return query select false, v_retry, v_count, v_window_seconds, v_max_calls;
    return;
  end if;

  insert into coach_calls(user_id) values (v_uid);
  return query select true, 0, v_count + 1, v_window_seconds, v_max_calls;
end;
$$;
revoke all on function record_coach_call(int, int) from public, anon;
grant execute on function record_coach_call(int, int) to authenticated, service_role;

drop function if exists record_arena_rules_call(int, int);
create or replace function record_arena_rules_call(
  p_window_seconds int default 600,
  p_max_calls int default 10
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
  v_window_seconds int;
  v_max_calls int;
begin
  v_window_seconds := least(coalesce(p_window_seconds, 600), 600);
  v_max_calls := least(coalesce(p_max_calls, 10), 10);

  v_uid := auth.uid();
  if v_uid is null then
    return query select false, v_window_seconds, 0, v_window_seconds, v_max_calls;
    return;
  end if;

  delete from arena_rules_calls where created_at < now() - interval '1 day';

  select count(*), min(created_at)
    into v_count, v_oldest
    from arena_rules_calls
   where user_id = v_uid
     and created_at > now() - (v_window_seconds || ' seconds')::interval;

  if v_count >= v_max_calls then
    v_retry := greatest(1, ceil(extract(epoch from
      (v_oldest + (v_window_seconds || ' seconds')::interval - now())))::int);
    return query select false, v_retry, v_count, v_window_seconds, v_max_calls;
    return;
  end if;

  insert into arena_rules_calls(user_id) values (v_uid);
  return query select true, 0, v_count + 1, v_window_seconds, v_max_calls;
end;
$$;
revoke all on function record_arena_rules_call(int, int) from public, anon;
grant execute on function record_arena_rules_call(int, int) to authenticated, service_role;

-- ── 5. record_ai_spend_or_block: validate amount ──
drop function if exists record_ai_spend_or_block(text, text, text, int, int, bigint, bigint);
create or replace function record_ai_spend_or_block(
  p_feature text,
  p_provider text,
  p_model text,
  p_input_tokens int,
  p_output_tokens int,
  p_micro_usd bigint,
  p_monthly_cap_micro_usd bigint default 0
)
returns table (
  allowed boolean,
  used_micro_usd bigint,
  cap_micro_usd bigint,
  remaining_micro_usd bigint,
  warning_active boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_used bigint;
  v_remaining bigint;
  v_cap bigint;
  v_soft bigint;
  v_charge bigint;
begin
  v_uid := auth.uid();

  if p_micro_usd is null or p_micro_usd < 0 then
    v_charge := 0;
  elsif p_micro_usd > 5000000 then
    v_charge := 5000000;
  else
    v_charge := p_micro_usd;
  end if;

  select monthly_cap_micro_usd, soft_warning_micro_usd
    into v_cap, v_soft
    from ai_settings
   where id = 1;
  if v_cap is null then
    v_cap := 100000000;
    v_soft := 80000000;
  end if;

  select coalesce(sum(micro_usd), 0)
    into v_used
    from ai_spend_log
   where created_at >= date_trunc('month', now() at time zone 'UTC');

  v_remaining := v_cap - v_used;

  if v_used + v_charge > v_cap then
    return query select false, v_used, v_cap, greatest(0::bigint, v_remaining), true;
    return;
  end if;

  if v_charge > 0 then
    insert into ai_spend_log(user_id, feature, provider, model, input_tokens, output_tokens, micro_usd)
      values (v_uid, p_feature, p_provider, p_model, p_input_tokens, p_output_tokens, v_charge);
  end if;

  return query select true, v_used + v_charge, v_cap, v_cap - v_used - v_charge,
    (v_used + v_charge) >= v_soft;
end;
$$;
revoke all on function record_ai_spend_or_block(text, text, text, int, int, bigint, bigint)
  from public, anon;
grant execute on function record_ai_spend_or_block(text, text, text, int, int, bigint, bigint)
  to authenticated, service_role;

-- ── 6. arena_rooms_guard_writes: cover match_result + terminal status ──
create or replace function arena_rooms_guard_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_is_creator boolean;
  v_is_joiner boolean;
  v_bypass text;
begin
  v_bypass := current_setting('ochess.arena_bypass_guard', true);
  if v_bypass = 'on' then
    return new;
  end if;

  v_uid := auth.uid();
  if v_uid is null then
    return new;
  end if;

  v_is_creator := v_uid = old.creator_id;
  v_is_joiner := old.joiner_id is not null and v_uid = old.joiner_id;

  if new.creator_id is distinct from old.creator_id then
    raise exception 'creator_id is immutable';
  end if;
  if new.creator_name is distinct from old.creator_name then
    raise exception 'creator_name is immutable';
  end if;

  if new.rules_creator is distinct from old.rules_creator then
    if not v_is_creator then
      raise exception 'only the creator may change rules_creator';
    end if;
    if old.rules_creator is not null then
      raise exception 'rules_creator is locked once set';
    end if;
  end if;

  if new.joiner_id is distinct from old.joiner_id then
    if old.joiner_id is null and new.joiner_id = v_uid then
      null;
    else
      raise exception 'joiner_id can only be set when the seat is open and only by the claiming user';
    end if;
  end if;

  if new.joiner_name is distinct from old.joiner_name then
    if new.joiner_id = v_uid and old.joiner_id is null then
      null;
    elsif v_is_joiner then
      null;
    else
      raise exception 'only the joiner may change joiner_name';
    end if;
  end if;

  if new.rules_joiner is distinct from old.rules_joiner then
    if new.joiner_id = v_uid and old.joiner_id is null then
      null;
    elsif v_is_joiner then
      if old.rules_joiner is not null then
        raise exception 'rules_joiner is locked once set';
      end if;
    else
      raise exception 'only the joiner may change rules_joiner';
    end if;
  end if;

  if new.match_result is distinct from old.match_result then
    raise exception 'match_result must be set via arena_finalize_match';
  end if;

  if new.status is distinct from old.status
     and new.status in ('done','abandoned') then
    raise exception 'terminal status must be set via orchestrator RPC';
  end if;

  return new;
end;
$$;

drop trigger if exists arena_rooms_guard_writes on arena_rooms;
create trigger arena_rooms_guard_writes
  before update on arena_rooms
  for each row
  execute function arena_rooms_guard_writes();

-- ── 7. arena_finalize_match: orchestrator-only finalize path ──
create or replace function arena_finalize_match(
  p_room_id uuid,
  p_match_result jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_room arena_rooms;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'unauthenticated';
  end if;
  select * into v_room from arena_rooms where id = p_room_id for update;
  if not found then
    raise exception 'room not found';
  end if;
  if v_uid not in (v_room.creator_id, coalesce(v_room.joiner_id, v_uid)) then
    raise exception 'not a participant';
  end if;
  if v_room.status = 'done' then
    return true;
  end if;
  perform set_config('ochess.arena_bypass_guard', 'on', true);
  update arena_rooms
     set match_result = p_match_result,
         status = 'done',
         updated_at = now()
   where id = p_room_id;
  perform set_config('ochess.arena_bypass_guard', 'off', true);
  return true;
end;
$$;
revoke all on function arena_finalize_match(uuid, jsonb) from public, anon;
grant execute on function arena_finalize_match(uuid, jsonb) to authenticated;

-- ── 8. arena_apply_move / v2: FEN check + bypass GUC ──
drop function if exists arena_apply_move(uuid, int, int, text, text, text, text, text, jsonb);
create or replace function arena_apply_move(
  p_room_id uuid,
  p_round int,
  p_ply int,
  p_fen text,
  p_move_from text,
  p_move_to text,
  p_promotion text,
  p_san text,
  p_round_state jsonb
)
returns table (
  ok boolean,
  room arena_rooms,
  error text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_room arena_rooms;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return query select false, null::arena_rooms, 'unauthenticated';
    return;
  end if;

  select * into v_room from arena_rooms where id = p_room_id for update;
  if not found then
    return query select false, null::arena_rooms, 'room not found';
    return;
  end if;
  if v_uid <> v_room.creator_id and v_uid <> v_room.joiner_id then
    return query select false, null::arena_rooms, 'not a participant';
    return;
  end if;
  if v_room.status not in ('round_1','round_2','tiebreak') then
    return query select false, null::arena_rooms, 'room is not in a playable state';
    return;
  end if;

  declare v_existing_fen text;
  begin
    select fen into v_existing_fen
      from arena_moves
      where room_id = p_room_id and round = p_round and ply = p_ply;
    if found then
      if v_existing_fen is distinct from p_fen then
        return query select false, v_room, 'duplicate ply with conflicting fen';
        return;
      end if;
      return query select true, v_room, null::text;
      return;
    end if;
  end;

  insert into arena_moves(room_id, round, ply, fen, move_from, move_to, promotion, san)
    values (p_room_id, p_round, p_ply, p_fen, p_move_from, p_move_to, p_promotion, p_san);

  perform set_config('ochess.arena_bypass_guard', 'on', true);
  update arena_rooms
    set round_state = p_round_state,
        updated_at = now()
    where id = p_room_id
    returning * into v_room;
  perform set_config('ochess.arena_bypass_guard', 'off', true);

  return query select true, v_room, null::text;
end;
$$;
revoke all on function arena_apply_move(uuid, int, int, text, text, text, text, text, jsonb)
  from public, anon;
grant execute on function arena_apply_move(uuid, int, int, text, text, text, text, text, jsonb)
  to authenticated;

drop function if exists arena_apply_move_v2(uuid, int, int, text, text, text, text, text, jsonb, text, text, jsonb, jsonb);
create or replace function arena_apply_move_v2(
  p_room_id uuid,
  p_round int,
  p_ply int,
  p_fen text,
  p_move_from text,
  p_move_to text,
  p_promotion text,
  p_san text,
  p_round_state jsonb,
  p_move_kind text default null,
  p_ability_id text default null,
  p_state_after jsonb default null,
  p_crazy_state jsonb default null
)
returns table (
  ok boolean,
  room arena_rooms,
  error text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_room arena_rooms;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return query select false, null::arena_rooms, 'unauthenticated';
    return;
  end if;

  select * into v_room from arena_rooms where id = p_room_id for update;
  if not found then
    return query select false, null::arena_rooms, 'room not found';
    return;
  end if;
  if v_uid <> v_room.creator_id and v_uid <> v_room.joiner_id then
    return query select false, null::arena_rooms, 'not a participant';
    return;
  end if;
  if v_room.status not in ('round_1','round_2','tiebreak') then
    return query select false, null::arena_rooms, 'room is not in a playable state';
    return;
  end if;

  declare v_existing_fen text;
  begin
    select fen into v_existing_fen
      from arena_moves
      where room_id = p_room_id and round = p_round and ply = p_ply;
    if found then
      if v_existing_fen is distinct from p_fen then
        return query select false, v_room, 'duplicate ply with conflicting fen';
        return;
      end if;
      return query select true, v_room, null::text;
      return;
    end if;
  end;

  insert into arena_moves(room_id, round, ply, fen, move_from, move_to, promotion, san, move_kind, ability_id, state_after)
    values (p_room_id, p_round, p_ply, p_fen, p_move_from, p_move_to, p_promotion, p_san, p_move_kind, p_ability_id, p_state_after);

  perform set_config('ochess.arena_bypass_guard', 'on', true);
  update arena_rooms
    set round_state = p_round_state,
        crazy_state = p_crazy_state,
        updated_at = now()
    where id = p_room_id
    returning * into v_room;
  perform set_config('ochess.arena_bypass_guard', 'off', true);

  return query select true, v_room, null::text;
end;
$$;
revoke all on function arena_apply_move_v2(uuid, int, int, text, text, text, text, text, jsonb, text, text, jsonb, jsonb)
  from public, anon;
grant execute on function arena_apply_move_v2(uuid, int, int, text, text, text, text, text, jsonb, text, text, jsonb, jsonb)
  to authenticated;

-- ── 9. prune uses the right column ──
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

-- ── 10. challenges: restrict SELECT ──
-- HARDENING: previous policy `(auth.uid() = creator_id or
-- status = 'waiting')` evaluated to TRUE for anon callers on
-- every waiting row (NULL OR TRUE = TRUE), exposing the join
-- code. Now require authenticated callers; the legitimate
-- joiner already signs in before accepting.
drop policy if exists "Anyone can view challenges" on challenges;
drop policy if exists "Participants can view their challenges" on challenges;
create policy "Participants can view their challenges" on challenges
  for select using (
    auth.role() = 'authenticated'
    and (
      auth.uid() = creator_id
      or status = 'waiting'
    )
  );

-- ── 11. ai_settings: restrict SELECT to authenticated ──
drop policy if exists "Anyone reads ai_settings" on ai_settings;
drop policy if exists "Authenticated reads ai_settings" on ai_settings;
create policy "Authenticated reads ai_settings" on ai_settings
  for select using (auth.role() = 'authenticated');

-- ── 12. Length caps on free-text columns ──
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'arena_visual_errors_message_len') then
    alter table arena_visual_errors add constraint arena_visual_errors_message_len
      check (length(message) <= 4096);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'arena_visual_errors_stack_len') then
    alter table arena_visual_errors add constraint arena_visual_errors_stack_len
      check (stack is null or length(stack) <= 8192);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'challenges_code_len') then
    alter table challenges add constraint challenges_code_len
      check (length(code) <= 64);
  end if;
  -- HARDENING: bound `games.chat` so a patched client can't push
  -- megabytes of chat into a single row. Client already caps to
  -- 50 messages; 200 here is a comfortable headroom. The PGN cap
  -- protects against the same shape of attack on the move log.
  if not exists (select 1 from pg_constraint where conname = 'games_chat_size') then
    alter table games add constraint games_chat_size
      check (chat is null or (
        jsonb_typeof(chat) = 'array'
        and jsonb_array_length(chat) <= 200
        and length(chat::text) <= 65536
      ));
  end if;
  -- Cap PGN at 64KB. Longest plausible game (correspondence,
  -- 500-move with annotations) sits well under 32KB; 64KB is 2x.
  -- An attacker who somehow forged a PGN write through RLS
  -- couldn't bloat the row past this.
  if not exists (select 1 from pg_constraint where conname = 'games_pgn_size') then
    alter table games add constraint games_pgn_size
      check (length(pgn) <= 65536);
  end if;
end $$;

-- Update arena_advance_round to bypass the guard trigger when
-- writing match_result + terminal status. This is the
-- pre-existing orchestrator path; the only change is the
-- set_config GUC bracket.
drop function if exists arena_advance_round(uuid, text, jsonb, jsonb, text);
create or replace function arena_advance_round(
  p_room_id uuid,
  p_round_label text,
  p_match_result jsonb,
  p_round_state jsonb,
  p_next_status text
)
returns table (
  ok boolean,
  applied boolean,
  room arena_rooms,
  error text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_room arena_rooms;
  v_existing_rounds jsonb;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return query select false, false, null::arena_rooms, 'unauthenticated';
    return;
  end if;

  select * into v_room from arena_rooms where id = p_room_id for update;
  if not found then
    return query select false, false, null::arena_rooms, 'room not found';
    return;
  end if;
  if v_uid <> v_room.creator_id and v_uid <> v_room.joiner_id then
    return query select false, false, null::arena_rooms, 'not a participant';
    return;
  end if;

  v_existing_rounds := coalesce(v_room.match_result->'rounds', '[]'::jsonb);
  if exists (
    select 1 from jsonb_array_elements(v_existing_rounds) elt
    where elt->>'round' = p_round_label
  ) then
    return query select true, false, v_room, null::text;
    return;
  end if;

  perform set_config('ochess.arena_bypass_guard', 'on', true);
  update arena_rooms
    set match_result = p_match_result,
        round_state = p_round_state,
        crazy_state = null,
        status = p_next_status,
        updated_at = now()
    where id = p_room_id
    returning * into v_room;
  perform set_config('ochess.arena_bypass_guard', 'off', true);

  return query select true, true, v_room, null::text;
end;
$$;
revoke all on function arena_advance_round(uuid, text, jsonb, jsonb, text)
  from public, anon;
grant execute on function arena_advance_round(uuid, text, jsonb, jsonb, text)
  to authenticated;

-- ════════════════════════════════════════════════════════════════
-- End of migration.
-- ════════════════════════════════════════════════════════════════
