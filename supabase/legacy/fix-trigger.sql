-- Run this in Supabase SQL Editor to fix the signup trigger

-- Drop the old trigger and function
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists handle_new_user();

-- Recreate with better error handling
create or replace function handle_new_user()
returns trigger as $$
declare
  _username text;
begin
  -- Generate a unique username
  _username := coalesce(
    new.raw_user_meta_data->>'username',
    new.raw_user_meta_data->>'preferred_username',
    split_part(coalesce(new.email, ''), '@', 1),
    'player'
  ) || '_' || substr(md5(new.id::text), 1, 6);

  -- Insert profile (ignore conflicts)
  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    _username,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(coalesce(new.email, ''), '@', 1), 'Player'),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;

  -- Insert default ratings (ignore conflicts)
  insert into public.ratings (user_id, category)
  values (new.id, 'bullet'), (new.id, 'blitz'), (new.id, 'rapid'), (new.id, 'classical')
  on conflict (user_id, category) do nothing;

  -- Insert puzzle progress (ignore conflicts)
  insert into public.puzzle_progress (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
exception when others then
  -- Log but don't block signup
  raise warning 'handle_new_user failed for %: %', new.id, sqlerrm;
  return new;
end;
$$ language plpgsql security definer;

-- Recreate trigger
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Also grant the function access to the tables
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on all tables in schema public to postgres, service_role;
grant all on all sequences in schema public to postgres, service_role;
