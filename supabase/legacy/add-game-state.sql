-- Add server-authoritative clock + chat to games table
-- Run this in the Supabase SQL Editor

-- Clock columns
ALTER TABLE games ADD COLUMN IF NOT EXISTS white_time_ms int;
ALTER TABLE games ADD COLUMN IF NOT EXISTS black_time_ms int;
ALTER TABLE games ADD COLUMN IF NOT EXISTS last_move_at timestamptz;
ALTER TABLE games ADD COLUMN IF NOT EXISTS turn text DEFAULT 'w';

-- Chat column
ALTER TABLE games ADD COLUMN IF NOT EXISTS chat jsonb DEFAULT '[]'::jsonb;
