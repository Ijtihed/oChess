-- Invalidate all sessions (logs everyone out)
-- Run this in the Supabase SQL Editor

delete from auth.sessions;
delete from auth.refresh_tokens;
