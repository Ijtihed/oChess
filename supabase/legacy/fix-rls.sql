-- Fix RLS policies for profile updates
-- Run this in the Supabase SQL Editor

-- Drop old policies
drop policy if exists "Users can update own profile" on profiles;
drop policy if exists "Users can insert own profile" on profiles;
drop policy if exists "Public profiles are viewable by everyone" on profiles;

-- Recreate with proper WITH CHECK
create policy "Public profiles are viewable by everyone"
  on profiles for select using (true);

create policy "Users can insert own profile"
  on profiles for insert with check (auth.uid() = id);

create policy "Users can update own profile"
  on profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Fix ratings policies too
drop policy if exists "System updates ratings" on ratings;
create policy "Users can read all ratings"
  on ratings for select using (true);
create policy "Users can update own ratings"
  on ratings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can insert own ratings"
  on ratings for insert with check (auth.uid() = user_id);

-- Fix puzzle_progress
drop policy if exists "Puzzle progress viewable by owner" on puzzle_progress;
drop policy if exists "Users manage own puzzle progress" on puzzle_progress;
create policy "Users can read own puzzle progress"
  on puzzle_progress for select using (auth.uid() = user_id);
create policy "Users can update own puzzle progress"
  on puzzle_progress for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can insert own puzzle progress"
  on puzzle_progress for insert with check (auth.uid() = user_id);

-- Fix friendships
drop policy if exists "Users can see own friendships" on friendships;
drop policy if exists "Users can create friend requests" on friendships;
drop policy if exists "Users can update friendships involving them" on friendships;
drop policy if exists "Users can delete own friendships" on friendships;

create policy "Users can see own friendships"
  on friendships for select using (auth.uid() in (user_id, friend_id));
create policy "Users can create friend requests"
  on friendships for insert with check (auth.uid() = user_id);
create policy "Users can update friendships involving them"
  on friendships for update using (auth.uid() in (user_id, friend_id)) with check (auth.uid() in (user_id, friend_id));
create policy "Users can delete own friendships"
  on friendships for delete using (auth.uid() in (user_id, friend_id));
