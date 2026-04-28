# oChess - Architecture

## Stack

| Layer | Tech |
|---|---|
| Framework | React 19 + Vite 8 (SPA, lazy-loaded routes) |
| Routing | react-router-dom v7 |
| Styling | Tailwind CSS v4 + custom design tokens |
| Chess logic | chess.js v1.4 |
| Board UI | react-chessboard v5 |
| Variants | `lib/variants.js` (wraps chess.js, see "Variants" below) |
| Bot - weak | js-chess-engine in a Web Worker (levels 0-3) |
| Bot - strong | Stockfish 18 WASM in a Web Worker (levels 4-7), UCI |
| Analysis engine | Stockfish 18 WASM, separate worker, locked during live play |
| Spaced repetition | Custom Anki-style SM-2 (`lib/review-engine.js`) |
| Backend | Supabase (PostgreSQL + Realtime + Auth + Storage + Edge Functions) |
| Realtime | Supabase Realtime (postgres_changes + broadcast + presence) |
| Auth | Supabase Auth (email + Google OAuth, PKCE flow) |
| LLM coach | Groq (Llama 3.3 70B) via a JWT-gated Supabase Edge Function |
| Monitoring | Sentry (errors) + PostHog (analytics), both opt-in via env vars |
| Testing | Vitest + @testing-library/react + Playwright e2e |
| CI/CD | GitHub Actions on push/PR to `main` |

## Data flow

```
                          ┌─ Supabase Postgres ──────────────────┐
                          │  profiles / ratings / games / seeks  │
                          │  challenges / puzzle_progress /      │
                          │  puzzle_attempts / review_cards /    │
                          │  friendships / coach_calls           │
                          └──────────────────────────────────────┘
                                   ▲                ▲
                            RLS-gated reads + writes
                                   │
   ┌── Browser ───────────┐        │
   │  React 19            │   ◄────┘
   │  Vite SPA            │
   │  chess.js + variants │   ─── postgres_changes ───► live game / friend / challenge updates
   │  Stockfish wasm      │   ◄── broadcast ───────────► fast move / chat / offer hints
   │  Anki state machine  │   ◄── presence ─────────► opponent online indicators
   └──────────────────────┘
            │
            └── functions.invoke('coach') ─────────► Edge Function ──► Groq LLM
                                                       (JWT gate +
                                                        record_coach_call
                                                        rate limit)
```

The DB row is the single source of truth for every persistent piece of state. Realtime broadcasts are speed hints layered on top - they're verified against the DB before we apply terminal events (resign / draw accept / game over) so a malicious client with the anon key can't forge those.

## Persistent state

### Server-side (Supabase Postgres)

| Table | Purpose |
|---|---|
| `profiles` | Username, display name, avatar URL, bio, country, lichess/chesscom usernames, board prefs |
| `ratings` | Glicko-2 rating per (user, time-control category) |
| `games` | Every online + bot-completed game. PGN, clocks, status, result, rematch link |
| `seeks` | Open matchmaking pool. `cleanup_stale_seeks` cron drains 15-min-old rows |
| `challenges` | Direct-link friend challenges. Variant + time control. `accept_challenge` RPC creates the games row |
| `puzzle_progress` | Per-user puzzle rating + RD + games count |
| `puzzle_attempts` | One row per attempted puzzle (for stats + the Anki "wasPuzzleAttempted" check) |
| `review_cards` | (Future) server-side mirror of localStorage review cards. Currently localStorage-only |
| `friendships` | Bidirectional with reverse-pair dedup trigger |
| `coach_calls` | One row per successful AI coach call. Powers per-user rate limit (3 calls / 5 min) |

### Client-side (localStorage)

Cards + drill sets + puzzle history live in `localStorage`. The deck is a local-first Anki experience that syncs nothing server-side. Schedules persist across reloads via `getSchedule()` which migrates pre-Anki shapes transparently.

| Key | Data |
|---|---|
| `ochess_review_cards` | Saved review cards (puzzles, mistakes, analysis, shared) |
| `ochess_review_schedule` | SM-2 schedule per card id |
| `ochess_drill_sets` | Named persistent filter sets (e.g. "Hanging queens") |
| `ochess_puzzle_rating` | Glicko-1 puzzle rating |
| `ochess_puzzle_history` | Recent puzzle results (drives "no recent repeat" picker) |
| `ochess_puzzle_streak` | Current and best streak |
| `ochess_puzzle_settings` | Timer, auto-advance, prefs |
| `ochess_board_prefs` | Board theme + piece set |
| `ochess_saved_analysis` | Up to 5 saved analysis boards |
| `ochess_active_game` | In-progress bot game (PGN, opponent, clocks, chat) |
| `ochess_guest_session` | "Play as Guest" flag |
| `ochess_import_throttle` | Per-source import call timestamps (rolling-hour cap) |

## Anti-cheat

- **Live-play engine lock** - `lockEval()` is called when `GameScreen` / `OnlineGameScreen` mount. `evaluate()` returns null while locked. Unlocked on game end + post-game analysis.
- **Realtime broadcast verification** - resign / draw_accept / game_over broadcasts are NOT trusted on receipt. The handler refetches the games row and only terminates locally if the DB shows `status = 'completed'`. Forged broadcasts from anon-key actors get ignored.
- **DB-side glicko2_update** - rating changes happen inside a SECURITY DEFINER RPC that validates participants + game state. Idempotent on repeated calls.

## Variant system

`lib/variants.js` exports a single factory `createVariantGame(variantId, opts)` that wraps chess.js with extra rules. The wrapper exposes the chess.js surface so `OnlineGameScreen` and `VariantGameScreen` use one code path for all 21 variants.

| Variant | Notes |
|---|---|
| standard | No-op shell over chess.js so all online games go through the wrapper |
| chess960 / Fischer Random | Random back rank, deterministic from `gameData.id` so both online clients see the same start |
| kingOfTheHill | Win by getting your king to d4/d5/e4/e5 |
| threeCheck | Win by checking three times. State counter resets on `loadPgn` (documented degradation) |
| antichess | Forced capture + no king (lose all pieces or be unable to move = win) |
| atomic | Captures explode 8-square perimeter. NOT online-supported (chess.js doesn't replay explosions on `loadPgn`) |
| racingKings | First king to rank 8 wins |
| horde | White all pawns vs black standard. White wins by capturing the black king; black wins by killing all white pawns |
| fogOfWar | FEN masking - opponent pieces only visible if attacked or adjacent |
| rifle / circe | Capture-then-rebound mechanics. Bot-only |
| monster / marseillais / progressive | Multi-move turns |
| extinction | Lose any piece type = lose the game |
| dunsanys / peasants / weakArmy | Asymmetric setups |
| noCastling / torpedo / checkless | Rule-modifier shells |

`ONLINE_SUPPORTED_VARIANTS` and `BOT_SUPPORTED_VARIANTS` Set exports gate the UI; variants outside those sets either degrade gracefully (chat-only, no live opponent) or hide the relevant flow entirely.

## Anki review surface

The Anki state machine in `lib/review-engine.js` is a faithful Anki SM-2 implementation:

```
NEW ─Good→ LEARNING (1m → 10m → graduate)
        └─Easy→ REVIEW (4d immediately)

REVIEW ─Again→ RELEARNING (10m), lapseCount++, ease −0.20
       ─Hard → interval × 1.2, ease −0.15
       ─Good → interval × ease, ease unchanged
       ─Easy → interval × ease × 1.3, ease +0.15

RELEARNING ─Again→ restart at step 0
           ─Good → graduate back to REVIEW (interval × 30%)
           ─Easy → graduate immediately
```

Plus interval fuzz (Anki bands: ±15% / ±5% / ±2.5%), min ease 1.3, 5-year interval cap, 21-day mature threshold. `predictNextIntervals()` simulates each rating without mutating the schedule for the "Again 1m / Good 1d / Easy 4d" UI hints.

`summarizeSchedule()` and `forecastNextDays()` power the queue breakdown widget and 7-day forecast bar chart in the review sidebar.

## File structure (current)

```
ochess-app/
  src/
    main.jsx                  # Entry: initMonitoring() then mount
    App.jsx                   # Router shell + AuthProvider + ErrorBoundary
    index.css                 # Tailwind v4 + design tokens + custom cursor
    components/
      AuthModal.jsx           # Email + Google + Guest signin
      AuthProvider.jsx        # Supabase session bootstrap + identify(monitoring)
      Avatar.jsx              # Avatar img + initials fallback
      AnalysisPage.jsx        # Analysis board + Stockfish + AI coach modal
      BoardStylePicker.jsx    # Board theme + piece set + sound prefs
      BotsPage.jsx            # Bot browser
      ChessBoard.jsx          # Display-only board (landing cycling)
      ChallengePage.jsx       # Direct-link challenge join
      ComingSoon.jsx          # Placeholder for unbuilt routes (Study, 404)
      CreateChallenge.jsx     # Challenge creation: variant + time control
      CustomCursor.jsx        # Custom 8px dot
      Dashboard.jsx           # Greeting + daily puzzle + stats
      ErrorBoundary.jsx       # Top-level boundary, forwards to Sentry
      Footer.jsx              # Footer + legal links
      GameScreen.jsx          # Live bot game (chess.js + bot-engine)
      InteractiveBoard.jsx    # react-chessboard wrapper
      JoinChallenge.jsx       # Challenge code entry
      LandingPage.jsx         # Homepage
      LegalPage.jsx           # Privacy / Terms / Attribution
      LivePulse.jsx           # Online count pulse
      LoadingScreen.jsx       # Suspense fallback for lazy routes
      Navbar.jsx              # Nav + auth-aware
      OnlineGameScreen.jsx    # Live online play (chess.js + variants + Realtime)
      PlayPage.jsx            # Matchmaking + bot setup + time controls
      Profile.jsx             # Profile editor + ratings + recent games
      PublicProfile.jsx       # Public-view profile by /u/:username
      PuzzlesPage.jsx         # Adaptive puzzle trainer
      ReviewPage.jsx          # Anki review (multi-move play + state pills + forecast)
      SocialPanel.jsx         # Friends rail (Realtime-subscribed)
      StudyPage.jsx           # ComingSoon shell (repertoire, future)
      StudyPlanPanel.jsx      # AI coach + drill sets + game-import + Stockfish mistake analysis
      VariantGameScreen.jsx   # Local variant play (vs human or bot)
      VariantsPage.jsx        # Variant catalog + friend-match CTAs
    lib/
      auth.js                 # Supabase auth helpers + uploadAvatar
      bot-chat.js             # Bot personality chat lines
      bot-engine.js           # Unified bot dispatch (random / jce / Stockfish)
      card-types.js           # Card-type registry (puzzle / mistake / analysis / shared / ...)
      challenges.js           # Challenge create/accept/claim helpers
      coach-llm.js            # Client wrapper for the coach Edge Function
      drill-sets.js           # Persistent named filter sets for the Plan tab
      engine.js               # Stockfish WASM (evaluate / lock / unlock)
      friends.js              # Friend search/add/accept/remove + realtime
      game-import.js          # chess.com + Lichess game pulls + per-source throttle
      glicko2.js              # Glicko-2 implementation (used by Postgres RPC + tests)
      jce-worker.js           # Web Worker for js-chess-engine
      log.js                  # Debug-gated logger (VITE_DEBUG)
      monitoring.js           # Sentry + PostHog wrappers (env-gated)
      move-classify.js        # Brilliant / great / mistake / blunder per ply
      online-game.js          # Realtime channel + RPC helpers (claim_seek, accept_challenge, ...)
      openings.js             # Opening name lookup
      puzzles.js              # CSV streaming + Glicko-1 rating + adaptive picker
      puzzle-sync.js          # Server <-> client puzzle progress sync
      review-cards.js         # localStorage layer + sanitize + share encode/decode
      review-engine.js        # Anki SM-2 state machine
      sounds.js               # Audio pooling + per-event playback
      study-plan.js           # Stockfish-driven mistake detection from PGN
      supabase.js             # Supabase client (PKCE flow)
      variants.js             # 21 variant definitions + game wrapper
    hooks/
      useClock.js             # Chess clock (start / switch / stop / restore / format)
    e2e/
      smoke.spec.js           # Playwright e2e tests
    test/
      setup.js                # Vitest setup (Audio/Worker/ResizeObserver mocks)
  public/
    piece/                    # 38 piece sets (SVG)
    images/board/             # Board background images
    sound/                    # Sound effects (OGG/MP3)
    puzzledb/                 # Trimmed Lichess puzzle CSV (committed)
    flags/                    # Country flags
    openings.json             # 3,663 named openings
    stockfish.js              # Stockfish 18 WASM loader (committed)
    stockfish.wasm            # Stockfish 18 WASM binary (committed)
  scripts/
    build-openings.mjs        # Lichess TSV -> openings.json
    check-supabase.mjs        # Supabase project shape verification (15 checks)
    trim-puzzles.mjs          # Slim Lichess CSV down to ~1.8 MB
supabase/
  schema.sql                  # Canonical schema (idempotent, ~1100 lines)
  README.md                   # Apply runbook
  migrations/                 # Focused diffs for incremental updates
  functions/
    coach/                    # Groq LLM bridge with rate-limit gate
    cleanup-stale-seeks/      # Manual-invoke fallback (pg_cron handles regular runs)
docs/
  architecture.md             # This file
  data-model.md               # Schema field-by-field
  feature-spec.md             # Product feature matrix
  launch-checklist.md         # Operational deployment runbook
  mvp-roadmap.md              # Roadmap snapshot
  product-context.md          # Product positioning
  design-rules.md             # Visual + UX standards
```

## Online game flow (Realtime + Postgres)

`OnlineGameScreen.jsx` runs three concurrent subscriptions per game:

1. **Postgres changes** on the `games` row - the authoritative feed. Every move write triggers an UPDATE that propagates to both clients. `applyServerRow()` rebuilds the local board from the canonical PGN.
2. **Broadcast channel** - speed-of-light hint layer for moves, chat, draw / rematch offers, presence. Self-suppressed (sender doesn't receive own broadcasts). NOT authoritative - terminal events route through `verifyTermination()` which refetches the row.
3. **Presence** - opponent online indicator only. No game state.

Move flow:
1. Player validates locally via the variant wrapper (`gameRef.current.move(...)`).
2. Writes new PGN + clocks to the DB (authoritative).
3. Broadcasts the move (fast hint).
4. Opponent receives the broadcast - applies optimistically.
5. Opponent receives the postgres_changes update - confirms / corrects.
6. If broadcast missed (e.g. Realtime hiccup), the postgres feed still delivers.

Chat goes through both layers and dedupes against (fromId + text) to prevent doubling when broadcast and DB sync arrive in different orders.

The 30s auto-abort runs on both clients, anchored to `gameData.created_at` so a refresh by either player doesn't reset the window.

## AI coach pipeline

```
Browser
  StudyPlanPanel: collects mistakes from review cards
       ↓ slim payload (no FEN, max 30 mistakes, max 200-char query)
  callCoach() in coach-llm.js
       ↓ supabase.functions.invoke('coach')
       ↓
       │ 30s client timeout via Promise.race
       ↓
Edge Function (Deno)
  1. JWT gate (require Bearer auth)
  2. record_coach_call RPC: enforce 3 calls / 5 min per user.
     Blocked attempts return 429 + retry_after_seconds; do NOT
     consume a slot.
  3. Build prompt from mistakes + filter vocabulary
  4. Call Groq (Llama 3.3 70B, fall back to 3.1 8B)
  5. Parse + sanitize JSON response
       ↓
  Returns { summary, plan: [{ day, focus, query, ... }], insights, rate_limit }
       ↓
StudyPlanPanel renders:
  - Plan day cards with Practice now / Save as drill buttons
  - Per-mistake notes (insights)
  - Cooldown banner if rate-limited
```

## Test surface

`npx vitest run` covers (numbers as of `a5cf923`):
- **496** unit tests across **57** files
- Major modules: review-engine, review-cards, drill-sets, study-plan, variants, monitoring, coach-llm, online-game, game-import, friends, challenges, puzzles, glicko2
- Component smoke tests: ReviewPage, OnlineGameScreen, AuthProvider, AuthModal, Profile, AnalysisPage, ChallengePage, Dashboard, GameScreen, JoinChallenge, LegalPage, Navbar, etc.

`npm run e2e` runs **15 Playwright** smoke tests across desktop + mobile viewports for landing / guest mode / bot game / puzzles / analysis / public profile.

`npm run check:supabase` verifies the live Supabase project has all expected tables, RPCs, the `avatars` bucket, and Realtime connectivity (15 checks).
