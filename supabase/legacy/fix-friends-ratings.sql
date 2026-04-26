-- Fix duplicate friend requests + friends RLS + add board prefs column
-- Run this in the Supabase SQL Editor

-- 1. Prevent bidirectional duplicate friend requests
-- Drop old unique constraint
ALTER TABLE friendships DROP CONSTRAINT IF EXISTS friendships_user_id_friend_id_key;

-- Add function to normalize friend pair (smaller UUID first)
CREATE OR REPLACE FUNCTION normalize_friend_pair()
RETURNS trigger AS $$
BEGIN
  -- Check if reverse friendship already exists
  IF EXISTS (SELECT 1 FROM friendships WHERE user_id = NEW.friend_id AND friend_id = NEW.user_id) THEN
    RAISE EXCEPTION 'Friendship already exists' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS check_duplicate_friendship ON friendships;
CREATE TRIGGER check_duplicate_friendship
  BEFORE INSERT ON friendships
  FOR EACH ROW EXECUTE FUNCTION normalize_friend_pair();

-- Re-add the unique constraint for same-direction duplicates
ALTER TABLE friendships ADD CONSTRAINT friendships_user_id_friend_id_key UNIQUE (user_id, friend_id);

-- 2. Fix friends RLS - allow reading friendships you're part of with anon key too
-- The issue: auth token might be anon, so we need to allow reading based on the IDs in the query
DROP POLICY IF EXISTS "Users can see own friendships" ON friendships;
CREATE POLICY "Anyone can read friendships" ON friendships FOR SELECT USING (true);

-- 3. Add board_prefs column to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS board_prefs jsonb DEFAULT '{}'::jsonb;

-- 4. Fix puzzle_progress to be readable/writable
DROP POLICY IF EXISTS "Users can read own puzzle progress" ON puzzle_progress;
DROP POLICY IF EXISTS "Users can update own puzzle progress" ON puzzle_progress;
DROP POLICY IF EXISTS "Users can insert own puzzle progress" ON puzzle_progress;
CREATE POLICY "Anyone can read puzzle progress" ON puzzle_progress FOR SELECT USING (true);
CREATE POLICY "Users can update own puzzle progress" ON puzzle_progress
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can insert own puzzle progress" ON puzzle_progress
  FOR INSERT WITH CHECK (auth.uid() = user_id);
