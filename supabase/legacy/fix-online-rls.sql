-- ══════════════════════════════════════════════════════════════
-- Fix Online Play: RLS policies + atomic RPC functions
-- Run this in the Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════

-- ── 1. Fix games policies ──

drop policy if exists "Completed games are viewable by everyone" on games;
drop policy if exists "Players can view their active games" on games;
drop policy if exists "Players can update their active games" on games;
drop policy if exists "Authenticated users can create games" on games;

create policy "Anyone can view completed games" on games for select using (status = 'completed');
create policy "Players can view own games" on games for select using (auth.uid() in (white_id, black_id));
create policy "Auth users can create games" on games for insert with check (auth.role() = 'authenticated');
create policy "Players can update own games" on games
  for update using (auth.uid() in (white_id, black_id))
  with check (auth.uid() in (white_id, black_id));

-- ── 2. Fix challenges policies ──

drop policy if exists "Anyone can view challenges" on challenges;
drop policy if exists "Auth users can create challenges" on challenges;
drop policy if exists "Auth users can update challenges" on challenges;
drop policy if exists "Creator can delete challenges" on challenges;

create policy "Anyone can view challenges" on challenges for select using (true);
create policy "Auth users can create challenges" on challenges for insert with check (auth.uid() = creator_id);
create policy "Auth users can update own or accept challenges" on challenges
  for update using (auth.uid() = creator_id or status = 'waiting')
  with check (status in ('waiting', 'accepted', 'expired'));
create policy "Creator can delete challenges" on challenges for delete using (auth.uid() = creator_id);

-- ── 3. Fix seeks policies ──

drop policy if exists "Anyone can view seeks" on seeks;
drop policy if exists "Seeks are viewable by authenticated" on seeks;
drop policy if exists "Auth users can create seeks" on seeks;
drop policy if exists "Users can create seeks" on seeks;
drop policy if exists "Auth users can delete seeks" on seeks;
drop policy if exists "Users can delete own seeks" on seeks;
drop policy if exists "Auth users can delete matched seeks" on seeks;

create policy "Auth users can view seeks" on seeks for select using (auth.role() = 'authenticated');
create policy "Auth users can create seeks" on seeks for insert with check (auth.uid() = user_id);
create policy "Auth users can delete own seeks" on seeks for delete using (auth.uid() = user_id);

-- ── 4. Atomic challenge acceptance RPC ──

create or replace function accept_challenge(
  p_challenge_id uuid,
  p_joiner_id uuid,
  p_joiner_name text,
  p_joiner_rating float
)
returns jsonb as $$
declare
  v_challenge record;
  v_game_id uuid;
  v_white_id uuid;
  v_black_id uuid;
  v_white_name text;
  v_black_name text;
  v_white_rating float;
  v_black_rating float;
  v_flip boolean;
  v_category text;
begin
  -- Lock and fetch the challenge
  select * into v_challenge
  from challenges
  where id = p_challenge_id and status = 'waiting'
  for update skip locked;

  if v_challenge is null then
    return jsonb_build_object('error', 'Challenge not found, already accepted, or expired');
  end if;

  if v_challenge.creator_id = p_joiner_id then
    return jsonb_build_object('error', 'Cannot accept your own challenge');
  end if;

  -- Assign colors
  v_flip := random() < 0.5;
  if v_challenge.color_pref = 'white' then
    v_white_id := v_challenge.creator_id; v_black_id := p_joiner_id;
    v_white_name := v_challenge.creator_name; v_black_name := p_joiner_name;
    v_white_rating := v_challenge.creator_rating; v_black_rating := p_joiner_rating;
  elsif v_challenge.color_pref = 'black' then
    v_white_id := p_joiner_id; v_black_id := v_challenge.creator_id;
    v_white_name := p_joiner_name; v_black_name := v_challenge.creator_name;
    v_white_rating := p_joiner_rating; v_black_rating := v_challenge.creator_rating;
  elsif v_flip then
    v_white_id := v_challenge.creator_id; v_black_id := p_joiner_id;
    v_white_name := v_challenge.creator_name; v_black_name := p_joiner_name;
    v_white_rating := v_challenge.creator_rating; v_black_rating := p_joiner_rating;
  else
    v_white_id := p_joiner_id; v_black_id := v_challenge.creator_id;
    v_white_name := p_joiner_name; v_black_name := v_challenge.creator_name;
    v_white_rating := p_joiner_rating; v_black_rating := v_challenge.creator_rating;
  end if;

  -- Determine category from time control
  v_category := 'blitz';
  if v_challenge.time_control ~ '^\d+\+\d+$' then
    declare
      v_base int := split_part(v_challenge.time_control, '+', 1)::int;
      v_inc int := split_part(v_challenge.time_control, '+', 2)::int;
      v_total int := v_base * 60 + v_inc * 40;
    begin
      if v_total < 180 then v_category := 'bullet';
      elsif v_total < 480 then v_category := 'blitz';
      elsif v_total < 1500 then v_category := 'rapid';
      else v_category := 'classical';
      end if;
    end;
  end if;

  -- Create the game
  insert into games (white_id, black_id, white_name, black_name, white_rating, black_rating,
                     pgn, time_control, category, variant, is_rated, status)
  values (v_white_id, v_black_id, v_white_name, v_black_name, v_white_rating, v_black_rating,
          '', v_challenge.time_control, v_category, 'standard', false, 'active')
  returning id into v_game_id;

  -- Mark challenge as accepted
  update challenges set status = 'accepted', game_id = v_game_id where id = p_challenge_id;

  -- Return the game
  return (select row_to_json(g)::jsonb from games g where g.id = v_game_id);
end;
$$ language plpgsql security definer;

-- ── 5. Atomic seek claim RPC ──

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
  -- Atomically delete the seek (only if it still exists)
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

-- Grant execute to authenticated users
grant execute on function accept_challenge(uuid, uuid, text, float) to authenticated;
grant execute on function claim_seek(uuid, uuid, text, float) to authenticated;
