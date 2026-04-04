# oChess — Architecture

## Current stack

- **Frontend:** Vite 8 + React 19 + Tailwind CSS v4 (SPA)
- **Language:** JSX (TypeScript migration planned)
- **Routing:** react-router-dom
- **Chess logic:** chess.js — move validation, game state, PGN read/write, FEN, check/checkmate detection
- **Board UI:** react-chessboard — interactive board with drag-and-drop, click-to-move, custom piece sets
- **Board display:** Custom `ChessBoard.jsx` — display-only showcase board (landing page cycling)
- **Fonts:** Manrope (headlines), Inter (body)
- **Assets:** 38 piece sets (SVG), sound packs, puzzle CSV, board background images (Lichess-sourced, attributed)

## Planned additions

- **Engine:** Stockfish WASM (browser-side for analysis)
- **State management:** Zustand (when global state is needed beyond component-level)
- **Backend:** Separate API service (Node.js or Next.js API routes — decision deferred)
- **Database:** PostgreSQL + Prisma ORM
- **Auth:** Auth.js with Google OAuth + guest session identity
- **Real-time:** WebSocket server for live play and collaborative analysis
- **Cache:** Redis only if actually useful (not on day one)

## Chess libraries — what does what

**chess.js** handles all game logic:
- Move validation (is this move legal?)
- Game state (whose turn, castling rights, en passant, check, checkmate, stalemate, draw)
- PGN generation and parsing (load a game from PGN, export to PGN)
- FEN generation (snapshot any position)
- Move history traversal

**react-chessboard** handles all board interaction:
- Renders the board and pieces (SVG)
- Drag-and-drop move input
- Click-to-move input
- Board orientation (flip)
- Custom piece images (we point it at our 38 piece set SVGs)
- Custom square colors/styles
- Move highlighting, legal move indicators
- Integrates with chess.js — feed it a FEN, it renders; user makes a move, chess.js validates

**Custom ChessBoard.jsx** (display only):
- Used on landing page for the cycling board/piece-set showcase
- No interaction — purely visual
- Stays as-is because it handles the unique cycling animation that react-chessboard doesn't need to do

## Architecture principles

1. **Frontend-first MVP** — Build the complete UI shell and interaction patterns before adding backend services.
2. **Interface-driven** — Key systems (coach, review engine, variant rules) are defined by interfaces, so implementations can be swapped later.
3. **Chess-native abstractions** — Don't force generic patterns onto chess-specific problems. FEN, PGN, move sequences are first-class data types.
4. **No overengineering** — Build what's needed now, stub what's needed later, skip what's speculative.

## Key abstraction layers

### Variant engine
Standard chess works through a variant abstraction so preset variants (Chess960, Crazyhouse, etc.) and eventually user-defined variants can be added without rewriting game logic.

```
VariantDefinition {
  id, name, description
  initialPosition: FEN or generator function
  moveValidator: (board, move) => boolean
  winCondition: (board) => result | null
  specialRules: object
}
```

Standard chess is just the default variant.

### AI coach
The coach layer is an interface, not a hardcoded API call. This allows swapping between:
- Cloud LLM (OpenAI, Anthropic, etc.)
- Local model (Ollama, llama.cpp)
- Mock/stub for development

```
CoachProvider {
  explainMove(fen, move, context) => explanation
  suggestPlan(fen, playerColor) => plan
  reviewGame(pgn) => gameReview
}
```

### Review engine (spaced repetition)
Scheduling logic is separated from card content and UI. The engine handles:
- When a card is due
- How to update intervals after a review
- Queue ordering (due cards first, then new cards)

```
ReviewEngine {
  getNextCard(deckId) => card | null
  getDueCount(deckId) => number
  submitReview(cardId, rating) => updatedSchedule
  createCard(content, source) => card
}
```

The default implementation uses SM-2 scheduling. Can be swapped for FSRS or custom algorithms later.

### Stockfish provider
Wraps Stockfish WASM for browser-side analysis. Clean interface for:
- Position evaluation (depth, multipv)
- Best move calculation
- Game analysis (batch all moves)

## File structure (current → planned)

```
ochess-app/
  src/
    main.jsx                    # Entry point
    App.jsx                     # Root component + routing
    index.css                   # Tailwind + global styles + custom cursor
    components/                 # Shared UI components
      CustomCursor.jsx
      Navbar.jsx
      Footer.jsx
      ChessBoard.jsx            # Board renderer (display only for now)
      ActionCards.jsx
      LivePulse.jsx
      AuthModal.jsx
    pages/                      # Page-level components (new)
      LandingPage.jsx
      Dashboard.jsx
      PlayPage.jsx
      PuzzlesPage.jsx
      AnalysisPage.jsx
      StudyPage.jsx
      BotsPage.jsx
      VariantsPage.jsx
      ReviewPage.jsx            # New: Anki-style review
      ProfilePage.jsx
    lib/                        # Core logic
      review-engine.js          # Spaced repetition scheduling (SM-2)
      coach.js                  # AI coach interface + mock provider
      variants.js               # Variant definitions
      game.js                   # Game session manager (chess.js wrapper)
    hooks/                      # Custom React hooks
  public/
    piece/                      # 38 piece set directories
    images/board/               # Board background images
    sound/                      # Sound effects
    puzzledb/                   # Puzzle database CSV
    flags/                      # Country flags
```

## Game storage strategy

**Core principle: PGN is the single source of truth. The DB is updated once, when the game ends.**

### During a live game (in memory + WebSocket)
1. Player makes a move → client validates with chess.js → sends to server via WebSocket
2. Server validates with chess.js (never trust client) → broadcasts to opponent
3. Move exists only in server memory + both clients' chess.js instances
4. Clock state tracked in server memory, synced via WebSocket
5. **Zero DB writes during gameplay** — all state is in RAM

### When game ends (one DB write)
1. Server generates PGN from the chess.js game instance (includes all moves, headers, result)
2. One `INSERT` into `Game` table: PGN (~2–5 KB text field), result, metadata
3. One `INSERT` per participant into `GameParticipant` (rating before/after)
4. Rating recalculation runs
5. Done — two or three rows total

### After game (async worker, optional)
- Parse PGN → run Stockfish eval on each position → populate `GameAnalysis`
- Classify opening (ECO code)
- Detect mistakes/blunders → generate Review cards
- This is async and non-blocking. User sees their game immediately.

### Why not a Move table?
A `Move` table with one row per ply stores ~200 bytes × 80 plies = ~16 KB of structured data per game, plus index overhead. PGN stores the same information in ~2–5 KB of plain text, in one field, in one row. chess.js can parse PGN back into any position in microseconds. The Move table adds write amplification (80 inserts per game instead of 1) for no benefit.

If we later need move-level search (e.g. "show all games where I played Nf3 on move 3"), the `GameAnalysis` table with JSONB handles it better than a flat Move table — and it's populated async, not during the game.

### Storage math
- 5 KB per game (generous upper bound)
- 10,000 games/day = 50 MB/day = ~18 GB/year
- 1 million total games = 5 GB
- Postgres handles this without blinking

## Real-time architecture (planned)

WebSocket connections for:
- Live game sessions (move broadcast, clock sync)
- Collaborative analysis rooms (cursor presence, shared moves)
- Matchmaking queue updates
- Chat messages

Protocol: JSON messages over WebSocket with message types:
- `game:move`, `game:clock`, `game:result`
- `analysis:cursor`, `analysis:move`, `analysis:chat`
- `lobby:seek`, `lobby:match`, `lobby:cancel`

### Game lifecycle over WebSocket
```
Client A                    Server                     Client B
   |--- seek:create ------->|                              |
   |                         |<------ seek:create ---------|
   |                         |--- matchmaking logic -------|
   |<-- game:start ----------|---------- game:start ------>|
   |                         |                              |
   |--- game:move (e2e4) -->|  (validates with chess.js)   |
   |                         |---------- game:move ------->|
   |<-- game:clock ----------|---------- game:clock ------>|
   |        ...              |           ...                |
   |--- game:resign ------->|                              |
   |<-- game:result ---------|---------- game:result ----->|
   |                         |                              |
   |                    [writes PGN + result to DB]         |
```

## Auth strategy

- **Registered users:** Google OAuth via Auth.js, stored in PostgreSQL
- **Guest users:** Client-side session identity (UUID), can play online and against bots, cannot save games permanently or have ratings
- **Upgrade path:** Guest → registered without losing in-progress game

## Anti-cheat (future)

Not built now, but the architecture leaves room for:
- Report system
- Moderation roles
- Anti-engine analysis pipeline
- Titled player verification
