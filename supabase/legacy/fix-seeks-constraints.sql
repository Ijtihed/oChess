-- ══════════════════════════════════════════════════════════════
-- Fix seeks: one seek per user + auto-expire stale seeks
-- Run in the Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════

-- 1. Clean up any duplicate seeks (keep the newest per user)
delete from seeks
where id not in (
  select distinct on (user_id) id
  from seeks
  order by user_id, created_at desc
);

-- 2. Add unique constraint so a user can only have one active seek
-- (If a user already has a seek, they must cancel it before creating another)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'seeks_one_per_user'
  ) then
    alter table seeks add constraint seeks_one_per_user unique (user_id);
  end if;
end $$;

-- 3. Auto-expire seeks older than 15 minutes (prevents ghost seeks)
-- This can be called periodically or via a cron extension
create or replace function cleanup_stale_seeks()
returns void as $$
begin
  delete from seeks where created_at < now() - interval '15 minutes';
end;
$$ language plpgsql security definer;

-- 4. Update claim_seek to also clean up any seeks by the claimer
-- (prevents the claimer from having a dangling seek after joining a game)
create or replace function claim_seek(
  p_seek_id uuid,
  p_claimer_id uuid,
  p_claimer_name text,
  p_claimer_rating float
)
returns jsonb as $$
declare
  v_seek record;
  v_game_id uuid;
  v_white_id uuid;
  v_black_id uuid;
  v_white_name text;
  v_black_name text;
  v_white_rating float;
  v_black_rating float;
  v_flip boolean;
begin
  -- Delete any seeks the claimer has (they're joining a game now)
  delete from seeks where user_id = p_claimer_id;

  -- Atomically delete the target seek
  delete from seeks where id = p_seek_id
  returning * into v_seek;

  if v_seek is null then
    return jsonb_build_object('error', 'Seek no longer available');
  end if;

  if v_seek.user_id = p_claimer_id then
    return jsonb_build_object('error', 'Cannot claim your own seek');
  end if;

  -- Assign colors
  v_flip := random() < 0.5;
  if v_seek.color_pref = 'white' then
    v_white_id := v_seek.user_id; v_black_id := p_claimer_id;
    v_white_name := v_seek.username; v_black_name := p_claimer_name;
    v_white_rating := v_seek.rating; v_black_rating := p_claimer_rating;
  elsif v_seek.color_pref = 'black' then
    v_white_id := p_claimer_id; v_black_id := v_seek.user_id;
    v_white_name := p_claimer_name; v_black_name := v_seek.username;
    v_white_rating := p_claimer_rating; v_black_rating := v_seek.rating;
  elsif v_flip then
    v_white_id := v_seek.user_id; v_black_id := p_claimer_id;
    v_white_name := v_seek.username; v_black_name := p_claimer_name;
    v_white_rating := v_seek.rating; v_black_rating := p_claimer_rating;
  else
    v_white_id := p_claimer_id; v_black_id := v_seek.user_id;
    v_white_name := p_claimer_name; v_black_name := v_seek.username;
    v_white_rating := p_claimer_rating; v_black_rating := v_seek.rating;
  end if;

  -- Create the game
  insert into games (white_id, black_id, white_name, black_name, white_rating, black_rating,
                     pgn, time_control, category, variant, is_rated, status)
  values (v_white_id, v_black_id, v_white_name, v_black_name, v_white_rating, v_black_rating,
          '', v_seek.time_control, v_seek.category, v_seek.variant, v_seek.is_rated, 'active')
  returning id into v_game_id;

  return (select row_to_json(g)::jsonb from games g where g.id = v_game_id);
end;
$$ language plpgsql security definer;

grant execute on function claim_seek(uuid, uuid, text, float) to authenticated;
grant execute on function cleanup_stale_seeks() to authenticated;
