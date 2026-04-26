-- Create profiles for any auth users that are missing one
-- Run this in the Supabase SQL Editor

INSERT INTO public.profiles (id, username, display_name, avatar_url)
SELECT 
  u.id,
  coalesce(u.raw_user_meta_data->>'preferred_username', split_part(coalesce(u.email, ''), '@', 1), 'player') || '_' || substr(md5(u.id::text), 1, 6),
  coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(coalesce(u.email, ''), '@', 1), 'Player'),
  u.raw_user_meta_data->>'avatar_url'
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL
ON CONFLICT (id) DO NOTHING;

-- Create default ratings for users missing them
INSERT INTO public.ratings (user_id, category)
SELECT u.id, cat.category
FROM auth.users u
CROSS JOIN (VALUES ('bullet'), ('blitz'), ('rapid'), ('classical')) AS cat(category)
LEFT JOIN public.ratings r ON r.user_id = u.id AND r.category = cat.category
WHERE r.id IS NULL
ON CONFLICT (user_id, category) DO NOTHING;

-- Create puzzle progress for users missing it
INSERT INTO public.puzzle_progress (user_id)
SELECT u.id FROM auth.users u
LEFT JOIN public.puzzle_progress p ON p.user_id = u.id
WHERE p.id IS NULL
ON CONFLICT (user_id) DO NOTHING;

-- Verify
SELECT id, username, display_name, avatar_url FROM public.profiles;
