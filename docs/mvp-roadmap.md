# oChess — MVP Roadmap

## MVP definition

The MVP proves the product shape is right: chess-first design, strong post-game loop architecture, built-in Review system, AI coach interface, and a premium dark UI. Not every feature is fully functional — but the architecture supports everything and the UI shows the product vision clearly.

---

## Phase 1: Foundation (current)

1. **Main page** — Minimal, board-first landing with clear CTAs
2. **App shell and navigation** — Proper routing, Navbar with all sections including Review
3. **Auth basics** — Google OAuth + guest session (UI shell, backend later)
4. **Custom cursor** — Already implemented

## Phase 2: Core shells

5. **Play page shell** — Time control selection, seek flow, board layout
6. **Game screen layout** — Board-first live game screen (player info, clocks, moves, chat toggle)
7. **Analysis board shell** — Board + engine eval panel + AI coach panel + move list
8. **Puzzles shell** — Board + puzzle controls + progress tracking
9. **Review section shell** — Due cards, deck browser, card review interface
10. **Profile shell** — Ratings, stats, game history

## Phase 3: Chess logic

11. **chess.js integration** — Move validation, board state, PGN support
12. **Interactive board** — Drag/drop and click-to-move
13. **Stockfish WASM** — Browser-side engine analysis
14. **Bot play** — Local games against Stockfish at various depths

## Phase 4: Backend

15. **Database setup** — PostgreSQL + Prisma, core models
16. **Auth implementation** — Auth.js with Google OAuth
17. **Game persistence** — Save completed games
18. **Rating system** — Glicko-2 rating calculations

## Phase 5: Real-time

19. **WebSocket server** — Connection management, rooms
20. **Live game sessions** — Move broadcast, clock sync
21. **Matchmaking** — Queue system, pairing algorithm
22. **Lobby system** — Private lobbies, invite codes

## Phase 6: Intelligence

23. **AI coach integration** — LLM-powered explanations via coach interface
24. **Post-game analysis flow** — Mistake identification, turning points
25. **Puzzle generation** — Generate puzzles from game mistakes
26. **Review card auto-generation** — Cards from game analysis, puzzle failures, coach explanations

## Phase 7: Review system

27. **SM-2 scheduling** — Full spaced repetition algorithm
28. **Card types** — Position recall, move prediction, concept, opening line, tactic
29. **Deck management** — Create, browse, organize decks
30. **Daily review flow** — Queue of due cards, review interface
31. **Card creation** — Manual card creation from analysis board

## Phase 8: Social & variants

32. **Collaborative analysis** — Real-time shared analysis rooms
33. **Friends and chat** — Friend requests, direct messages, in-game chat
34. **Variant support** — Chess960, Crazyhouse, other preset variants
35. **Study system** — Full study tree with chapters and annotations

---

## What to stub now, build later

| Feature | Now | Later |
|---------|-----|-------|
| Auth | UI shell + guest mode | Backend + OAuth |
| Chess moves | Static board display | chess.js interactive |
| Engine | Fake eval in UI | Stockfish WASM |
| AI coach | Static example text | LLM integration |
| Review | UI shell + scheduling interface | Full SRS + card generation |
| Real-time | Fake seeking animation | WebSocket server |
| Ratings | Static display | Glicko-2 calculation |
| Puzzles | Static board | Interactive from puzzle DB |
| Variants | List + descriptions | Variant engine abstraction |

## Priorities for this session

1. Docs ✓
2. Clean app structure with routing
3. Review page in navigation
4. Rebuilt minimal landing page
5. Lib stubs for review engine, coach, variants
6. Everything builds and runs
