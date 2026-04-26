# oChess — MVP Roadmap

## MVP definition

The MVP proves the product shape is right: chess-first design, strong post-game loop architecture, built-in Review system, AI coach interface, and a premium dark UI.

---

## Phase 1: Foundation — COMPLETE

1. **Main page** — Minimal, board-first landing with clear CTAs, cycling board showcase
2. **App shell and navigation** — Proper routing, Navbar with all sections including Review
3. **Auth basics** — UI shell + guest mode (backend OAuth deferred)
4. **Custom cursor** — 8px dot, mix-blend-mode: difference, interactive scaling
5. **Docs** — product-context, feature-spec, architecture, data-model, design-rules, mvp-roadmap
6. **Design system** — Tailwind v4 config, color palette, typography, component patterns

## Phase 2: Core shells — COMPLETE

7. **Play page** — vs Humans/Bots tabs, time control grid, saved game resume
8. **Game screen** — Board-first live game with player bars, clocks, move list, chat
9. **Analysis board** — Full analysis + board editor + engine panel
10. **Puzzles** — Adaptive trainer with rating, streaks, timer, AI explanation
11. **Review section** — SM-2 engine + UI shell
12. **Profile shell** — Basic layout
13. **Social panel** — Friends sidebar pinned to right on all pages

## Phase 3: Chess logic — COMPLETE

14. **chess.js integration** — Move validation, board state, PGN/FEN support
15. **Interactive board** — Drag/drop, click-to-move, premove, legal move dots, illegal move flash
16. **Stockfish WASM** — Browser-side engine for analysis + strong bots
17. **js-chess-engine** — Web Worker-based weak bots (levels 1–3)
18. **Bot play** — 8 levels, proper engine config, thinking delay, chat, error handling
19. **Opening database** — 3,663 openings from Lichess, local JSON lookup
20. **Puzzle system** — Glicko-1 rating, adaptive selection, timer bonuses, streaks

## Phase 4: Polish & robustness — COMPLETE

21. **Game persistence** — Auto-save to localStorage, resume on reload
22. **Clock management** — Full chess clock hook with increment, restore, low-time warning
23. **Post-game eval** — Move-by-move Stockfish analysis, adjustable depth, eval bar
24. **Anti-cheat** — Engine locked during live play, unlocked post-game
25. **Error handling** — Fatal error overlay with codes, no silent fallback
26. **PGN export** — Proper headers (Event, Date, White, Black, Result, TimeControl)
27. **Sound system** — Audio pooling, all game events, preload
28. **Board customization** — 38 piece sets, multiple board themes, persisted preferences
29. **Analysis board editor** — Piece placement with cursor feedback, FEN sync, turn selector
30. **Analysis board saves** — Up to 5 boards saved to localStorage
31. **Opening wiki** — External links to Lichess/Wikipedia for current opening

## Phase 5: Testing & CI — COMPLETE

32. **Vitest setup** — jsdom environment, @testing-library/react, mock Audio/Worker/ResizeObserver
33. **Unit tests** — review-engine, bot-chat, engine, puzzles, bot-engine, useClock (pure logic)
34. **Component smoke tests** — GameScreen, PlayPage, AnalysisPage, PuzzlesPage, LandingPage (render without crashes)
35. **CI/CD** — GitHub Actions workflow: install → build → test on push/PR

---

## Phase 6: Backend — NOT STARTED

36. **Database setup** — PostgreSQL + Prisma, core models from data-model.md
37. **Auth implementation** — Auth.js with Google OAuth
38. **Game persistence** — Server-side game storage (PGN)
39. **Rating system** — Glicko-2 rating calculations
40. **User profiles** — Backend data, public profiles

## Phase 7: Real-time — NOT STARTED

41. **WebSocket server** — Connection management, rooms
42. **Live game sessions** — Move broadcast, clock sync, server-side validation
43. **Matchmaking** — Queue system, pairing algorithm
44. **Lobby system** — Private lobbies, invite codes

## Phase 8: Intelligence — PARTIAL

45. **AI coach integration** — Interface implemented, needs full LLM provider
46. **Post-game analysis flow** — Engine eval done, needs coach explanations for mistakes
47. **Puzzle generation** — Generate puzzles from game mistakes (not started)
48. **Review card auto-generation** — Cards from game analysis, puzzle failures, coach explanations (not started)
49. **Weakness-to-deck prompt flow** — User can prompt for motif training ("I keep missing forks"), system generates legal Anki-style cards and schedules them via SM-2 (not started)
50. **Weakness detection service** — Aggregate repeated motif mistakes from games/puzzles into actionable tags and trigger suggestions (not started)
51. **Card validation pipeline** — Enforce legality and schema checks on generated cards before deck insertion (not started)
52. **Game library import** — Bulk import all games from Lichess/Chess.com via public API, feed into analysis + Review pipeline, detect cross-game weaknesses, incremental sync (not started)

## Phase 9: Review system completion — PARTIAL

53. **SM-2 scheduling** — DONE (lib/review-engine.js)
54. **Card types** — Position recall, move prediction, concept, opening line, tactic (data model defined, UI not built)
55. **Deck management** — Create, browse, organize decks (not started)
56. **Daily review flow** — Queue of due cards, review interface (not started)
57. **Card creation** — Manual from analysis board (integration point exists), auto from games (not started)

## Phase 10: Social & variants — NOT STARTED

58. **Collaborative analysis** — Real-time shared analysis rooms
59. **Friends and chat** — Friend requests, direct messages, in-game chat
60. **Variant support** — Chess960, Crazyhouse, other preset variants (playable)
61. **Study system** — Full study tree with chapters and annotations

---

## What exists now vs. what's planned

| Feature | Current state | What's needed |
|---------|--------------|---------------|
| Bot play | Fully working (8 levels, clocks, premove, eval, save/resume) | — |
| Puzzles | Fully working (adaptive, rated, timed, streaks, coach) | — |
| Analysis | Fully working (engine, editor, save/load, wiki, FEN/PGN) | — |
| Review engine | SM-2 scheduling implemented | Card UI, deck browser, daily queue |
| Online play | UI shell only | Backend + WebSocket server |
| AI coach | Interface + templates | Full LLM integration |
| Auth | UI shell | Backend OAuth |
| Profiles | UI shell | Backend data |
| Variants | Shell + definitions | Playable variant games |
| Study | Shell | Full study tree |
