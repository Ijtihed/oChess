-- Add puzzle attempt tracking + daily puzzle solved flag
-- Run this in the Supabase SQL Editor

CREATE TABLE IF NOT EXISTS puzzle_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  puzzle_id text NOT NULL,
  puzzle_rating int,
  result text NOT NULL, -- 'solved', 'failed'
  time_spent_ms int,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE puzzle_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own attempts" ON puzzle_attempts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Anyone can read attempts" ON puzzle_attempts FOR SELECT USING (true);
CREATE POLICY "Auth users can insert attempts" ON puzzle_attempts FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE INDEX IF NOT EXISTS idx_puzzle_attempts_user ON puzzle_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_puzzle_attempts_puzzle ON puzzle_attempts(puzzle_id);

-- Add daily puzzle solved tracking to puzzle_progress
ALTER TABLE puzzle_progress ADD COLUMN IF NOT EXISTS daily_puzzle_date text;
ALTER TABLE puzzle_progress ADD COLUMN IF NOT EXISTS daily_puzzle_solved boolean DEFAULT false;
