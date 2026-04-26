-- Add persistent rematch tracking columns to games table
-- Run this in the Supabase SQL Editor

-- Stores the user_id of the player who offered a rematch (null = no offer pending)
ALTER TABLE games ADD COLUMN IF NOT EXISTS rematch_offered_by uuid REFERENCES profiles(id) ON DELETE SET NULL;

-- Stores the game_id of the accepted rematch game so both players can find it on reconnect
ALTER TABLE games ADD COLUMN IF NOT EXISTS rematch_game_id uuid REFERENCES games(id) ON DELETE SET NULL;
