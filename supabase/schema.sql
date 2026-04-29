-- ════════════════════════════════════════════════════════════════
-- oChess — canonical Supabase schema (v2)
--
-- One file. Idempotent. Apply once on a fresh Supabase project, or
-- re-run on an existing one to converge to the target shape.
--
-- See ./README.md for a one-shot apply runbook and the rationale
-- behind RLS / RPC choices. Old per-feature migrations live in
-- ./legacy/ and should be considered superseded by this file.
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- TABLES
-- ────────────────────────────────────────────────────────────────

-- ── profiles ──
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text,
  avatar_url text,
  bio text,
  country text,
  lichess_username text,
  chesscom_username text,
  board_prefs jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table profiles add column if not exists board_prefs jsonb default '{}'::jsonb;

-- ── ratings (Glicko-2 per time control) ──
create table if not exists ratings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  category text not null default 'blitz',
  rating float not null default 1500,
  rd float not null default 350,
  volatility float not null default 0.06,
  games_played int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  draws int not null default 0,
  updated_at timestamptz default now(),
  unique(user_id, category)
);

-- ── games ──
-- white_id/black_id use ON DELETE SET NULL so a user deleting their
-- account doesn't get blocked by historical game rows. The names are
-- already denormalised into white_name/black_name so the audit trail
-- survives even when the player rows are gone.
create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  white_id uuid references profiles(id) on delete set null,
  black_id uuid references profiles(id) on delete set null,
  white_name text,
  black_name text,
  pgn text not null,
  result text,
  result_reason text,
  time_control text,
  category text default 'blitz',
  variant text default 'standard',
  white_rating float,
  black_rating float,
  white_rating_change float,
  black_rating_change float,
  moves_count int default 0,
  created_at timestamptz default now(),
  started_at timestamptz default now(),
  ended_at timestamptz,
  is_rated boolean default true,
  status text default 'active'
);
-- For projects that already have the table, adjust the FK behavior
-- in place. Idempotent: drops the constraint if present, adds the
-- new one with the desired ON DELETE rule.
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'games_white_id_fkey') then
    alter table games drop constraint games_white_id_fkey;
  end if;
  if exists (select 1 from pg_constraint where conname = 'games_black_id_fkey') then
    alter table games drop constraint games_black_id_fkey;
  end if;
  alter table games add constraint games_white_id_fkey
    foreign key (white_id) references profiles(id) on delete set null;
  alter table games add constraint games_black_id_fkey
    foreign key (black_id) references profiles(id) on delete set null;
end $$;
-- Idempotent column adds for live state, draws, rematch, chat
alter table games add column if not exists created_at timestamptz default now();
alter table games add column if not exists white_time_ms int;
alter table games add column if not exists black_time_ms int;
alter table games add column if not exists last_move_at timestamptz;
alter table games add column if not exists turn text default 'w';
alter table games add column if not exists chat jsonb default '[]'::jsonb;
alter table games add column if not exists white_draw_offers int default 0;
alter table games add column if not exists black_draw_offers int default 0;
alter table games add column if not exists rematch_offered_by uuid references profiles(id) on delete set null;
alter table games add column if not exists rematch_game_id uuid references games(id) on delete set null;
-- Arena: each round of an AI Arena match gets persisted here as
-- a single row with variant='arena'. variant_rules captures the
-- rule diff used (so historical games can be replayed under the
-- same custom rules), and arena_room_id back-references the
-- room. is_rated gets set to false on insert so these rows are
-- excluded from Glicko-2 updates - variant rules break rating
-- math, see profile-history-only persistence in the orchestrator.
alter table games add column if not exists variant_rules jsonb;
alter table games add column if not exists arena_room_id uuid references arena_rooms(id) on delete set null;
alter table games add column if not exists arena_round text;

-- Backfill created_at from started_at for any rows that pre-date the column.
update games set created_at = started_at where created_at is null;

-- ── seeks (matchmaking queue) ──
create table if not exists seeks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  username text not null,
  rating float not null default 1500,
  time_control text not null,
  category text not null default 'blitz',
  variant text not null default 'standard',
  color_pref text default 'random',
  is_rated boolean default true,
  min_rating float,
  max_rating float,
  created_at timestamptz default now()
);
-- One active seek per user. Dedup any historical duplicates first.
delete from seeks where id not in (
  select distinct on (user_id) id from seeks order by user_id, created_at desc
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'seeks_one_per_user') then
    alter table seeks add constraint seeks_one_per_user unique (user_id);
  end if;
end $$;

-- ── challenges (1:1 game links) ──
create table if not exists challenges (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  creator_id uuid not null references profiles(id) on delete cascade,
  creator_name text not null,
  creator_rating float default 1500,
  time_control text not null default '10+0',
  color_pref text default 'random',
  variant text default 'standard',
  status text default 'waiting',
  game_id uuid references games(id),
  created_at timestamptz default now()
);

-- Backfill: in-place column add for projects that had the original
-- challenges shape before variants. Idempotent.
alter table challenges add column if not exists variant text default 'standard';

-- ── puzzle_progress ──
create table if not exists puzzle_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  puzzle_rating float not null default 1200,
  puzzle_rd float not null default 200,
  puzzles_solved int not null default 0,
  puzzles_failed int not null default 0,
  current_streak int not null default 0,
  best_streak int not null default 0,
  daily_puzzle_date text,
  daily_puzzle_solved boolean default false,
  updated_at timestamptz default now(),
  unique(user_id)
);
alter table puzzle_progress add column if not exists daily_puzzle_date text;
alter table puzzle_progress add column if not exists daily_puzzle_solved boolean default false;

-- ── puzzle_attempts ──
create table if not exists puzzle_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  puzzle_id text not null,
  puzzle_rating int,
  result text not null,
  time_spent_ms int,
  created_at timestamptz default now()
);

-- ── review_cards (Anki-style spaced repetition) ──
create table if not exists review_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  card_type text not null,
  fen text,
  pgn text,
  front_text text not null,
  back_text text,
  tags text[] default '{}',
  source_game_id uuid references games(id),
  source_puzzle_id text,
  ease_factor float not null default 2.5,
  interval_days int not null default 0,
  repetitions int not null default 0,
  lapses int not null default 0,
  next_review timestamptz default now(),
  last_review timestamptz,
  created_at timestamptz default now()
);

-- ── friendships (with bidirectional dedup) ──
create table if not exists friendships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  friend_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz default now()
);
-- Dedup historical bidirectional duplicates.
delete from friendships a using friendships b
where a.id > b.id
  and ((a.user_id = b.user_id and a.friend_id = b.friend_id)
    or (a.user_id = b.friend_id and a.friend_id = b.user_id));
-- Re-add same-direction unique constraint.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'friendships_user_id_friend_id_key') then
    alter table friendships add constraint friendships_user_id_friend_id_key unique (user_id, friend_id);
  end if;
end $$;
-- Bidirectional unique index via normalized pair key.
create or replace function normalize_friendship_pair(a uuid, b uuid)
returns text as $$
begin
  if a < b then return a::text || ':' || b::text;
  else return b::text || ':' || a::text; end if;
end;
$$ language plpgsql immutable;
drop index if exists idx_unique_friendship_pair;
create unique index idx_unique_friendship_pair
  on friendships (normalize_friendship_pair(user_id, friend_id));

-- ── coach_calls (AI rate-limit log) ──
-- Each successful call to the `coach` Edge Function inserts a row
-- here. The `record_coach_call` RPC reads recent rows to enforce a
-- per-user rolling-window cap before forwarding to Groq, so a
-- single user can't drain the whole LLM budget. RLS keeps the
-- table opaque to clients - only the SECURITY DEFINER RPC and the
-- service role can touch it.
create table if not exists coach_calls (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists idx_coach_calls_user_created
  on coach_calls(user_id, created_at desc);

-- ── arena_rules_calls (AI Arena rule-generation rate-limit log) ──
-- Each successful invocation of the `arena_rules` Edge Function
-- inserts a row here. A separate budget from coach_calls because
-- arena rule generation is more expensive (longer prompts +
-- more retries on validator failure) and we don't want a user
-- bursting on Anki AI to lock themselves out of arena rooms.
create table if not exists arena_rules_calls (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists idx_arena_rules_calls_user_created
  on arena_rules_calls(user_id, created_at desc);

-- ── ai_spend_log (global AI spending ledger) ──
-- Every successful AI call (arena_rules / coach modes) writes a
-- row here with the provider, feature, token counts, and a
-- micro-USD cost estimate. The `record_ai_spend_or_block` RPC
-- enforces a calendar-month hard cap by summing this table; once
-- the cap is hit, every subsequent call is blocked until the
-- next month. This is the ONE line of defense against runaway
-- costs - the per-key budget on Google AI Studio is NOT
-- configured separately, so this table is what stops a $5K
-- bill.
--
-- micro_usd is cost in millionths of a dollar so an int64
-- can hold years of spend without floating-point math.
create table if not exists ai_spend_log (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete set null,
  feature text not null,                    -- 'arena_rules' / 'coach_decks' / 'coach_explain'
  provider text not null default 'gemini',
  model text,
  input_tokens int,
  output_tokens int,
  micro_usd bigint not null,                -- estimated cost in 1/1,000,000 USD
  created_at timestamptz not null default now()
);
create index if not exists idx_ai_spend_log_created
  on ai_spend_log(created_at desc);
create index if not exists idx_ai_spend_log_user
  on ai_spend_log(user_id, created_at desc);

-- ── arena_rooms (AI Arena - prompt-driven variant chess) ──
-- Each room hosts a 2-player match where each side defines the
-- rules for one round (Round 1 = creator's rules, Round 2 =
-- joiner's rules, optional vanilla tie-break round). Phase 1
-- ships with a fixed catalog of rule modifiers; Phase 2 will
-- add the AI prompt -> rules pipeline.
--
-- Rules columns are jsonb because the rule object is a free-
-- shape diff document the engine resolves at runtime. Storing
-- it as text would lose query / index ergonomics and make rule
-- preview broken on the joining side.
create table if not exists arena_rooms (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references profiles(id) on delete cascade,
  joiner_id uuid references profiles(id) on delete set null,
  creator_name text,
  joiner_name text,
  rules_creator jsonb,        -- rule diff or full spec set by the creator
  rules_joiner jsonb,         -- rule diff or full spec set by the joiner
  status text not null default 'waiting_for_joiner',
  -- Lifecycle states the orchestrator transitions through:
  --   'waiting_for_joiner'  - creator just made the room
  --   'prompting'           - both joined, picking rules independently
  --   'warmup_round_1'      - 30s synchronized warmup vs random AI
  --   'round_1'             - 1v1 under creator's rules
  --   'warmup_round_2'      - 30s warmup with joiner's rules
  --   'round_2'             - 1v1 under joiner's rules
  --   'tiebreak'            - vanilla 1+0 sudden death (only if 1-1)
  --   'done'                - match complete, results in `match_result`
  --   'abandoned'           - one side bailed mid-flight
  match_result jsonb,         -- { winner: 'creator'|'joiner'|null, rounds: [...] }
  -- Round-state buffer the orchestrator updates as rounds
  -- progress. Shape: { round, fen, plyCount, captureTallyW,
  -- captureTallyB, lastMoveAt }. Persisting it lets a returning
  -- player rejoin mid-round without losing state.
  round_state jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Play-again linking: when one side clicks Play Again from the
-- match results screen, the new room's id gets written here so
-- the OTHER side's UI can navigate over without manually sharing
-- a fresh link.
alter table arena_rooms add column if not exists next_room_id uuid references arena_rooms(id) on delete set null;

-- ── arena_moves (move log per round) ──
-- Append-only ledger of every move played in a room, scoped by
-- round so the orchestrator can replay round 1 history when
-- showing the round-summary screen and so the realtime channel
-- only has to broadcast small deltas.
create table if not exists arena_moves (
  room_id uuid not null references arena_rooms(id) on delete cascade,
  round int not null,
  ply int not null,
  fen text not null,
  move_from text not null,
  move_to text not null,
  promotion text,
  san text,
  ts timestamptz default now(),
  primary key (room_id, round, ply)
);

-- ────────────────────────────────────────────────────────────────
-- INDEXES
-- ────────────────────────────────────────────────────────────────

create index if not exists idx_games_white on games(white_id);
create index if not exists idx_games_black on games(black_id);
create index if not exists idx_games_status on games(status);
create index if not exists idx_games_created on games(created_at desc);
create index if not exists idx_games_ended on games(ended_at desc);
create index if not exists idx_ratings_user on ratings(user_id);
create index if not exists idx_seeks_category on seeks(category, variant);
-- Composite for findMatch: filters by time_control + variant + a
-- rating window then orders by created_at. The leading columns line
-- up with the equality predicates so Postgres can range-scan.
create index if not exists idx_seeks_match on seeks(time_control, variant, created_at);
create index if not exists idx_seeks_created on seeks(created_at desc);
create index if not exists idx_review_next on review_cards(user_id, next_review);
create index if not exists idx_friendships_user on friendships(user_id, status);
create index if not exists idx_profiles_username on profiles(username);
create index if not exists idx_challenges_code on challenges(code);
create index if not exists idx_challenges_status on challenges(status);
create index if not exists idx_puzzle_attempts_user on puzzle_attempts(user_id);
create index if not exists idx_puzzle_attempts_puzzle on puzzle_attempts(puzzle_id);
create index if not exists idx_arena_rooms_creator on arena_rooms(creator_id);
create index if not exists idx_arena_rooms_joiner on arena_rooms(joiner_id);
create index if not exists idx_arena_rooms_status on arena_rooms(status);
create index if not exists idx_arena_rooms_updated on arena_rooms(updated_at desc);
create index if not exists idx_arena_moves_room on arena_moves(room_id, round, ply);

-- ────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ────────────────────────────────────────────────────────────────
-- Privacy is restored to per-owner / per-participant. The lax
-- "Anyone can read friendships / puzzle_progress" policies from the
-- legacy fix-friends-ratings.sql migration are explicitly NOT
-- recreated here.

alter table profiles enable row level security;
alter table ratings enable row level security;
alter table games enable row level security;
alter table seeks enable row level security;
alter table challenges enable row level security;
alter table puzzle_progress enable row level security;
alter table puzzle_attempts enable row level security;
alter table review_cards enable row level security;
alter table friendships enable row level security;
-- coach_calls deliberately gets no policies. The only allowed
-- access path is the SECURITY DEFINER `record_coach_call` RPC,
-- which checks auth.uid() internally before writing. RLS-on +
-- no-policies = nobody reads/writes directly with the anon key.
alter table coach_calls enable row level security;
-- arena_rules_calls follows the same lock-down pattern - only
-- record_arena_rules_call (security definer) may touch it.
alter table arena_rules_calls enable row level security;
-- ai_spend_log: same lock-down. Only record_ai_spend_or_block
-- (security definer) may insert; reads are restricted to the
-- service role for ad-hoc admin queries via the dashboard.
alter table ai_spend_log enable row level security;
alter table arena_rooms enable row level security;
alter table arena_moves enable row level security;

-- ── profiles ──
drop policy if exists "Public profiles are viewable by everyone" on profiles;
drop policy if exists "Users can insert own profile" on profiles;
drop policy if exists "Users can update own profile" on profiles;
create policy "Public profiles are viewable by everyone" on profiles
  for select using (true);
create policy "Users can insert own profile" on profiles
  for insert with check (auth.uid() = id);
create policy "Users can update own profile" on profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- ── ratings ──
drop policy if exists "Ratings are viewable by everyone" on ratings;
drop policy if exists "System updates ratings" on ratings;
drop policy if exists "Users can read all ratings" on ratings;
drop policy if exists "Users can update own ratings" on ratings;
drop policy if exists "Users can insert own ratings" on ratings;
create policy "Ratings are viewable by everyone" on ratings
  for select using (true);
create policy "Users can insert own ratings" on ratings
  for insert with check (auth.uid() = user_id);
create policy "Users can update own ratings" on ratings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── games ──
drop policy if exists "Completed games are viewable by everyone" on games;
drop policy if exists "Anyone can view completed games" on games;
drop policy if exists "Players can view their active games" on games;
drop policy if exists "Players can view own games" on games;
drop policy if exists "Players can update their active games" on games;
drop policy if exists "Players can update own games" on games;
drop policy if exists "Players can update own active games" on games;
drop policy if exists "Authenticated users can create games" on games;
drop policy if exists "Auth users can create games" on games;
drop policy if exists "Players can create own games" on games;
create policy "Anyone can view completed games" on games
  for select using (status = 'completed');
create policy "Players can view own games" on games
  for select using (auth.uid() in (white_id, black_id));
-- Direct inserts are restricted to participants. RPCs (claim_seek /
-- accept_challenge) run as security definer and bypass this for the
-- two-player games they create.
create policy "Players can create own games" on games
  for insert with check (auth.uid() in (white_id, black_id));
-- Updates only on active rows, only by participants. After a row
-- transitions to status='completed' it becomes immutable to clients;
-- glicko2_update is the only path to that final write (security definer).
-- WITH CHECK enforces that the row is *still* active after the update
-- so a client cannot transition status='active' -> 'completed' (and
-- forge result / pgn / rating fields) while bypassing glicko2_update.
create policy "Players can update own active games" on games
  for update using (
    auth.uid() in (white_id, black_id) and status = 'active'
  ) with check (
    auth.uid() in (white_id, black_id) and status = 'active'
  );

-- ── seeks ──
drop policy if exists "Anyone can view seeks" on seeks;
drop policy if exists "Seeks are viewable by authenticated" on seeks;
drop policy if exists "Auth users can view seeks" on seeks;
drop policy if exists "Users can create seeks" on seeks;
drop policy if exists "Auth users can create seeks" on seeks;
drop policy if exists "Auth users can create own seeks" on seeks;
drop policy if exists "Users can delete own seeks" on seeks;
drop policy if exists "Auth users can delete own seeks" on seeks;
drop policy if exists "Auth users can delete matched seeks" on seeks;
create policy "Auth users can view seeks" on seeks
  for select using (auth.role() = 'authenticated');
create policy "Auth users can create own seeks" on seeks
  for insert with check (auth.uid() = user_id);
create policy "Auth users can delete own seeks" on seeks
  for delete using (auth.uid() = user_id);

-- ── challenges ──
drop policy if exists "Anyone can view challenges" on challenges;
drop policy if exists "Auth users can create challenges" on challenges;
drop policy if exists "Auth users can create own challenges" on challenges;
drop policy if exists "Auth users can update challenges" on challenges;
drop policy if exists "Auth users can update own or accept challenges" on challenges;
drop policy if exists "Creator can update own challenge" on challenges;
drop policy if exists "Auth users can mark expired challenges" on challenges;
drop policy if exists "Creator can delete challenges" on challenges;
drop policy if exists "Creator can delete own challenge" on challenges;
create policy "Anyone can view challenges" on challenges
  for select using (true);
create policy "Auth users can create own challenges" on challenges
  for insert with check (auth.uid() = creator_id);
-- Two narrow update paths are allowed directly to clients:
--   1. The creator can update their own challenge (e.g. cancel).
--   2. Any authenticated user may flip a stale "waiting" row to
--      "expired" — needed because non-creator viewers detect expiry
--      client-side and would otherwise leave dangling rows in the DB.
-- Acceptance is funneled through accept_challenge() (security definer),
-- which bypasses RLS, so we do NOT need a "status='waiting'" path here.
create policy "Creator can update own challenge" on challenges
  for update using (auth.uid() = creator_id) with check (auth.uid() = creator_id);
create policy "Auth users can mark expired challenges" on challenges
  for update using (
    auth.role() = 'authenticated' and status = 'waiting'
  ) with check (
    status = 'expired'
  );
create policy "Creator can delete own challenge" on challenges
  for delete using (auth.uid() = creator_id);

-- ── puzzle_progress ──
drop policy if exists "Puzzle progress viewable by owner" on puzzle_progress;
drop policy if exists "Users manage own puzzle progress" on puzzle_progress;
drop policy if exists "Anyone can read puzzle progress" on puzzle_progress;
drop policy if exists "Users can read own puzzle progress" on puzzle_progress;
drop policy if exists "Users can update own puzzle progress" on puzzle_progress;
drop policy if exists "Users can insert own puzzle progress" on puzzle_progress;
create policy "Users can read own puzzle progress" on puzzle_progress
  for select using (auth.uid() = user_id);
create policy "Users can insert own puzzle progress" on puzzle_progress
  for insert with check (auth.uid() = user_id);
create policy "Users can update own puzzle progress" on puzzle_progress
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── puzzle_attempts ──
drop policy if exists "Users can read own attempts" on puzzle_attempts;
drop policy if exists "Anyone can read attempts" on puzzle_attempts;
drop policy if exists "Auth users can insert attempts" on puzzle_attempts;
drop policy if exists "Users can insert own attempts" on puzzle_attempts;
create policy "Users can read own attempts" on puzzle_attempts
  for select using (auth.uid() = user_id);
-- Critical: bind user_id to auth.uid() so authenticated clients
-- cannot forge attempts on behalf of other users.
create policy "Users can insert own attempts" on puzzle_attempts
  for insert with check (auth.uid() = user_id);

-- ── review_cards ──
drop policy if exists "Users manage own review cards" on review_cards;
create policy "Users manage own review cards" on review_cards
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── friendships ──
drop policy if exists "Users can see own friendships" on friendships;
drop policy if exists "Anyone can read friendships" on friendships;
drop policy if exists "Users can create friend requests" on friendships;
drop policy if exists "Users can update friendships involving them" on friendships;
drop policy if exists "Users can delete own friendships" on friendships;
create policy "Users can see own friendships" on friendships
  for select using (auth.uid() in (user_id, friend_id));
create policy "Users can create friend requests" on friendships
  for insert with check (auth.uid() = user_id);
create policy "Users can update friendships involving them" on friendships
  for update using (auth.uid() in (user_id, friend_id)) with check (auth.uid() in (user_id, friend_id));
create policy "Users can delete own friendships" on friendships
  for delete using (auth.uid() in (user_id, friend_id));

-- ── arena_rooms ──
-- Read access is open by room id (the share-link-only access
-- model means knowing the URL = entitled to read), but writes
-- are tightly scoped: only the creator can insert; only
-- creator or current joiner can update; only the creator can
-- delete. The status / round_state mutations the orchestrator
-- needs ride on top of these update policies + an auth.uid()
-- check inside each row so a stranger can't hijack the room
-- by guessing the URL.
drop policy if exists "Anyone can read arena rooms by id" on arena_rooms;
drop policy if exists "Auth users can create own arena rooms" on arena_rooms;
drop policy if exists "Participants can update arena rooms" on arena_rooms;
drop policy if exists "Auth users can join unfilled arena rooms" on arena_rooms;
drop policy if exists "Creator can delete own arena rooms" on arena_rooms;
create policy "Anyone can read arena rooms by id" on arena_rooms
  for select using (true);
create policy "Auth users can create own arena rooms" on arena_rooms
  for insert with check (auth.uid() = creator_id);
-- Joiners need a way to claim the room (write joiner_id +
-- joiner_name) when the seat is open AND they aren't the
-- creator. Once joined, this UPDATE permission is what lets
-- the orchestrator advance status / round_state from either
-- side; the policy lets either current participant update
-- the row.
create policy "Auth users can join unfilled arena rooms" on arena_rooms
  for update using (
    auth.role() = 'authenticated'
      and joiner_id is null
      and creator_id <> auth.uid()
  ) with check (
    -- The joiner stamp must belong to the caller; the creator
    -- must not change.
    joiner_id = auth.uid()
  );
create policy "Participants can update arena rooms" on arena_rooms
  for update using (
    auth.uid() in (creator_id, joiner_id)
  ) with check (
    auth.uid() in (creator_id, joiner_id)
  );
create policy "Creator can delete own arena rooms" on arena_rooms
  for delete using (auth.uid() = creator_id);

-- ── arena_moves ──
-- Move log mirrors the room's read policy (open read so
-- spectators / replays work) but only allows participants of
-- the parent room to insert. UPDATE / DELETE are not exposed
-- to clients - moves are append-only.
drop policy if exists "Anyone can read arena moves" on arena_moves;
drop policy if exists "Participants can append arena moves" on arena_moves;
create policy "Anyone can read arena moves" on arena_moves
  for select using (true);
create policy "Participants can append arena moves" on arena_moves
  for insert with check (
    exists (
      select 1 from arena_rooms r
      where r.id = arena_moves.room_id
        and auth.uid() in (r.creator_id, r.joiner_id)
    )
  );

-- ────────────────────────────────────────────────────────────────
-- TRIGGERS
-- ────────────────────────────────────────────────────────────────

-- Bidirectional friendship dedup: reject inserts whose reverse pair
-- already exists. Pairs with the same direction are already covered
-- by the friendships_user_id_friend_id_key UNIQUE constraint.
create or replace function normalize_friend_pair()
returns trigger as $$
begin
  if exists (select 1 from friendships where user_id = new.friend_id and friend_id = new.user_id) then
    raise exception 'Friendship already exists' using errcode = '23505';
  end if;
  return new;
end;
$$ language plpgsql;
drop trigger if exists check_duplicate_friendship on friendships;
create trigger check_duplicate_friendship
  before insert on friendships
  for each row execute function normalize_friend_pair();

-- New-user provisioning: creates a profile, default ratings, and a
-- puzzle_progress row. Wrapped in exception handler so signup never
-- fails on a bad auth row.
create or replace function handle_new_user()
returns trigger as $$
declare
  _username text;
begin
  _username := coalesce(
    new.raw_user_meta_data->>'username',
    new.raw_user_meta_data->>'preferred_username',
    split_part(coalesce(new.email, ''), '@', 1),
    'player'
  ) || '_' || substr(md5(new.id::text), 1, 6);

  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    _username,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(coalesce(new.email, ''), '@', 1), 'Player'),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;

  insert into public.ratings (user_id, category) values
    (new.id, 'bullet'), (new.id, 'blitz'), (new.id, 'rapid'), (new.id, 'classical')
  on conflict (user_id, category) do nothing;

  insert into public.puzzle_progress (user_id) values (new.id)
  on conflict (user_id) do nothing;

  return new;
exception when others then
  raise warning 'handle_new_user failed for %: %', new.id, sqlerrm;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ────────────────────────────────────────────────────────────────
-- RPCs
-- All security-definer RPCs that take a user-id parameter MUST
-- assert that parameter equals auth.uid(). Without this any
-- authenticated client can post a crafted JSON-RPC body and forge
-- actions on behalf of other users.
-- ────────────────────────────────────────────────────────────────

-- ── claim_seek: atomically claim an open seek and create a game ──
create or replace function claim_seek(
  p_seek_id uuid,
  p_claimer_id uuid,
  p_claimer_name text,
  p_claimer_rating float
)
returns jsonb as $$
declare
  v_seek record;
  v_game_id uuid;
  v_white_id uuid; v_black_id uuid;
  v_white_name text; v_black_name text;
  v_white_rating float; v_black_rating float;
  v_flip boolean;
begin
  if auth.uid() is null or auth.uid() <> p_claimer_id then
    return jsonb_build_object('error', 'Not authenticated');
  end if;

  -- A claimer joining a game can no longer hold a seek of their own.
  delete from seeks where user_id = p_claimer_id;

  delete from seeks where id = p_seek_id returning * into v_seek;
  if v_seek is null then
    return jsonb_build_object('error', 'Seek no longer available');
  end if;
  if v_seek.user_id = p_claimer_id then
    return jsonb_build_object('error', 'Cannot claim your own seek');
  end if;

  v_flip := random() < 0.5;
  if v_seek.color_pref = 'white' then
    v_white_id := v_seek.user_id; v_black_id := p_claimer_id;
    v_white_name := v_seek.username; v_black_name := p_claimer_name;
    v_white_rating := v_seek.rating; v_black_rating := p_claimer_rating;
  elsif v_seek.color_pref = 'black' then
    v_white_id := p_claimer_id; v_black_id := v_seek.user_id;
    v_white_name := p_claimer_name; v_black_name := v_seek.username;
    v_white_rating := p_claimer_rating; v_black_rating := v_seek.rating;
  elsif v_flip then
    v_white_id := v_seek.user_id; v_black_id := p_claimer_id;
    v_white_name := v_seek.username; v_black_name := p_claimer_name;
    v_white_rating := v_seek.rating; v_black_rating := p_claimer_rating;
  else
    v_white_id := p_claimer_id; v_black_id := v_seek.user_id;
    v_white_name := p_claimer_name; v_black_name := v_seek.username;
    v_white_rating := p_claimer_rating; v_black_rating := v_seek.rating;
  end if;

  insert into games (white_id, black_id, white_name, black_name, white_rating, black_rating,
                     pgn, time_control, category, variant, is_rated, status)
  values (v_white_id, v_black_id, v_white_name, v_black_name, v_white_rating, v_black_rating,
          '', v_seek.time_control, v_seek.category, v_seek.variant, v_seek.is_rated, 'active')
  returning id into v_game_id;

  return (select row_to_json(g)::jsonb from games g where g.id = v_game_id);
end;
$$ language plpgsql security definer;
grant execute on function claim_seek(uuid, uuid, text, float) to authenticated;

-- ── accept_challenge: atomically accept a challenge link ──
create or replace function accept_challenge(
  p_challenge_id uuid,
  p_joiner_id uuid,
  p_joiner_name text,
  p_joiner_rating float
)
returns jsonb as $$
declare
  v_challenge record;
  v_game_id uuid;
  v_white_id uuid; v_black_id uuid;
  v_white_name text; v_black_name text;
  v_white_rating float; v_black_rating float;
  v_flip boolean;
  v_category text;
  v_base int; v_inc int; v_total int;
begin
  if auth.uid() is null or auth.uid() <> p_joiner_id then
    return jsonb_build_object('error', 'Not authenticated');
  end if;

  select * into v_challenge
  from challenges
  where id = p_challenge_id and status = 'waiting'
  for update skip locked;

  if v_challenge is null then
    return jsonb_build_object('error', 'Challenge not found, already accepted, or expired');
  end if;
  if v_challenge.creator_id = p_joiner_id then
    return jsonb_build_object('error', 'Cannot accept your own challenge');
  end if;

  v_flip := random() < 0.5;
  if v_challenge.color_pref = 'white' then
    v_white_id := v_challenge.creator_id; v_black_id := p_joiner_id;
    v_white_name := v_challenge.creator_name; v_black_name := p_joiner_name;
    v_white_rating := v_challenge.creator_rating; v_black_rating := p_joiner_rating;
  elsif v_challenge.color_pref = 'black' then
    v_white_id := p_joiner_id; v_black_id := v_challenge.creator_id;
    v_white_name := p_joiner_name; v_black_name := v_challenge.creator_name;
    v_white_rating := p_joiner_rating; v_black_rating := v_challenge.creator_rating;
  elsif v_flip then
    v_white_id := v_challenge.creator_id; v_black_id := p_joiner_id;
    v_white_name := v_challenge.creator_name; v_black_name := p_joiner_name;
    v_white_rating := v_challenge.creator_rating; v_black_rating := p_joiner_rating;
  else
    v_white_id := p_joiner_id; v_black_id := v_challenge.creator_id;
    v_white_name := p_joiner_name; v_black_name := v_challenge.creator_name;
    v_white_rating := p_joiner_rating; v_black_rating := v_challenge.creator_rating;
  end if;

  v_category := 'blitz';
  if v_challenge.time_control ~ '^\d+\+\d+$' then
    v_base := split_part(v_challenge.time_control, '+', 1)::int;
    v_inc := split_part(v_challenge.time_control, '+', 2)::int;
    v_total := v_base * 60 + v_inc * 40;
    if v_total < 180 then v_category := 'bullet';
    elsif v_total < 480 then v_category := 'blitz';
    elsif v_total < 1500 then v_category := 'rapid';
    else v_category := 'classical';
    end if;
  end if;

  insert into games (white_id, black_id, white_name, black_name, white_rating, black_rating,
                     pgn, time_control, category, variant, is_rated, status)
  values (v_white_id, v_black_id, v_white_name, v_black_name, v_white_rating, v_black_rating,
          '', v_challenge.time_control, v_category, coalesce(v_challenge.variant, 'standard'), false, 'active')
  returning id into v_game_id;

  update challenges set status = 'accepted', game_id = v_game_id where id = p_challenge_id;

  return (select row_to_json(g)::jsonb from games g where g.id = v_game_id);
end;
$$ language plpgsql security definer;
grant execute on function accept_challenge(uuid, uuid, text, float) to authenticated;

-- ── glicko2_update: server-authoritative game completion ──
create or replace function glicko2_update(
  p_game_id uuid,
  p_result text,
  p_result_reason text,
  p_pgn text,
  p_moves_count int
)
returns jsonb as $$
declare
  v_game record;
  v_cat text;
  v_w_row record; v_b_row record;
  v_w_score float; v_b_score float;
  c_tau float := 0.5;
  c_epsilon float := 0.000001;
  c_scale float := 173.7178;
  v_mu float; v_phi float; v_sigma float;
  v_opp_mu float; v_opp_phi float;
  v_g float; v_e float; v_v float; v_delta float;
  v_a float; v_b float; v_fa float; v_fb float; v_fc float; v_c float;
  v_k int;
  v_new_sigma float; v_phi_star float; v_new_phi float; v_new_mu float;
  v_new_rating float; v_new_rd float;
  v_change float;
  v_outcome text;
begin
  select * into v_game from games where id = p_game_id for update;
  if v_game is null then
    return jsonb_build_object('error', 'Game not found');
  end if;
  if auth.uid() is null or auth.uid() not in (v_game.white_id, v_game.black_id) then
    return jsonb_build_object('error', 'Not a participant');
  end if;
  if v_game.status = 'completed' then
    return jsonb_build_object('ok', true, 'already_completed', true);
  end if;

  update games set
    pgn = p_pgn,
    result = p_result,
    result_reason = p_result_reason,
    moves_count = p_moves_count,
    status = 'completed',
    ended_at = now()
  where id = p_game_id;

  if p_result = '*' or not coalesce(v_game.is_rated, false) then
    return jsonb_build_object('ok', true);
  end if;

  v_cat := coalesce(v_game.category, 'blitz');

  if p_result = '1-0' then v_w_score := 1.0; v_b_score := 0.0;
  elsif p_result = '0-1' then v_w_score := 0.0; v_b_score := 1.0;
  else v_w_score := 0.5; v_b_score := 0.5;
  end if;

  select * into v_w_row from ratings where user_id = v_game.white_id and category = v_cat;
  select * into v_b_row from ratings where user_id = v_game.black_id and category = v_cat;
  if v_w_row is null or v_b_row is null then
    return jsonb_build_object('ok', true, 'ratings_skipped', true);
  end if;

  -- ── White update ──
  v_mu := (v_w_row.rating - 1500) / c_scale;
  v_phi := v_w_row.rd / c_scale;
  v_sigma := v_w_row.volatility;
  v_opp_mu := (v_b_row.rating - 1500) / c_scale;
  v_opp_phi := v_b_row.rd / c_scale;
  v_g := 1.0 / sqrt(1.0 + 3.0 * v_opp_phi * v_opp_phi / (pi() * pi()));
  v_e := 1.0 / (1.0 + exp(-v_g * (v_mu - v_opp_mu)));
  v_v := 1.0 / (v_g * v_g * v_e * (1.0 - v_e));
  v_delta := v_v * v_g * (v_w_score - v_e);
  v_a := ln(v_sigma * v_sigma);
  if v_delta * v_delta > v_phi * v_phi + v_v then
    v_b := ln(v_delta * v_delta - v_phi * v_phi - v_v);
  else
    v_k := 1;
    loop
      exit when (
        (exp(v_a - v_k * c_tau) * (v_delta * v_delta - v_phi * v_phi - v_v - exp(v_a - v_k * c_tau)))
        / (2.0 * (v_phi * v_phi + v_v + exp(v_a - v_k * c_tau)) * (v_phi * v_phi + v_v + exp(v_a - v_k * c_tau)))
        - (v_a - v_k * c_tau - v_a) / (c_tau * c_tau)
      ) >= 0 or v_k > 100;
      v_k := v_k + 1;
    end loop;
    v_b := v_a - v_k * c_tau;
  end if;
  v_fa := (exp(v_a) * (v_delta*v_delta - v_phi*v_phi - v_v - exp(v_a))) / (2.0*(v_phi*v_phi + v_v + exp(v_a))*(v_phi*v_phi + v_v + exp(v_a))) - (v_a - v_a)/(c_tau*c_tau);
  v_fb := (exp(v_b) * (v_delta*v_delta - v_phi*v_phi - v_v - exp(v_b))) / (2.0*(v_phi*v_phi + v_v + exp(v_b))*(v_phi*v_phi + v_v + exp(v_b))) - (v_b - v_a)/(c_tau*c_tau);
  for i in 1..100 loop
    exit when abs(v_b - v_a) < c_epsilon;
    v_c := v_a + (v_a - v_b) * v_fa / (v_fb - v_fa);
    v_fc := (exp(v_c) * (v_delta*v_delta - v_phi*v_phi - v_v - exp(v_c))) / (2.0*(v_phi*v_phi + v_v + exp(v_c))*(v_phi*v_phi + v_v + exp(v_c))) - (v_c - v_a)/(c_tau*c_tau);
    if v_fc * v_fb <= 0 then v_a := v_b; v_fa := v_fb;
    else v_fa := v_fa / 2.0; end if;
    v_b := v_c; v_fb := v_fc;
  end loop;
  v_new_sigma := exp(v_b / 2.0);
  v_phi_star := sqrt(v_phi * v_phi + v_new_sigma * v_new_sigma);
  v_new_phi := 1.0 / sqrt(1.0 / (v_phi_star * v_phi_star) + 1.0 / v_v);
  v_new_mu := v_mu + v_new_phi * v_new_phi * v_g * (v_w_score - v_e);
  v_new_rating := round((v_new_mu * c_scale + 1500)::numeric, 1);
  v_new_rd := round((v_new_phi * c_scale)::numeric, 1);
  v_change := round((v_new_rating - v_w_row.rating)::numeric, 1);
  v_outcome := case when v_w_score = 1.0 then 'wins' when v_w_score = 0.0 then 'losses' else 'draws' end;
  execute format(
    'update ratings set rating = $1, rd = $2, volatility = $3, games_played = games_played + 1, %I = %I + 1, updated_at = now() where id = $4',
    v_outcome, v_outcome
  ) using v_new_rating, v_new_rd, round(v_new_sigma::numeric, 6), v_w_row.id;
  update games set white_rating_change = v_change where id = p_game_id;

  -- ── Black update ──
  v_mu := (v_b_row.rating - 1500) / c_scale;
  v_phi := v_b_row.rd / c_scale;
  v_sigma := v_b_row.volatility;
  v_opp_mu := (v_w_row.rating - 1500) / c_scale;
  v_opp_phi := v_w_row.rd / c_scale;
  v_g := 1.0 / sqrt(1.0 + 3.0 * v_opp_phi * v_opp_phi / (pi() * pi()));
  v_e := 1.0 / (1.0 + exp(-v_g * (v_mu - v_opp_mu)));
  v_v := 1.0 / (v_g * v_g * v_e * (1.0 - v_e));
  v_delta := v_v * v_g * (v_b_score - v_e);
  v_a := ln(v_sigma * v_sigma);
  if v_delta * v_delta > v_phi * v_phi + v_v then
    v_b := ln(v_delta * v_delta - v_phi * v_phi - v_v);
  else
    v_k := 1;
    loop
      exit when (
        (exp(v_a - v_k * c_tau) * (v_delta * v_delta - v_phi * v_phi - v_v - exp(v_a - v_k * c_tau)))
        / (2.0 * (v_phi * v_phi + v_v + exp(v_a - v_k * c_tau)) * (v_phi * v_phi + v_v + exp(v_a - v_k * c_tau)))
        - (v_a - v_k * c_tau - v_a) / (c_tau * c_tau)
      ) >= 0 or v_k > 100;
      v_k := v_k + 1;
    end loop;
    v_b := v_a - v_k * c_tau;
  end if;
  v_fa := (exp(v_a) * (v_delta*v_delta - v_phi*v_phi - v_v - exp(v_a))) / (2.0*(v_phi*v_phi + v_v + exp(v_a))*(v_phi*v_phi + v_v + exp(v_a))) - (v_a - v_a)/(c_tau*c_tau);
  v_fb := (exp(v_b) * (v_delta*v_delta - v_phi*v_phi - v_v - exp(v_b))) / (2.0*(v_phi*v_phi + v_v + exp(v_b))*(v_phi*v_phi + v_v + exp(v_b))) - (v_b - v_a)/(c_tau*c_tau);
  for i in 1..100 loop
    exit when abs(v_b - v_a) < c_epsilon;
    v_c := v_a + (v_a - v_b) * v_fa / (v_fb - v_fa);
    v_fc := (exp(v_c) * (v_delta*v_delta - v_phi*v_phi - v_v - exp(v_c))) / (2.0*(v_phi*v_phi + v_v + exp(v_c))*(v_phi*v_phi + v_v + exp(v_c))) - (v_c - v_a)/(c_tau*c_tau);
    if v_fc * v_fb <= 0 then v_a := v_b; v_fa := v_fb;
    else v_fa := v_fa / 2.0; end if;
    v_b := v_c; v_fb := v_fc;
  end loop;
  v_new_sigma := exp(v_b / 2.0);
  v_phi_star := sqrt(v_phi * v_phi + v_new_sigma * v_new_sigma);
  v_new_phi := 1.0 / sqrt(1.0 / (v_phi_star * v_phi_star) + 1.0 / v_v);
  v_new_mu := v_mu + v_new_phi * v_new_phi * v_g * (v_b_score - v_e);
  v_new_rating := round((v_new_mu * c_scale + 1500)::numeric, 1);
  v_new_rd := round((v_new_phi * c_scale)::numeric, 1);
  v_change := round((v_new_rating - v_b_row.rating)::numeric, 1);
  v_outcome := case when v_b_score = 1.0 then 'wins' when v_b_score = 0.0 then 'losses' else 'draws' end;
  execute format(
    'update ratings set rating = $1, rd = $2, volatility = $3, games_played = games_played + 1, %I = %I + 1, updated_at = now() where id = $4',
    v_outcome, v_outcome
  ) using v_new_rating, v_new_rd, round(v_new_sigma::numeric, 6), v_b_row.id;
  update games set black_rating_change = v_change where id = p_game_id;

  return jsonb_build_object('ok', true);
end;
$$ language plpgsql security definer;
grant execute on function glicko2_update(uuid, text, text, text, int) to authenticated;

-- ── create_rematch: atomic rematch creation ──
-- Two clients hitting Accept at once would otherwise produce two new
-- `games` rows. This RPC locks the source row, returns an existing
-- rematch if `rematch_game_id` is already set, and otherwise inserts
-- a single new row + stamps the link in one transaction.
create or replace function create_rematch(
  p_source_game_id uuid,
  p_user_id uuid
)
returns jsonb as $$
declare
  v_source record;
  v_existing_id uuid;
  v_new_id uuid;
  v_new_white_id uuid; v_new_black_id uuid;
  v_new_white_name text; v_new_black_name text;
  v_new_white_rating float; v_new_black_rating float;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    return jsonb_build_object('error', 'Not authenticated');
  end if;

  select * into v_source from games where id = p_source_game_id for update;
  if v_source is null then
    return jsonb_build_object('error', 'Source game not found');
  end if;
  if auth.uid() not in (v_source.white_id, v_source.black_id) then
    return jsonb_build_object('error', 'Not a participant');
  end if;

  -- Already linked — both clients converge to the same row.
  if v_source.rematch_game_id is not null then
    return (select row_to_json(g)::jsonb from games g where g.id = v_source.rematch_game_id);
  end if;

  -- Swap colors so the player who was Black plays White next, etc.
  v_new_white_id := v_source.black_id;
  v_new_black_id := v_source.white_id;
  v_new_white_name := v_source.black_name;
  v_new_black_name := v_source.white_name;
  v_new_white_rating := v_source.black_rating;
  v_new_black_rating := v_source.white_rating;

  insert into games (
    white_id, black_id, white_name, black_name, white_rating, black_rating,
    pgn, time_control, category, variant, is_rated, status
  ) values (
    v_new_white_id, v_new_black_id, v_new_white_name, v_new_black_name,
    v_new_white_rating, v_new_black_rating,
    '', v_source.time_control, coalesce(v_source.category, 'blitz'),
    coalesce(v_source.variant, 'standard'), coalesce(v_source.is_rated, false),
    'active'
  ) returning id into v_new_id;

  update games set rematch_game_id = v_new_id where id = p_source_game_id;

  return (select row_to_json(g)::jsonb from games g where g.id = v_new_id);
end;
$$ language plpgsql security definer;
grant execute on function create_rematch(uuid, uuid) to authenticated;

-- ── record_coach_call: per-user rolling-window rate limit ──
-- Counts the user's recent successful coach calls; if they're under
-- the cap, inserts a fresh row and returns allowed=true. If over,
-- returns allowed=false plus the seconds until the oldest in-window
-- call falls off (so the client can render an exact countdown).
--
-- Defaults to 3 calls per 300 s (5 min). Clients can request a
-- tighter cap via parameters but cannot loosen it - the Edge
-- Function is the only authorized caller and pins the limits in code.
--
-- SECURITY DEFINER + auth.uid() check: the table itself is locked
-- behind RLS-no-policies, so this RPC is the only sanctioned
-- read/write path.
create or replace function record_coach_call(
  p_window_seconds int default 300,
  p_max_calls int default 3
)
returns table (
  allowed boolean,
  retry_after_seconds int,
  calls_in_window int,
  window_seconds int,
  max_calls int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_count int;
  v_oldest timestamptz;
  v_retry int;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return query select false, p_window_seconds, 0, p_window_seconds, p_max_calls;
    return;
  end if;

  -- Trim very old rows so the table doesn't grow unboundedly. Anything
  -- older than 1 day is irrelevant for any reasonable window.
  delete from coach_calls where created_at < now() - interval '1 day';

  -- Count + find the oldest call inside the current window.
  select count(*), min(created_at)
    into v_count, v_oldest
    from coach_calls
   where user_id = v_uid
     and created_at > now() - (p_window_seconds || ' seconds')::interval;

  if v_count >= p_max_calls then
    -- Time until the oldest in-window call ages out. ceil so a
    -- sub-second remainder still surfaces as 1 second to the user.
    v_retry := greatest(1, ceil(extract(epoch from
      (v_oldest + (p_window_seconds || ' seconds')::interval - now())))::int);
    return query select false, v_retry, v_count, p_window_seconds, p_max_calls;
    return;
  end if;

  insert into coach_calls(user_id) values (v_uid);
  return query select true, 0, v_count + 1, p_window_seconds, p_max_calls;
end;
$$;
revoke all on function record_coach_call(int, int) from public, anon;
grant execute on function record_coach_call(int, int) to authenticated, service_role;

-- ── record_arena_rules_call: rate limit for AI Arena rule generation ──
-- Same shape as record_coach_call but a separate table so arena
-- and coach budgets don't share. Defaults: 3 calls per 600 s
-- (10 min). The Edge Function is the only sanctioned caller.
create or replace function record_arena_rules_call(
  p_window_seconds int default 600,
  p_max_calls int default 3
)
returns table (
  allowed boolean,
  retry_after_seconds int,
  calls_in_window int,
  window_seconds int,
  max_calls int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_count int;
  v_oldest timestamptz;
  v_retry int;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return query select false, p_window_seconds, 0, p_window_seconds, p_max_calls;
    return;
  end if;

  -- Trim very old rows so the table doesn't grow unboundedly.
  delete from arena_rules_calls where created_at < now() - interval '1 day';

  select count(*), min(created_at)
    into v_count, v_oldest
    from arena_rules_calls
   where user_id = v_uid
     and created_at > now() - (p_window_seconds || ' seconds')::interval;

  if v_count >= p_max_calls then
    v_retry := greatest(1, ceil(extract(epoch from
      (v_oldest + (p_window_seconds || ' seconds')::interval - now())))::int);
    return query select false, v_retry, v_count, p_window_seconds, p_max_calls;
    return;
  end if;

  insert into arena_rules_calls(user_id) values (v_uid);
  return query select true, 0, v_count + 1, p_window_seconds, p_max_calls;
end;
$$;
revoke all on function record_arena_rules_call(int, int) from public, anon;
grant execute on function record_arena_rules_call(int, int) to authenticated, service_role;

-- ── record_ai_spend_or_block: monthly $-cap enforcement ──
-- Every AI Edge Function calls this AFTER its own per-user
-- rate limit, with the cost it's ABOUT to incur (estimated
-- from prompt length pre-call) or just incurred (post-call,
-- with actual token counts). Strategy:
--
--   1. Sum current calendar-month spend (in micro-USD).
--   2. If sum + this call's cost > monthly_cap, return
--      allowed=false. Caller must NOT make the API call.
--   3. Otherwise, insert the row and return allowed=true.
--
-- Pre-call usage: pass a conservative ESTIMATE; if denied, the
-- function returns the cap-exceeded error to the client.
-- Post-call usage: pass the ACTUAL cost; this is informational
-- only because the call already happened, but it keeps the
-- ledger accurate.
--
-- Cap is configurable via parameter so tests can set a tiny
-- cap; production callers always pass the constant defined on
-- the Edge Function side. Defaults to 50 USD = 50_000_000
-- micro-USD per calendar month.
create or replace function record_ai_spend_or_block(
  p_feature text,
  p_provider text,
  p_model text,
  p_input_tokens int,
  p_output_tokens int,
  p_micro_usd bigint,
  p_monthly_cap_micro_usd bigint default 50000000
)
returns table (
  allowed boolean,
  used_micro_usd bigint,
  cap_micro_usd bigint,
  remaining_micro_usd bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_used bigint;
  v_remaining bigint;
begin
  -- We accept anonymous calls (e.g. an Edge Function with
  -- just the service role) but tag user_id when present.
  v_uid := auth.uid();

  -- Sum spend in the current calendar month UTC.
  select coalesce(sum(micro_usd), 0)
    into v_used
    from ai_spend_log
   where created_at >= date_trunc('month', now() at time zone 'UTC');

  v_remaining := p_monthly_cap_micro_usd - v_used;

  -- Reject if this call would push over the cap.
  if v_used + p_micro_usd > p_monthly_cap_micro_usd then
    return query select false, v_used, p_monthly_cap_micro_usd, greatest(0::bigint, v_remaining);
    return;
  end if;

  insert into ai_spend_log(user_id, feature, provider, model, input_tokens, output_tokens, micro_usd)
    values (v_uid, p_feature, p_provider, p_model, p_input_tokens, p_output_tokens, p_micro_usd);

  return query select true, v_used + p_micro_usd, p_monthly_cap_micro_usd, p_monthly_cap_micro_usd - v_used - p_micro_usd;
end;
$$;
revoke all on function record_ai_spend_or_block(text, text, text, int, int, bigint, bigint)
  from public, anon;
grant execute on function record_ai_spend_or_block(text, text, text, int, int, bigint, bigint)
  to authenticated, service_role;

-- ── cleanup_stale_seeks: housekeeping (call from a cron job) ──
-- Restricted to the service_role so a logged-in user can't grief
-- matchmaking by globally evicting other players' open seeks.
create or replace function cleanup_stale_seeks()
returns void as $$
begin
  delete from seeks where created_at < now() - interval '15 minutes';
end;
$$ language plpgsql security definer;
revoke all on function cleanup_stale_seeks() from public, anon, authenticated;
grant execute on function cleanup_stale_seeks() to service_role;

-- ────────────────────────────────────────────────────────────────
-- REALTIME
-- Ensure all live-replicated tables are part of supabase_realtime.
-- The DO block makes this idempotent (alter publication add table is
-- not, on its own).
-- ────────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'seeks') then
    alter publication supabase_realtime add table seeks;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'games') then
    alter publication supabase_realtime add table games;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'challenges') then
    alter publication supabase_realtime add table challenges;
  end if;
  -- friendships: needed so accept / decline propagates instantly to
  -- the other side instead of waiting for the SocialPanel poll.
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'friendships') then
    alter publication supabase_realtime add table friendships;
  end if;
  -- arena_rooms / arena_moves: lobby + warmup + 1v1 sync depend
  -- on UPDATE / INSERT events flowing to the OTHER player. Without
  -- these, postgres_changes subscriptions silently never fire and
  -- both sides stare at a frozen lobby waiting for each other.
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'arena_rooms') then
    alter publication supabase_realtime add table arena_rooms;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'arena_moves') then
    alter publication supabase_realtime add table arena_moves;
  end if;
end $$;

-- ────────────────────────────────────────────────────────────────
-- STORAGE
-- The `avatars` bucket backs uploadAvatar() in the frontend. The
-- bucket is public-read so <img> tags can render avatars without a
-- signed URL, and writes are restricted to objects whose first path
-- segment matches the uploader's auth.uid().
-- ────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "Avatars are publicly readable" on storage.objects;
drop policy if exists "Users can upload their own avatar" on storage.objects;
drop policy if exists "Users can update their own avatar" on storage.objects;
drop policy if exists "Users can delete their own avatar" on storage.objects;

create policy "Avatars are publicly readable" on storage.objects
  for select using (bucket_id = 'avatars');

create policy "Users can upload their own avatar" on storage.objects
  for insert with check (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can update their own avatar" on storage.objects
  for update using (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  ) with check (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can delete their own avatar" on storage.objects
  for delete using (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- ─────────────────────────────────────────────────────────────────────
-- Scheduled job: drain stale matchmaking seeks every 5 minutes.
--
-- `cleanup_stale_seeks()` is restricted to the service_role for client
-- safety, but pg_cron runs jobs as the `postgres` superuser, which can
-- call it regardless of grants. This block:
--   1. Enables pg_cron (no-op if already enabled).
--   2. Idempotently re-creates a 5-minute schedule named
--      `ochess-cleanup-stale-seeks`.
--
-- After running this in the Supabase SQL editor once, no further
-- scheduling action is needed. Verify in `Database → Cron Jobs`.
-- ─────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron with schema extensions;

-- ── Stale matchmaking seeks ──
do $$ begin
  if exists (select 1 from cron.job where jobname = 'ochess-cleanup-stale-seeks') then
    perform cron.unschedule('ochess-cleanup-stale-seeks');
  end if;
end $$;

select cron.schedule(
  'ochess-cleanup-stale-seeks',
  '*/5 * * * *',
  $cron$select cleanup_stale_seeks()$cron$
);

-- ── Abandoned games ──
-- Backstop for the "both players walked away" case. The normal
-- abandonment flow is: one player closes their tab, the other player's
-- browser sees their opponent's clock hit 0 (computed locally from
-- `last_move_at`) and writes the timeout result to the DB. That covers
-- single-side abandonment.
--
-- This RPC handles the edge case where neither side is watching — for
-- instance, both players close their tab during a slow game, or both
-- crash. Without this, the row stays in `status = 'active'` forever
-- and pollutes the user's "active games" list on next sign-in.
--
-- Scope is intentionally narrow:
--   * Only games with a real time control (skip "Unlimited" /
--     correspondence-style games where multi-day pauses are normal).
--   * Only after 24 hours of no `last_move_at` activity. That's far
--     longer than any time-controlled game can legitimately last
--     (longest preset is 30+0 = ~1 hour wall-clock), so any survivor
--     is by definition abandoned.
--   * Result is `*` with `result_reason = 'abandoned'` so the existing
--     UI renders it as a non-rated, non-result row in game history.
create or replace function cleanup_stale_games()
returns void as $$
begin
  update games
  set status = 'completed',
      result = '*',
      result_reason = 'abandoned',
      ended_at = now()
  where status = 'active'
    and time_control is not null
    and (last_move_at is null or last_move_at < now() - interval '24 hours')
    and (created_at is null or created_at < now() - interval '24 hours');
end;
$$ language plpgsql security definer;

revoke execute on function cleanup_stale_games() from public, authenticated, anon;
grant execute on function cleanup_stale_games() to service_role;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'ochess-cleanup-stale-games') then
    perform cron.unschedule('ochess-cleanup-stale-games');
  end if;
end $$;

select cron.schedule(
  'ochess-cleanup-stale-games',
  '17 */6 * * *',
  $cron$select cleanup_stale_games()$cron$
);

-- ── cleanup_stale_arena_rooms: housekeeping (call from a cron job) ──
--
-- Arena rooms are short-lived lobby+session containers. When players
-- abandon a room mid-flow we end up with orphans, and the "right"
-- thing to do depends on the state:
--
--   * Lobbies (`waiting_for_joiner`, `prompting`) idle 1h+ get
--     deleted. They're abandoned share-links / no-show prompts;
--     nothing of value to preserve.
--
--   * Mid-game rooms (`round_1`/`round_2`/`tiebreak`) where the
--     clock has objectively expired for one side AND the row
--     hasn't been touched in 10 minutes get RESOLVED as a
--     time-out forfeit. The user explicitly asked for "delete
--     old games that have been on for more than 10 mins with no
--     active users". The expired side loses the match; the
--     other side wins regardless of how many rounds are left to
--     play (we don't try to advance to round 2 / tiebreak with
--     no one around). Match is closed with status = 'done',
--     match_result.winner set, ended_at stamped.
--
--   * Mid-game rooms idle 10+ minutes WHERE NO CLOCK has
--     expired (e.g. clock paused, never started, or some other
--     edge state) get HARD-DELETED. The user wants old idle
--     games gone, full stop - we don't preserve them just
--     because the resolver can't determine a winner.
--
--   * Truly orphan rooms (any active state, idle 24h+) get
--     hard-deleted as a last-resort cleanup so a cosmic-ray
--     edge case doesn't leak rows forever.
--
-- The function does NOT persist round forfeits to the `games`
-- table - that's the live client's job. The orphan resolution
-- here is purely about freeing the lobby slot and letting both
-- sides see a final "match results" screen if they ever come
-- back. Running every 10 min so users who close their laptop
-- on a pending move get a timely resolution rather than waiting
-- a full hour.
create or replace function cleanup_stale_arena_rooms()
returns void as $$
declare
  r record;
  v_clock jsonb;
  v_round_state jsonb;
  v_match_result jsonb;
  v_budget_ms bigint;
  v_now_ms bigint;
  v_creator_spent_ms bigint;
  v_joiner_spent_ms bigint;
  v_creator_started_at_ms bigint;
  v_joiner_started_at_ms bigint;
  v_creator_live_spent bigint;
  v_joiner_live_spent bigint;
  v_loser text;          -- 'creator' | 'joiner'
  v_winner text;         -- 'creator' | 'joiner'
  v_round_label text;
  v_round_entry jsonb;
  v_existing_rounds jsonb;
  v_score_creator numeric;
  v_score_joiner numeric;
  v_ply_count int;
  v_final_fen text;
begin
  ---------------------------------------------------------------
  -- 1. Lobbies idle 1h+ → delete. Nothing to resolve.
  ---------------------------------------------------------------
  delete from arena_rooms
  where status in ('waiting_for_joiner','prompting')
    and updated_at < now() - interval '1 hour';

  ---------------------------------------------------------------
  -- 2. Mid-game timeouts: row idle 5 min AND clock objectively
  --    expired for one side. Resolve as a forfeit, close out
  --    the match, mark status='done'.
  ---------------------------------------------------------------
  v_now_ms := (extract(epoch from now()) * 1000)::bigint;

  for r in
    select id, status, round_state, match_result, creator_id, joiner_id
    from arena_rooms
    where status in ('round_1','round_2','tiebreak')
      and updated_at < now() - interval '10 minutes'
  loop
    v_round_state := coalesce(r.round_state, '{}'::jsonb);
    v_clock := v_round_state->'clock';
    if v_clock is null or jsonb_typeof(v_clock) <> 'object' then
      continue;
    end if;

    v_budget_ms := nullif(v_clock->>'budgetMs','')::bigint;
    if v_budget_ms is null or v_budget_ms <= 0 then
      continue;
    end if;

    v_creator_spent_ms       := coalesce(nullif(v_clock->'creator'->>'spentMs','')::bigint, 0);
    v_joiner_spent_ms        := coalesce(nullif(v_clock->'joiner'->>'spentMs','')::bigint, 0);
    v_creator_started_at_ms  := nullif(v_clock->'creator'->>'turnStartedAtMs','')::bigint;
    v_joiner_started_at_ms   := nullif(v_clock->'joiner'->>'turnStartedAtMs','')::bigint;

    -- Live spent = baseline spent + (now - turnStartedAt) when running.
    v_creator_live_spent := v_creator_spent_ms;
    if v_creator_started_at_ms is not null then
      v_creator_live_spent := v_creator_live_spent + greatest(0, v_now_ms - v_creator_started_at_ms);
    end if;
    v_joiner_live_spent := v_joiner_spent_ms;
    if v_joiner_started_at_ms is not null then
      v_joiner_live_spent := v_joiner_live_spent + greatest(0, v_now_ms - v_joiner_started_at_ms);
    end if;

    -- Identify the side whose clock has actually expired. If
    -- both somehow expired, the side that was running gets the
    -- forfeit (their move was due). If neither expired the row
    -- isn't truly stale and we skip it.
    v_loser := null;
    if v_creator_live_spent >= v_budget_ms and v_creator_started_at_ms is not null then
      v_loser := 'creator';
    elsif v_joiner_live_spent >= v_budget_ms and v_joiner_started_at_ms is not null then
      v_loser := 'joiner';
    elsif v_creator_live_spent >= v_budget_ms then
      v_loser := 'creator';
    elsif v_joiner_live_spent >= v_budget_ms then
      v_loser := 'joiner';
    end if;
    if v_loser is null then
      continue;
    end if;
    v_winner := case when v_loser = 'creator' then 'joiner' else 'creator' end;

    -- Build the round-result entry. We close out the entire
    -- match here regardless of which round it is - playing
    -- further rounds with no one around is pointless, and the
    -- timeout itself already implies match abandonment.
    v_round_label := case
      when r.status = 'tiebreak' then 'tiebreak'
      when r.status = 'round_1' then '1'
      when r.status = 'round_2' then '2'
      else r.status
    end;
    v_ply_count := coalesce(nullif(v_round_state->>'plyCount','')::int, 0);
    v_final_fen := coalesce(v_round_state->>'fen','');

    v_round_entry := jsonb_build_object(
      'round', v_round_label,
      'winner', v_winner,
      'reason', v_loser || ' clock expired (auto-forfeit)',
      'endedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'finalFen', v_final_fen,
      'plyCount', v_ply_count,
      'clockSpent', jsonb_build_object(
        'creator', v_creator_live_spent,
        'joiner', v_joiner_live_spent
      )
    );

    -- Stitch the new round onto match_result.rounds, recompute
    -- score, then mark match.winner = v_winner so the UI lands
    -- on the final results screen.
    v_match_result := coalesce(r.match_result, '{}'::jsonb);
    v_existing_rounds := coalesce(v_match_result->'rounds', '[]'::jsonb);
    -- Idempotent: skip if a round with this label is already
    -- recorded (a returning client may have resolved it
    -- between the time we read the row and now).
    if exists (
      select 1 from jsonb_array_elements(v_existing_rounds) elt
      where elt->>'round' = v_round_label
    ) then
      continue;
    end if;
    v_existing_rounds := v_existing_rounds || jsonb_build_array(v_round_entry);

    -- Score: 1 point per round won, 0.5 for draws. We only ever
    -- add a winning entry here so just bump the winner's tally.
    v_score_creator := coalesce(nullif(v_match_result->'score'->>'creator','')::numeric, 0);
    v_score_joiner  := coalesce(nullif(v_match_result->'score'->>'joiner','')::numeric, 0);
    if v_winner = 'creator' then v_score_creator := v_score_creator + 1;
    else v_score_joiner := v_score_joiner + 1;
    end if;

    v_match_result := jsonb_set(v_match_result, '{rounds}', v_existing_rounds, true);
    v_match_result := jsonb_set(v_match_result, '{score}', jsonb_build_object(
      'creator', v_score_creator,
      'joiner', v_score_joiner
    ), true);
    v_match_result := jsonb_set(v_match_result, '{winner}', to_jsonb(v_winner), true);

    -- Pause the clock (set turnStartedAtMs to null on whichever
    -- side was running) so the UI doesn't keep ticking after
    -- we close the match.
    v_round_state := jsonb_set(v_round_state, '{endedAt}', to_jsonb(now()), true);
    if v_clock->'creator'->>'turnStartedAtMs' is not null then
      v_round_state := jsonb_set(
        v_round_state,
        '{clock,creator}',
        jsonb_build_object('spentMs', v_creator_live_spent),
        true
      );
    end if;
    if v_clock->'joiner'->>'turnStartedAtMs' is not null then
      v_round_state := jsonb_set(
        v_round_state,
        '{clock,joiner}',
        jsonb_build_object('spentMs', v_joiner_live_spent),
        true
      );
    end if;

    update arena_rooms
    set status = 'done',
        match_result = v_match_result,
        round_state = v_round_state,
        updated_at = now()
    where id = r.id;
  end loop;

  ---------------------------------------------------------------
  -- 3. Anything still active after 10 min that the resolver
  --    above didn't pick up (e.g. clock never started, paused,
  --    unparseable shape, or the room is still in warmup with
  --    nobody clicking ready) gets HARD DELETED. The user
  --    wants idle games gone so the lobby + db stay clean -
  --    we don't preserve rooms just because the auto-resolver
  --    can't determine a winner from the data on hand.
  ---------------------------------------------------------------
  delete from arena_rooms
  where status in ('warmup_round_1','warmup_round_2','round_1','round_2','tiebreak','prompting')
    and updated_at < now() - interval '10 minutes';
end;
$$ language plpgsql security definer;

revoke execute on function cleanup_stale_arena_rooms() from public, authenticated, anon;
grant execute on function cleanup_stale_arena_rooms() to service_role;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'ochess-cleanup-stale-arena-rooms') then
    perform cron.unschedule('ochess-cleanup-stale-arena-rooms');
  end if;
end $$;

-- Run every 5 min so a player who closes their laptop with a
-- pending move gets resolved promptly. Combined with the
-- 10-minute idle threshold, the worst-case staleness for an
-- abandoned room is ~15 minutes (5 min jitter + 10 min idle).
select cron.schedule(
  'ochess-cleanup-stale-arena-rooms',
  '*/5 * * * *',
  $cron$select cleanup_stale_arena_rooms()$cron$
);
