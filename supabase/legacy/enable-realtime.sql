-- Enable Realtime Postgres Changes for seeks and games tables
-- Run in the Supabase SQL Editor → also enable Replication in
-- Database → Replication → Tables for both `seeks` and `games`.

-- Add seeks and games to the Supabase Realtime publication
-- (supabase_realtime is the default publication name)
alter publication supabase_realtime add table seeks;
alter publication supabase_realtime add table games;
