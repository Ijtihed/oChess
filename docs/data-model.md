# oChess — Data Model

All models are defined here for reference. Models marked **(IMPLEMENTED)** are currently working in the client-side app (localStorage or in-memory). Models marked **(PLANNED)** are designed for the backend.

---

## Client-Side Data (Currently Implemented)

### Active Game State (localStorage: `ochess_active_game`)
| Field | Type | Notes |
|-------|------|-------|
| pgn | string | Full PGN of current game |
| opponent | object | { name, level, desc, rating } |
| playerColor | "w" \| "b" | |
| botChat | array | Last 10 chat messages |
| clockState | object | { white: ms, black: ms }, nullable |
| timeControl | object | { initial: ms, increment: ms }, nullable |
| savedAt | number | Timestamp |

### Puzzle Rating (localStorage: `ochess_puzzle_rating`) — IMPLEMENTED
| Field | Type | Notes |
|-------|------|-------|
| rating | number | Glicko-1 rating (default 1500) |
| rd | number | Rating deviation (default 350, floor 50) |
| games | number | Total puzzles attempted |

### Puzzle Settings (localStorage: `ochess_puzzle_settings`) — IMPLEMENTED
| Field | Type | Notes |
|-------|------|-------|
| timerSec | number | 0 (off), 15, 30, 60, -1 (infinite) |
| autoAdvance | boolean | |

### Puzzle Streak (localStorage: `ochess_puzzle_streak`) — IMPLEMENTED
| Field | Type | Notes |
|-------|------|-------|
| current | number | Current streak |
| best | number | All-time best streak |

### Board Preferences (localStorage: `ochess_board_prefs`) — IMPLEMENTED
| Field | Type | Notes |
|-------|------|-------|
| boardTheme | string | Theme ID (e.g. "default", "blue", "wood") |
| pieceSet | string | Piece set directory name (e.g. "staunty", "merida") |

### Saved Analysis Boards (localStorage: `ochess_saved_analysis`) — IMPLEMENTED
| Field | Type | Notes |
|-------|------|-------|
| id | number | Timestamp-based unique ID |
| label | string | Opening name or "Position" or "Custom" |
| fen | string | Current FEN |
| pgn | string | Full PGN |
| ply | number | Current ply position |
| savedAt | number | Timestamp |

Max 5 saved boards.

### Review Schedule State (in-memory, localStorage planned) — IMPLEMENTED
| Field | Type | Notes |
|-------|------|-------|
| dueAt | Date | When card is next due |
| easeFactor | number | Default 2.5, floor 1.3 |
| intervalDays | number | Default 0 |
| repetitions | number | Default 0 |
| lapseCount | number | Default 0 |
| lastReviewedAt | Date | Nullable |

---

## Planned Backend Models

### User
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

### GuestSession
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK, stored client-side |
| created_at | timestamp | |
| last_active_at | timestamp | |
| display_name | string | auto-generated |

### Profile
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

### Game
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| variant_id | string | FK → VariantDefinition, default "standard" |
| time_control | string | e.g. "5+3" |
| rated | boolean | |
| status | enum | waiting, active, completed, aborted |
| result | enum | white_wins, black_wins, draw, aborted, null |
| result_reason | string | checkmate, resignation, timeout, stalemate, etc. |
| pgn | text | Full PGN (~2–5 KB) |
| initial_fen | string | nullable |
| clock_data | jsonb | nullable |
| created_at | timestamp | |
| completed_at | timestamp | nullable |

### GameParticipant
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| game_id | uuid | FK → Game |
| user_id | uuid | FK → User, nullable |
| guest_session_id | uuid | FK → GuestSession, nullable |
| color | enum | white, black |
| rating_before | integer | nullable |
| rating_after | integer | nullable |

### GameAnalysis (async, post-game)
| Field | Type | Notes |
|-------|------|-------|
| game_id | uuid | FK → Game, PK |
| opening_eco | string | ECO code |
| opening_name | string | e.g. "Sicilian Najdorf" |
| evals | jsonb | per-ply engine evals |
| annotations | jsonb | mistake/blunder markers |
| analyzed_at | timestamp | |

---

### Rating
| Field | Type | Notes |
|-------|------|-------|
| user_id | uuid | FK → User |
| variant_id | string | |
| time_category | enum | bullet, blitz, rapid, classical |
| rating | integer | current |
| rd | float | rating deviation (Glicko) |
| games_count | integer | |

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

### BotProfile
| Field | Type | Notes |
|-------|------|-------|
| id | string | PK |
| name | string | display name |
| description | string | |
| rating | integer | approximate strength |
| level | integer | 0–7 |
| engine_config | jsonb | engine type, elo, jce level |

Currently implemented as `BOT_CONFIG` array in `lib/bot-engine.js`:
- Level 0: Random (no rating)
- Level 1: Rookie (~400, jce level 0)
- Level 2: Patzer (~800, jce level 1)
- Level 3: Club (~1200, jce level 3)
- Level 4: Expert (~1600, sf elo 1700)
- Level 5: Master (~2000, sf elo 2100)
- Level 6: Grandmaster (~2400, sf elo 2600)
- Level 7: Stockfish (~3200, sf unlimited)

---

### Puzzle
| Field | Type | Notes |
|-------|------|-------|
| id | string | PK, from Lichess DB |
| fen | string | starting position |
| moves | string[] | solution moves (UCI) |
| rating | integer | puzzle difficulty |
| themes | string[] | tactical themes |
| game_url | string | source game, nullable |
| popularity | integer | |

Currently loaded from Lichess CSV at runtime.

---

### ReviewDeck
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| user_id | uuid | FK → User |
| name | string | |
| deck_type | enum | openings, tactics, endgame, strategy, mistakes, custom |
| is_system_generated | boolean | |
| created_at | timestamp | |

### ReviewCard
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| deck_id | uuid | FK → ReviewDeck |
| card_type | enum | position_recall, move_prediction, concept, opening_line, tactic, endgame_technique |
| prompt | text | |
| answer | text | |
| fen | string | nullable |
| move_sequence | string | nullable, UCI |
| explanation | text | nullable |
| tags | string[] | |
| is_active | boolean | default true |
| created_at | timestamp | |

### ReviewCardSource
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| card_id | uuid | FK → ReviewCard |
| source_type | enum | game, puzzle, study, analysis, coach, manual |
| source_id | uuid | nullable |
| source_meta | jsonb | |

### ReviewReviewLog
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| card_id | uuid | FK → ReviewCard |
| rating | integer | 1–4 |
| reviewed_at | timestamp | |
| previous_interval | integer | days |
| new_interval | integer | days |
| previous_ease | float | |
| new_ease | float | |

### ReviewScheduleState
| Field | Type | Notes |
|-------|------|-------|
| card_id | uuid | FK → ReviewCard, PK |
| due_at | timestamp | |
| ease_factor | float | default 2.5 |
| interval_days | integer | default 0 |
| repetitions | integer | default 0 |
| lapse_count | integer | default 0 |
| last_reviewed_at | timestamp | nullable |

---

### Other planned models (unchanged from original design)

- **Lobby** — Game creation, private lobbies, invite codes
- **Study / AnalysisRoom** — Collaborative study and analysis
- **ChatMessage** — In-game, analysis room, and direct chat
- **VariantDefinition** — Preset and user-created variants
- **CoachPreset** — System prompt templates for AI coach
- **CreditLedger** — AI credit transactions for duels
