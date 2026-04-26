-- Run this to check if profiles exist
select id, username, display_name, avatar_url, created_at from profiles limit 20;

-- Check if RLS is enabled and policies exist
select tablename, policyname, cmd, qual from pg_policies where tablename = 'profiles';
