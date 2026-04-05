# oChess — Architecture

## Current stack (implemented)

- **Frontend:** Vite 8 + React 19 + Tailwind CSS v4 (SPA)
- **Language:** JSX (TypeScript migration planned)
- **Routing:** react-router-dom v7
- **Chess logic:** chess.js v1.4 — move validation, game state, PGN read/write, FEN, check/checkmate detection
- **Board UI:** react-chessboard v5 — interactive board with drag-and-drop, click-to-move, custom piece sets, premove support
- **Board display:** Custom `ChessBoard.jsx` — display-only showcase board (landing page cycling)
- **Bot engines:**
  - **js-chess-engine** — Levels 0–3 (weak/natural play), runs in a Web Worker (`jce-worker.js`) to prevent UI freezing
  - **Stockfish 18 WASM** — Levels 4–7 (Expert through full engine), runs in a Web Worker via `/stockfish.js`, UCI protocol with `UCI_LimitStrength` and `UCI_Elo`
- **Analysis engine:** Stockfish 18 WASM — separate worker for position evaluation, locked during live play (anti-cheat), unlocked for post-game and analysis
- **Opening database:** 3,663 named openings from Lichess `chess-openings` repo, compiled into `/openings.json`, keyed by UCI move sequence for instant lookup
- **Puzzle database:** Lichess puzzle CSV (~50k puzzles), streamed and parsed on demand
- **Sound:** HTML5 Audio API with pooling, OGG/MP3 fallback (Lichess sound assets)
- **Fonts:** Manrope (headlines), Inter (body)
- **Assets:** 38 piece sets (SVG), sound packs, puzzle CSV, board background images (Lichess-sourced, attributed), country flags
- **Testing:** Vitest + @testing-library/react + jsdom — 61 tests across 10 files
- **CI/CD:** GitHub Actions — build + test on push/PR to main

## Client-side persistence (localStorage)

Until a backend is built, all user data lives in `localStorage`:

| Key | Data |
|-----|------|
| `ochess_active_game` | In-progress bot game (PGN, opponent, color, clock state, time control, chat) |
| `ochess_puzzle_rating` | Glicko-1 puzzle rating (rating, RD, games count) |
| `ochess_puzzle_history` | Recent puzzle results |
| `ochess_puzzle_streak` | Current and best puzzle streak |
| `ochess_puzzle_settings` | Timer, auto-advance, preferences |
| `ochess_board_prefs` | Board theme and piece set selection |
| `ochess_saved_analysis` | Up to 5 saved analysis boards (FEN, PGN, ply, opening name) |

## Planned additions

- **State management:** Zustand (when global state is needed beyond component-level)
- **Backend:** Separate API service (Node.js — decision deferred)
- **Database:** PostgreSQL + Prisma ORM
- **Auth:** Auth.js with Google OAuth + guest session identity
- **Real-time:** WebSocket server for live play and collaborative analysis
- **Cache:** Redis only if actually useful (not on day one)

## Chess libraries — what does what

**chess.js** handles all game logic:
- Move validation, game state (turn, castling, en passant, check, checkmate, stalemate, draw detection)
- PGN generation/parsing, FEN generation, move history traversal
- Used by both bot engines and the analysis page for position management

**react-chessboard** handles board interaction:
- Renders board + pieces (SVG), drag-and-drop + click-to-move
- Board orientation, custom piece images (38 sets), custom square colors/styles
- Move highlighting, legal move indicators, premove highlighting
- Integrates with chess.js — feed it FEN, it renders; user moves, chess.js validates

**js-chess-engine** handles weak bot play (levels 1–3):
- Runs in a Web Worker to avoid blocking the UI thread
- Produces more natural weak play than Stockfish at low settings
- Levels map to jce difficulty 0, 1, 3

**Stockfish WASM** handles strong bot play (levels 4–7) and all analysis:
- UCI protocol with configurable `UCI_Elo` for skill-limited play
- Separate instances for bot moves and analysis evaluation
- Analysis engine has a lock mechanism — locked during live games, unlocked for post-game review and analysis board

## Key abstraction layers

### Bot engine (`lib/bot-engine.js`)
Unified interface for all bot difficulty levels. Maps level 0–7 to the appropriate engine:
- Level 0: Random legal moves
- Levels 1–3: js-chess-engine (Web Worker)
- Levels 4–7: Stockfish WASM (Web Worker, UCI_Elo limited)

Throws specific errors (`BOT_ENGINE_CRASH`, `BOT_NO_MOVE`, `BOT_ILLEGAL_MOVE`) instead of silent fallback. GameScreen catches these and shows a fatal error overlay with debug info.

### Analysis engine (`lib/engine.js`)
Wraps Stockfish WASM for evaluation. Features:
- `evaluate(fen, depth)` — returns eval (cp/mate), best move, PV line
- `lockEval()` / `unlockEval()` — anti-cheat: prevents eval during live games
- `formatEval()` / `evalToText()` — human-readable formatting
- Handles concurrent requests with `stop` command, 30s timeout

### Review engine (`lib/review-engine.js`)
SM-2 spaced repetition scheduling, separated from UI and card content:
- `createScheduleState()`, `computeNextReview(schedule, rating)`, `isDue(schedule)`
- Ratings: Again (1), Hard (2), Good (3), Easy (4)
- Ease factor floor at 1.3, lapse tracking

### AI coach (`lib/coach.js`)
Interface for move explanations and position evaluation:
- `explainMove(fen, move)` — plain-language explanation
- `evaluatePosition(fen)` — engine eval wrapper
- Designed to support swappable providers (cloud LLM, local model)

### Opening lookup (`lib/openings.js`)
- Loads 3,663 openings from `/openings.json` (built from Lichess chess-openings repo)
- Lookup by UCI move sequence with longest-prefix matching
- Caches last known opening for incremental updates during play

### Puzzle system (`lib/puzzles.js`)
- Streams and parses Lichess CSV on demand
- Glicko-1 rating: tracks player rating, RD, game count
- Adaptive selection: picks puzzles near player rating with no recent repeats
- Timer bonuses/penalties affect rating changes

## File structure (current)

```
ochess-app/
  src/
    main.jsx                        # Entry point
    App.jsx                         # Root routing + app shell
    index.css                       # Tailwind v4 + global styles + custom cursor
    components/
      CustomCursor.jsx              # Custom 8px dot cursor with interactive detection
      Navbar.jsx                    # Top navigation
      Footer.jsx                    # App footer
      ChessBoard.jsx                # Display-only board (landing page cycling)
      InteractiveBoard.jsx          # Wrapper around react-chessboard (live play + puzzles)
      ActionCards.jsx               # Landing page action cards
      LivePulse.jsx                 # Fake online count pulse
      AuthModal.jsx                 # Auth dialog shell
      BoardStylePicker.jsx          # Board theme + piece set selector
      SocialPanel.jsx               # Friends/activity sidebar (reusable)
      LandingPage.jsx               # Homepage
      PlayPage.jsx                  # Game setup (vs humans/bots, time controls)
      GameScreen.jsx                # Live game (board, clocks, moves, chat, eval, premove)
      PuzzlesPage.jsx               # Puzzle trainer (adaptive, timed, streaks)
      AnalysisPage.jsx              # Analysis board + board editor + engine panel
      BotsPage.jsx                  # Bot browser
      ReviewPage.jsx                # Anki-style review shell
      ProfilePage.jsx               # Profile shell
    lib/
      review-engine.js              # SM-2 spaced repetition scheduling
      coach.js                      # AI coach (explainMove, evaluatePosition)
      engine.js                     # Stockfish WASM wrapper (eval, lock/unlock)
      bot-engine.js                 # Unified bot interface (random/jce/sf)
      bot-chat.js                   # Static personality chat lines per bot level
      jce-worker.js                 # Web Worker for js-chess-engine
      openings.js                   # Opening name lookup from local DB
      puzzles.js                    # Puzzle loading, Glicko-1 rating, adaptive selection
      sounds.js                     # Audio pooling, preload, per-event playback
      board-prefs.js                # Board theme/piece set preferences
      variants.js                   # Variant definitions (shell)
      game.js                       # Game session manager (shell)
    hooks/
      useClock.js                   # Chess clock hook (start, switch, stop, restore, format)
    test/
      setup.js                      # Vitest setup (Audio/Worker/ResizeObserver mocks)
  public/
    piece/                          # 38 piece set directories (SVG)
    images/board/                   # Board background images
    sound/                          # Sound effects (OGG/MP3)
    puzzledb/                       # Lichess puzzle CSV
    flags/                          # Country flags
    openings.json                   # 3,663 named openings (built from Lichess)
    stockfish.js                    # Stockfish 18 WASM loader
    stockfish.wasm                  # Stockfish 18 WASM binary
  scripts/
    build-openings.mjs              # Converts Lichess TSV → openings.json
  vitest.config.js                  # Test configuration
  package.json                      # Dependencies and scripts
```

## Game storage strategy

**Core principle: PGN is the single source of truth.**

### During a live bot game (in memory + localStorage)
1. Player makes a move → chess.js validates → board updates
2. After each move, full game state is auto-saved to `localStorage` (PGN, opponent, clock state, chat)
3. On page reload, game can be resumed from saved state
4. Clock state is preserved and restored via `useClock.restore()`

### When game ends
1. Saved game is cleared from `localStorage`
2. Post-game analysis available: move-by-move engine evaluation
3. (Future: persist to backend DB)

### Online play (planned)
1. WebSocket-based move broadcast + server-side validation
2. Zero DB writes during gameplay — all in server RAM
3. One PGN write when game ends

## Anti-cheat (current)

- **Engine lock during live play:** `lockEval()` called when GameScreen mounts, `unlockEval()` on game end or unmount. The `evaluate()` function returns `null` when locked. Prevents client-side engine assistance during bot games.
- **Future:** Report system, moderation, anti-engine analysis pipeline, titled player verification.
