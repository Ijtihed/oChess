-- Add draw request tracking
-- Run this in the Supabase SQL Editor

ALTER TABLE games ADD COLUMN IF NOT EXISTS white_draw_offers int DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS black_draw_offers int DEFAULT 0;
