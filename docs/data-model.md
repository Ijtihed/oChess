# oChess — Data Model

All models are defined here for reference. Not all are implemented in MVP — those marked (MVP) are scaffolded first.

---

## User & Identity

### User (MVP)
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| email | string | unique, nullable for OAuth-only |
| username | string | unique, display name |
| password_hash | string | nullable (OAuth users) |
| auth_provider | enum | google, email, null |
| created_at | timestamp | |
| updated_at | timestamp | |
| role | enum | player, moderator, admin |
| is_titled | boolean | default false |
| title | string | GM, IM, FM, etc. nullable |

### GuestSession (MVP)
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK, stored client-side |
| created_at | timestamp | |
| last_active_at | timestamp | |
| display_name | string | auto-generated |

### Profile (MVP)
| Field | Type | Notes |
|-------|------|-------|
| user_id | uuid | FK → User, PK |
| bio | string | nullable |
| country | string | ISO code, nullable |
| avatar_url | string | nullable |
| is_public | boolean | default true |

### Friendship
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| requester_id | uuid | FK → User |
| addressee_id | uuid | FK → User |
| status | enum | pending, accepted, blocked |
| created_at | timestamp | |

---

## Games

### Game (MVP)
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| variant_id | string | FK → VariantDefinition, default "standard" |
| time_control | string | e.g. "5+3" |
| rated | boolean | |
| status | enum | waiting, active, completed, aborted |
| result | enum | white_wins, black_wins, draw, aborted, null |
| result_reason | string | checkmate, resignation, timeout, stalemate, etc. |
| pgn | text | **primary move storage** — full PGN written once when game ends (~2–5 KB) |
| initial_fen | string | starting position (for variants/custom), nullable |
| clock_data | jsonb | per-move clock snapshots, nullable — `[{ply, wtime, btime}]` |
| created_at | timestamp | |
| completed_at | timestamp | nullable |

**Storage strategy:** PGN is the single source of truth for moves. One text field, one DB write, ~2–5 KB per game. During a live game, moves exist only in server memory + WebSocket broadcast. The DB is updated once when the game ends. chess.js can parse PGN back into any position or move list on demand — no need to store moves row-by-row.

At 5 KB per game, 1 million games = ~5 GB. Postgres handles this trivially.

### GameParticipant (MVP)
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| game_id | uuid | FK → Game |
| user_id | uuid | FK → User, nullable |
| guest_session_id | uuid | FK → GuestSession, nullable |
| color | enum | white, black |
| rating_before | integer | nullable |
| rating_after | integer | nullable |

### GameAnalysis (derived, async — not MVP)

Populated **after** game completion by an async worker. Not primary storage.
Used only for search/indexing (e.g. "show me games where I played the Sicilian").

| Field | Type | Notes |
|-------|------|-------|
| game_id | uuid | FK → Game, PK |
| opening_eco | string | ECO code, e.g. "B90" |
| opening_name | string | e.g. "Sicilian Najdorf" |
| evals | jsonb | per-ply engine evals `[{ply, cp, mate}]` |
| annotations | jsonb | mistake/blunder markers `[{ply, type, explanation}]` |
| analyzed_at | timestamp | |

This replaces a per-move `Move` table. The PGN on the Game record is all you need to reconstruct any position — chess.js does this in microseconds. The analysis table is an optional async index for features like opening classification and mistake detection.

### Lobby
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| creator_id | uuid | FK → User or GuestSession |
| variant_id | string | |
| time_control | string | |
| rated | boolean | |
| is_private | boolean | |
| invite_code | string | nullable, for private lobbies |
| credit_stake | integer | AI credits, default 0 |
| status | enum | open, matched, cancelled, expired |
| created_at | timestamp | |

---

## Ratings

### Rating (MVP)
| Field | Type | Notes |
|-------|------|-------|
| user_id | uuid | FK → User |
| variant_id | string | |
| time_category | enum | bullet, blitz, rapid, classical |
| rating | integer | current Elo |
| rd | float | rating deviation (Glicko) |
| games_count | integer | |

Composite PK: (user_id, variant_id, time_category)

### RatingHistory
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| user_id | uuid | FK → User |
| variant_id | string | |
| time_category | enum | |
| rating | integer | |
| game_id | uuid | FK → Game |
| recorded_at | timestamp | |

---

## Bots

### BotProfile
| Field | Type | Notes |
|-------|------|-------|
| id | string | PK, e.g. "rookie", "stockfish" |
| name | string | display name |
| description | string | |
| rating | integer | approximate strength |
| level | integer | 0–7 |
| engine_config | jsonb | depth, skill level, etc. |

---

## Puzzles

### Puzzle
| Field | Type | Notes |
|-------|------|-------|
| id | string | PK, from Lichess DB |
| fen | string | starting position |
| moves | string | solution moves (UCI) |
| rating | integer | puzzle difficulty |
| themes | string[] | tactical themes |
| game_url | string | source game, nullable |
| popularity | integer | |

---

## Study & Analysis

### Study
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| owner_id | uuid | FK → User |
| title | string | |
| description | string | nullable |
| is_public | boolean | |
| created_at | timestamp | |
| updated_at | timestamp | |

### AnalysisRoom
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| owner_id | uuid | FK → User |
| title | string | |
| initial_fen | string | |
| pgn | text | current state |
| is_public | boolean | |
| participants | uuid[] | active user IDs |
| created_at | timestamp | |

---

## Chat

### ChatMessage
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| context_type | enum | game, analysis_room, direct |
| context_id | uuid | game or room ID |
| sender_id | uuid | FK → User |
| content | string | |
| created_at | timestamp | |

---

## Variants

### VariantDefinition
| Field | Type | Notes |
|-------|------|-------|
| id | string | PK, e.g. "standard", "chess960" |
| name | string | display name |
| description | string | |
| is_builtin | boolean | true for preset variants |
| creator_id | uuid | FK → User, nullable (null for builtins) |
| rules | jsonb | serialized rule config |
| initial_fen | string | nullable (generator for 960) |

---

## AI Coach

### CoachPreset
| Field | Type | Notes |
|-------|------|-------|
| id | string | PK |
| name | string | e.g. "Beginner friendly", "Brutal honesty" |
| system_prompt | text | prompt template |
| is_default | boolean | |
| creator_id | uuid | nullable (null for system presets) |

---

## Credits

### CreditLedger
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| user_id | uuid | FK → User |
| amount | integer | positive = credit, negative = debit |
| reason | enum | duel_stake, duel_win, purchase, bonus |
| reference_id | uuid | game_id or transaction_id |
| created_at | timestamp | |

---

## Review (Spaced Repetition)

### ReviewDeck (MVP)
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| user_id | uuid | FK → User |
| name | string | |
| deck_type | enum | openings, tactics, endgame, strategy, mistakes, custom |
| is_system_generated | boolean | |
| created_at | timestamp | |

### ReviewCard (MVP)
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| deck_id | uuid | FK → ReviewDeck |
| card_type | enum | position_recall, move_prediction, concept, opening_line, tactic, endgame_technique |
| prompt | text | question or instruction |
| answer | text | expected answer or explanation |
| fen | string | nullable |
| move_sequence | string | nullable, UCI moves |
| explanation | text | nullable, coach explanation |
| tags | string[] | |
| is_active | boolean | default true |
| created_at | timestamp | |

### ReviewCardSource (MVP)
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| card_id | uuid | FK → ReviewCard |
| source_type | enum | game, puzzle, study, analysis, coach, manual |
| source_id | uuid | nullable, FK to source entity |
| source_meta | jsonb | additional context |

### ReviewReviewLog (MVP)
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| card_id | uuid | FK → ReviewCard |
| rating | integer | 1=Again, 2=Hard, 3=Good, 4=Easy |
| reviewed_at | timestamp | |
| previous_interval | integer | days |
| new_interval | integer | days |
| previous_ease | float | |
| new_ease | float | |

### ReviewScheduleState (MVP)
| Field | Type | Notes |
|-------|------|-------|
| card_id | uuid | FK → ReviewCard, PK |
| due_at | timestamp | when card is next due |
| ease_factor | float | default 2.5 |
| interval_days | integer | default 0 |
| repetitions | integer | default 0 |
| lapse_count | integer | default 0 |
| last_reviewed_at | timestamp | nullable |
