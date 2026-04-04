# oChess — Feature Spec

## Core features

### Fast online play
- Rated and casual modes
- Multiple time controls: Bullet, Blitz, Rapid, Classical, Unlimited
- Quick play should be tiny and instant by default
- Expand options for: rated/casual, time control, variant, private lobby, AI credit stakes, invites

### Play against bots
- Multiple difficulty levels (beginner through Stockfish max)
- Bot personalities
- Random-move chaos bot

### Puzzles
- Large puzzle bank (50k+ from Lichess DB)
- Tactical themes (pins, forks, skewers, etc.)
- Puzzle rating system
- Daily progress tracking

### Analysis board
- Stockfish engine evaluation
- AI coach explanations (plain language, not just eval numbers)
- PGN import/export
- Move navigation
- Flip board
- Share analysis

### Study boards
- Interactive study trees with annotations
- Chapter-based organization
- PGN import
- Shared/collaborative editing

### Review (built-in spaced repetition)
See detailed spec below.

### AI coach
- Explains blunders in simple, plain language
- Feels like a calm human coach
- Customizable prompt presets (e.g., "Explain like I'm 800 rated", "Be brutally honest", "Focus on positional understanding")
- Designed behind an interface so it can support local models (Ollama) later

### Friends and chat
- Friend relationships
- In-game chat
- Chat in analysis rooms
- Does not dominate the interface

### Public profiles and rating history
- Rating across time controls
- Game history
- Statistics (win rate, games played, puzzles solved)

### Spectating
- Watch live games

### Personalized opening prep
- Opening recommendations based on your actual games
- Opening line review through the Review system

### Training paths based on mistakes
- Auto-generated training from game analysis
- Positions you got wrong become review material

### Duel challenges with AI credits
- Challenge friends or strangers
- AI credits as stakes
- Does not dominate UI, does not feel like gambling

### Crazy variants
- Preset: Chess960, Crazyhouse, Atomic, King of the Hill, Three-Check, Antichess, Horde, Racing Kings
- Custom start positions
- User-created variants (later)

---

## Review system (built-in spaced repetition) — detailed spec

This is a major moat. Not a generic flashcard clone — a chess-native memory system.

### What can become a card
- Blunder positions from your games
- Tactical patterns you missed
- Opening line branches
- Endgame technique positions
- Recurring strategic mistakes
- Coach explanations turned into memory prompts
- Puzzle positions you got wrong

### Card types
- **Position recall** — Show FEN, ask "What's the best move?"
- **Move prediction** — Show position after N moves, predict the continuation
- **Concept** — "Why is this position winning for white?" or "What's the plan here?"
- **Opening line** — Show position, play the correct line
- **Tactic** — Solve the tactical sequence
- **Endgame technique** — Execute the winning technique

### Scheduling
- SM-2 based algorithm (or similar proven SRS)
- Due dates, ease factors, intervals, repetition counts
- Ratings: Again / Hard / Good / Easy
- Lapse tracking

### Organization
- User-owned and system-generated decks
- Deck types: openings, tactics, endgame, strategy, mistakes
- Tags on cards
- Daily review goals

### Card generation
- Auto-generated from game analysis (blunders, missed tactics)
- Auto-generated from puzzle failures
- Manual creation from analysis board
- From coach explanations
- From study positions

### UX direction
- Feels like a natural extension of training
- Board-based recall, not just text cards
- Quick answer rating (Again / Hard / Good / Easy) — classy and minimal
- Daily Review page showing due positions
- Not a generic flashcard UI

### Flows to support
- After a game → add missed tactic to Review
- After analysis → save opening line to Review deck
- After coach explanation → convert summary into a memory card
- Daily Review page → work through due positions
- Manual card creation from any analysis board

---

## Post-game flow (core differentiator)

After a game ends, the user should see:
1. Result and rating change
2. Move list with turning points highlighted
3. Simple mistake explanations (AI coach)
4. "Recreate position" for key moments
5. "Generate puzzle from this position"
6. "Save to study"
7. "Add to Review deck"
8. "Generate flashcard from coach explanation"

This flow is not optional polish — it is the core product loop.

---

## Navigation structure

Main sections: Play, Puzzles, Analysis, Study, Bots, Variants, Review, Profile

Review is a first-class nav item, not hidden in settings or a submenu.
