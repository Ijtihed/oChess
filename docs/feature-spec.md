# oChess — Feature Spec

Status key: **DONE** = fully implemented, **PARTIAL** = core working but incomplete, **SHELL** = UI exists but placeholder, **PLANNED** = not yet started

---

## Play against bots — DONE

- 8 difficulty levels (0–7): Random, Rookie, Patzer, Club, Expert, Master, Grandmaster, Stockfish
- Levels 0: random legal moves
- Levels 1–3: js-chess-engine in Web Worker (natural weak play)
- Levels 4–7: Stockfish WASM with UCI_Elo limiting
- Bot chat: static personality lines per level (capture, check, mate, takeback)
- Time controls: Bullet (1+0), Blitz (3+0, 3+2, 5+0, 5+3), Rapid (10+0, 10+5, 15+10), Classical (30+0), Unlimited
- Game resume: auto-saves to localStorage after each move, resume prompt on play page
- Draw offer, abort, takeback (with bot response)
- Clock management: full chess clock with increment, low-time warning sound at 30s
- Premove: queue one move during opponent's turn, executed after bot responds
- Post-game analysis: move-by-move engine evaluation, adjustable depth
- Opening name display (from local Lichess database, 3,663 openings)
- Opening wiki with external links to Lichess/Wikipedia
- PGN export with proper headers (Event, Date, White, Black, Result, TimeControl)
- Captured pieces with material advantage display
- Eval bar (post-game only, locked during live play)
- Fatal error overlay with error codes if engine crashes
- Bot thinking indicator (spinner)
- Move list: reversed during live play (newest on top), chronological in analysis
- Keyboard navigation: arrow keys for move review

## Puzzles — DONE

- Large puzzle bank (Lichess DB CSV, ~50k puzzles, streamed)
- Glicko-1 adaptive rating system (rating, RD, game count, persisted to localStorage)
- Adaptive puzzle selection: picks near player rating, no recent repeats, bias slightly upward
- Timer options: Off, 15s (+30% bonus), 30s (+20%), 60s (+10%), Infinite
- Auto-advance toggle (instant skip on correct answer)
- Streak tracking (current + best, persisted)
- 2-mistake limit per puzzle (fail after 2 wrong attempts)
- Reveal best move after failure
- AI coach explanation after each puzzle
- Legal move highlighting, illegal move flash (red)
- Sound effects for moves, captures, check, victory, failure
- Hint system (progressive: verbal → highlight → show move)
- Direct puzzle links by ID (`/puzzles/:id`)
- Last 3 setup moves shown before puzzle starts
- Puzzle rating and player rating displayed separately
- Timer bonus/penalty affects rating change
- Settings persisted to localStorage

## Analysis board — DONE

- Free play: both sides can make any legal move
- Engine evaluation: Stockfish WASM, adjustable depth (10, 14, 18, 22, 26, 30)
- Engine toggle on/off, PV line display, best move highlighting (green squares)
- Board editor: click-to-place pieces with visual cursor feedback (floating piece follows mouse)
- Piece palette with selected piece indicator in header
- Editor eraser mode
- Turn selector (white/black to move)
- Start/Clear/custom position buttons
- FEN input/output with copy button
- PGN import/export with copy confirmation
- Move list with clickable plies, current ply highlighting
- Opening name lookup (auto-updates as moves are played)
- Opening wiki section with external links
- Material count bars above/below board
- Vertical eval bar with dynamic coloring and label
- Keyboard navigation: arrows, Home/End, Delete/Backspace
- Save/load up to 5 analysis boards (localStorage)
- "+ Review" button to add position to Anki deck
- No footer on analysis page (cleaner layout)

## Landing page — DONE

- Minimal, board-first design with cycling board/piece-set showcase
- oChess branding with tagline
- Clear CTAs: Play Online, Play Bot, Puzzles, Analysis
- Live player count pulse (decorative)
- Responsive layout

## Play page — DONE

- vs Humans tab (online play coming soon placeholder)
- vs Bots tab with full bot browser
- Time control grid selector
- Rated/Casual toggle
- Custom time control input (minimum 1+0)
- Challenge a friend (friend list with scroll)
- Saved game resume banner (Game in progress → Resume / Abandon)
- Bot rating and description display

## Navigation & app shell — DONE

- Top navbar with all sections: Play, Puzzles, Analysis, Bots, Variants, Review, Profile
- Auth modal shell (Google OAuth placeholder)
- Custom cursor (8px white dot, mix-blend-mode: difference, scales on interactive elements)
- Global loading screen (covers everything, dark semi-transparent overlay)
- Friends/Social panel pinned to right edge on all pages
- Responsive layout with mobile considerations

## Review (spaced repetition) — PARTIAL

- SM-2 scheduling engine fully implemented (`lib/review-engine.js`)
- createScheduleState, computeNextReview (Again/Hard/Good/Easy), isDue
- Ease factor management, lapse tracking, interval calculation
- UI shell exists (ReviewPage.jsx)
- "+ Review" integration on analysis board
- **Not yet built:** Full card management UI, deck browser, daily review queue, auto-generation from games

## Bot chat — DONE

- Static personality lines per level (0–5), no chat for levels 6+
- Lines for: normal move, capture, check, mate, takeback
- Distinct personalities: level 0 (chaotic), level 1 (uncertain), level 2 (competitive), level 3 (analytical), level 4 (terse), level 5 (minimal)
- Custom bot API key integration planned for user-created bots

## Sound system — DONE

- HTML5 Audio API with pooling for reliable concurrent playback
- Events: move, capture, check, castle, promote, game start, victory, defeat, draw, low time, error
- OGG/MP3 fallback, Lichess sound assets
- Global volume control
- Preload on page mount

## Board customization — DONE

- 38 piece sets (SVG)
- Multiple board themes (color-based and image-based)
- Board style picker (side-by-side boards and pieces)
- Reset to defaults
- Persisted to localStorage
- Responsive board sizing (clamp-based)
- Dark grey board coordinates (no orange hue)

---

## Fast online play — SHELL

- UI exists (time control selector, seek flow)
- Backend WebSocket server not yet built
- Matchmaking not yet implemented

## AI coach — PARTIAL

- `explainMove()` and `evaluatePosition()` interfaces implemented
- Used in puzzles (post-solve explanation) and analysis (move explanation)
- Currently uses templated explanations, not full LLM
- Interface designed for future provider swap (cloud LLM, local Ollama)

## Study boards — SHELL

- Nav entry exists
- No interactive study tree yet

## Variants — SHELL

- Variant definitions file exists (`lib/variants.js`)
- Nav entry exists, variant list displayed
- No playable variant games yet

## Profiles — SHELL

- Profile page shell exists
- No backend data yet

## Collaborative analysis — PLANNED

- Architecture designed (WebSocket rooms, cursor presence)
- No implementation yet

## Duel challenges — PLANNED

- Credit ledger data model defined
- No implementation yet

---

## Post-game flow (core differentiator)

Currently implemented for bot games:
1. Result display (win/loss/draw + reason)
2. Move list with ply-by-ply navigation
3. Engine evaluation per position (Stockfish, adjustable depth)
4. Eval bar that updates on move navigation
5. Opening name display with wiki links
6. PGN export with full headers
7. "+ Review" to save positions to Anki deck

**Not yet built:** AI coach explanations for specific mistakes, puzzle generation from game positions, auto-generated review cards from blunders.
