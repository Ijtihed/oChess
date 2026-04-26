-- Fix duplicate friendships
-- Run this in the Supabase SQL Editor

-- 1. Delete duplicate rows (keep the oldest one per pair)
DELETE FROM friendships a
USING friendships b
WHERE a.id > b.id
  AND ((a.user_id = b.user_id AND a.friend_id = b.friend_id)
    OR (a.user_id = b.friend_id AND a.friend_id = b.user_id));

-- 2. Add a unique index on the normalized pair (smaller UUID first)
CREATE OR REPLACE FUNCTION normalize_friendship_pair(a uuid, b uuid)
RETURNS text AS $$
BEGIN
  IF a < b THEN RETURN a::text || ':' || b::text;
  ELSE RETURN b::text || ':' || a::text;
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

DROP INDEX IF EXISTS idx_unique_friendship_pair;
CREATE UNIQUE INDEX idx_unique_friendship_pair
  ON friendships (normalize_friendship_pair(user_id, friend_id));
