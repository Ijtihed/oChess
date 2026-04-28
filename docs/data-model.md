# oChess - Data Model

This is a field-by-field reference for the canonical schema in [`supabase/schema.sql`](../supabase/schema.sql) plus the localStorage state shapes used by the client. The schema file is the single source of truth - if you spot a mismatch, the schema wins and this doc needs updating.

---

## Server-side (Supabase Postgres)

All tables live in the `public` schema with row-level security on. Most tables are owned by `auth.users` via foreign-key references.

### `profiles`
The user's public-facing identity row. Created on signup via a trigger that backfills from `auth.users.email`.

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | references `auth.users(id)` on delete cascade |
| username | text unique | required, lowercase a-z 0-9 _ |
| display_name | text | nullable, defaults to username |
| avatar_url | text | public URL into the `avatars` storage bucket |
| bio | text | nullable, free-form |
| country | text | ISO-3166 alpha-2 code (lowercase), nullable |
| lichess_username | text | nullable, used by StudyPlanPanel game-import |
| chesscom_username | text | nullable, same |
| board_prefs | jsonb | board theme + piece set preferences (synced from localStorage) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | bumped on any update via trigger |

RLS: public-read, owner-write.

### `ratings`
Glicko-2 rating per (user, time-control category). Updated by `glicko2_update` RPC after each rated game.

| Field | Type | Notes |
|---|---|---|
| user_id | uuid PK | FK -> profiles.id |
| time_category | text PK | "bullet" / "blitz" / "rapid" / "classical" |
| rating | float | default 1500 |
| rd | float | rating deviation, default 350, floor 50 |
| volatility | float | Glicko-2 sigma, default 0.06 |
| games_count | int | total rated games in this category |
| updated_at | timestamptz | |

RLS: public-read.

### `games`
Every online + bot-completed game. Live games row-update via Realtime postgres_changes; finished games stay around for the profile recent-games view.

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| white_id / black_id | uuid | nullable on disconnect, on delete set null |
| white_name / black_name | text | snapshot at game start |
| white_rating / black_rating | float | snapshot at game start |
| pgn | text | full PGN, single source of truth for board state |
| moves_count | int | derived; used by `applyServerRow` to detect "moves advanced" |
| turn | text | "w" or "b" |
| white_time_ms / black_time_ms | bigint | clocks at last move |
| last_move_at | timestamptz | for clock reconciliation |
| time_control | text | e.g. "5+0", nullable for unlimited |
| category | text | "bullet" / "blitz" / "rapid" / "classical", determines which `ratings` row to update |
| variant | text | default "standard"; chess960, antichess, kingOfTheHill, threeCheck, horde, racingKings, fogOfWar |
| is_rated | bool | |
| status | text | "active" / "completed" / "aborted" |
| result | text | "1-0" / "0-1" / "1/2-1/2" / "*" |
| result_reason | text | "checkmate" / "resignation" / "timeout" / "stalemate" / "draw by agreement" / etc. |
| chat | jsonb | array of `{ from, text, name }` (capped to ~50 most recent) |
| white_draw_offers / black_draw_offers | int | per-side counter, capped at 3 |
| rematch_offered_by | uuid | FK -> profiles.id, cleared on cancel/decline |
| rematch_game_id | uuid | FK -> games.id, set when rematch is accepted |
| created_at | timestamptz | for the 30s auto-abort window + the cleanup_stale_games cron |
| ended_at | timestamptz | set on terminal transition |

RLS: select for participants only; update tightened to `auth.uid() in (white_id, black_id) and status='active'`.

### `seeks`
Open matchmaking pool. Drained every 5 min by the `cleanup_stale_seeks` cron job.

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid | FK -> profiles.id |
| user_name | text | snapshot at seek time |
| user_rating | float | snapshot |
| time_control | text | "5+0" |
| category | text | bullet/blitz/rapid/classical |
| variant | text | |
| is_rated | bool | |
| created_at | timestamptz | |

RLS: insert/delete only by owner; select public so `findMatch` can scan.

### `challenges`
Direct-link friend challenges. The `accept_challenge` RPC consumes them and creates the `games` row.

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| code | text unique | URL-safe nanoid |
| created_by | uuid | FK -> profiles.id |
| time_control | text | |
| category | text | |
| variant | text | default "standard" |
| status | text | "waiting" / "active" / "expired" |
| game_id | uuid | FK -> games.id, set on accept |
| created_at | timestamptz | |

RLS: select public; insert by creator; update by creator OR by anyone marking a stale "waiting" row "expired".

### `puzzle_progress`
Per-user puzzle rating + RD + games count. Glicko-1 (lighter than Glicko-2; puzzles aren't pairwise so the simpler model is sufficient).

| Field | Type | Notes |
|---|---|---|
| user_id | uuid PK | FK -> profiles.id |
| rating | float | default 1500 |
| rd | float | default 350, floor 50 |
| games | int | |
| updated_at | timestamptz | |

RLS: owner-only.

### `puzzle_attempts`
One row per attempted puzzle. Drives "wasPuzzleAttempted" check in the adaptive picker so users don't keep getting the same puzzle.

| Field | Type | Notes |
|---|---|---|
| id | bigserial PK | |
| user_id | uuid | FK -> profiles.id |
| puzzle_id | text | matches Lichess DB ids |
| solved | bool | |
| time_ms | int | nullable |
| created_at | timestamptz | |

RLS: insert by `auth.uid() = user_id`; select by owner.

### `review_cards`
Reserved for future server-side mirror of localStorage review cards (cross-device sync). Currently unused at runtime - the Anki deck lives in `localStorage` only.

### `friendships`
Bidirectional with reverse-pair dedup. The `normalize_friend_pair()` trigger rejects an insert when the reverse pair already exists.

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid | FK -> profiles.id (the requester) |
| friend_id | uuid | FK -> profiles.id (the addressee) |
| status | text | "pending" / "accepted" |
| created_at | timestamptz | |

RLS: participants only (both `user_id` and `friend_id` can read / update / delete).

### `coach_calls`
One row per successful AI coach call. Powers the per-account rate limit (3 calls / 5 min) enforced by `record_coach_call`. Old rows auto-purge after 1 day.

| Field | Type | Notes |
|---|---|---|
| id | bigserial PK | |
| user_id | uuid | FK -> auth.users.id |
| created_at | timestamptz | |

RLS: on, no policies. Only the SECURITY DEFINER `record_coach_call` RPC reads / writes.

---

## Server-side RPCs

| RPC | Purpose |
|---|---|
| `claim_seek(seek_id, claimer_id, name, rating)` | Atomic match: locks the seek row, creates a games row, returns it. SECURITY DEFINER + auth.uid() check. |
| `accept_challenge(challenge_id, joiner_id, name, rating)` | Same shape for direct challenges. Copies variant + time_control onto the games row. |
| `create_rematch(source_game_id, user_id)` | Idempotent: if `rematch_game_id` is already set, returns the linked row. Otherwise creates a new game with colors swapped. |
| `glicko2_update(game_id, white_id, black_id, score, category)` | Updates both `ratings` rows after a rated game. Idempotent + participant-validated. |
| `record_coach_call(window_seconds, max_calls)` | Per-user rolling-window rate limit for the AI coach. |
| `cleanup_stale_seeks()` | Drains seeks > 15 min old. Called by `pg_cron` every 5 min. service_role only. |
| `cleanup_stale_games()` | Marks active timed games with no move in 24 h as aborted. Called by `pg_cron` every 6 h. service_role only. |

---

## Storage

### `avatars` bucket
Public-read, per-user-write. Path convention: `<userId>/<timestamp>.<ext>`.

RLS:
- `select`: anyone (public read).
- `insert / update / delete`: `auth.uid()::text = (storage.foldername(name))[1]` (path must start with the uploader's userId).

`uploadAvatar()` cleans up older files in the user's folder after a successful new upload, so storage doesn't accumulate one orphan per re-upload.

---

## Client-side state (localStorage)

| Key | Shape |
|---|---|
| `ochess_review_cards` | Array of card objects: `{ id, type, fen, ts, ...type-specific fields }` |
| `ochess_review_schedule` | `{ <cardId>: { state, step, easeFactor, intervalDays, intervalMs, repetitions, lapseCount, dueAt, lastReviewedAt } }` |
| `ochess_drill_sets` | Array of `{ id, name, query, chipId, createdAt, updatedAt }` |
| `ochess_puzzle_rating` | `{ rating, rd, games }` (Glicko-1) |
| `ochess_puzzle_history` | `{ <puzzleId>: { solved, ts } }` |
| `ochess_puzzle_streak` | `{ current, best }` |
| `ochess_puzzle_settings` | `{ timerSec, autoAdvance, ... }` |
| `ochess_board_prefs` | `{ boardTheme, pieceSet, ... }` |
| `ochess_saved_analysis` | Array of `{ id, label, fen, pgn, ply, savedAt }`, max 5 |
| `ochess_active_game` | Active bot game: `{ pgn, opponent, playerColor, botChat, clockState, timeControl, savedAt }` |
| `ochess_guest_session` | `"1"` if guest mode is active |
| `ochess_import_throttle` | `{ <source>: [<timestamp>, ...] }` for game-import per-source rate cap |

### Card-type variants

Cards in `ochess_review_cards` always have `id`, `type`, `fen`, `ts`. Per-type extras:

| Type | Extra fields | Saved by |
|---|---|---|
| `puzzle` | `puzzleId`, `rating`, `themes[]`, `answerMove`, `lineMoves[]` | PuzzlesPage on failure |
| `mistake` | `played_san`, `best_san`, `eval_loss_cp`, `phase`, `themes[]`, `opening`, `source`, `source_url`, `game_id`, `ply` | StudyPlanPanel after Stockfish analysis |
| `analysis` | `notes`, `answerMove?`, `answerText?` | AnalysisPage save-position button |
| `game` | `played_san`, `notes` | GameScreen save-from-bot-game |
| `shared` | All fields preserved from source | ReviewPage `?import=<base64>` |
| `tactic` / `opening` / `endgame` | (reserved for future authored decks) | |

### SM-2 schedule shape

Each entry in `ochess_review_schedule` is shaped:

| Field | Type | Notes |
|---|---|---|
| state | "new" / "learning" / "review" / "relearning" | NEW collapses to LEARNING on the first rating |
| step | int | sub-day step index (LEARNING_STEPS_MIN[step]) |
| easeFactor | float | default 2.5, floor 1.3 |
| intervalDays | int | days, capped at 5 years |
| intervalMs | int | sub-day interval in ms (only meaningful in LEARNING / RELEARNING) |
| repetitions | int | successful Goods + Easies in REVIEW state |
| lapseCount | int | Again-on-REVIEW count, lifetime |
| dueAt | Date | when the card is next due |
| lastReviewedAt | Date / null | |

Pre-Anki schedules (without `state`) are migrated transparently by `sanitize()`: cards with non-zero interval get `state="review"`, blank ones get `state="new"`.

---

## Bot config (in code)

`BOT_CONFIG` array in `lib/bot-engine.js`:

| Level | Name | Approx. rating | Engine |
|---|---|---|---|
| 0 | Random | n/a | random legal moves |
| 1 | Rookie | ~400 | js-chess-engine level 0 |
| 2 | Patzer | ~800 | js-chess-engine level 1 |
| 3 | Club | ~1200 | js-chess-engine level 3 |
| 4 | Expert | ~1600 | Stockfish UCI_Elo 1700 |
| 5 | Master | ~2000 | Stockfish UCI_Elo 2100 |
| 6 | Grandmaster | ~2400 | Stockfish UCI_Elo 2600 |
| 7 | Stockfish | ~3200 | Stockfish unlimited |

---

## Puzzle source

Lichess puzzle CSV streamed at runtime. Trimmed to ~10k puzzles (popularity >= 80, reservoir-sampled) and committed at `public/puzzledb/puzzles.csv` (~1.8 MB). Adaptive picker uses Glicko-1 to find a puzzle near the player's rating with no recent repeats.

| Field | Notes |
|---|---|
| id | matches Lichess DB |
| fen | starting position (after the setup move) |
| moves[] | full UCI sequence, [0] is opponent's setup move |
| rating | difficulty |
| themes[] | tactical themes (mate, pin, fork, ...) |
| popularity | >= 80 in our trimmed set |
