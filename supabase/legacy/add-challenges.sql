-- Add challenges table for game links
-- Run this in the Supabase SQL Editor

create table if not exists challenges (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  creator_id uuid not null references profiles(id) on delete cascade,
  creator_name text not null,
  creator_rating float default 1500,
  time_control text not null default '10+0',
  color_pref text default 'random',
  status text default 'waiting', -- 'waiting', 'accepted', 'expired'
  game_id uuid references games(id),
  created_at timestamptz default now()
);

alter table challenges enable row level security;
create policy "Anyone can view challenges" on challenges for select using (true);
create policy "Auth users can create challenges" on challenges for insert with check (auth.uid() = creator_id);
create policy "Auth users can update challenges" on challenges for update using (true) with check (true);
create policy "Creator can delete challenges" on challenges for delete using (auth.uid() = creator_id);

create index if not exists idx_challenges_code on challenges(code);
create index if not exists idx_challenges_status on challenges(status);

alter publication supabase_realtime add table challenges;
