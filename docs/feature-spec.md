# oChess - Feature Spec

Status key: **DONE** = fully implemented and tested. **OPT-IN** = code merged, requires external setup (env var / dashboard config). **COMING-SOON** = intentional placeholder per current product scope.

---

## Play against bots - DONE

- 8 difficulty levels (0-7): Random, Rookie, Patzer, Club, Expert, Master, Grandmaster, Stockfish.
- Levels 0: random legal moves; 1-3 js-chess-engine in a Web Worker; 4-7 Stockfish WASM with `UCI_LimitStrength` + `UCI_Elo`.
- Bot chat: static personality lines per level for capture / check / mate / takeback events.
- Time controls: Bullet (1+0), Blitz (3+0, 3+2, 5+0, 5+3), Rapid (10+0, 10+5, 15+10), Classical (30+0), Unlimited.
- Game resume: auto-saves to localStorage after each move; resume prompt on `/play`.
- Draw offer, abort, takeback (with bot response).
- Clock management: full chess clock with increment, low-time warning sound at 30s.
- Premove: queue one move during opponent's turn; executed after bot responds.
- Post-game analysis: move-by-move engine evaluation, adjustable depth.
- Opening name display from local 3,663-entry Lichess database.
- PGN export with proper headers.
- Captured-pieces display with material advantage.
- Eval bar (post-game only, locked during live play).
- Fatal error overlay with error codes if engine crashes.
- Move list, keyboard navigation, "+ Review" to add a position to the Anki deck.

## Online play - DONE

- Live matchmaking via the `seeks` table + `claim_seek` RPC. <5s match latency on the same server region.
- Direct-link friend challenges via the `challenges` table + `accept_challenge` RPC.
- Realtime move sync (broadcast hint + postgres_changes confirmation), clock state, presence, in-game chat.
- Full chess.js validation client-side; PGN is the single source of truth, written to the games row on every move.
- Resign / draw offer / draw accept / abort / 30s auto-abort.
- **Rematch flow** with both Cancel + Decline broadcasts so the opponent's banner clears instantly.
- 21 variant types (see Variants below). Online-supported subset: standard / antichess / kingOfTheHill / threeCheck / horde / racingKings / fogOfWar / chess960. **Chess960 starting positions are deterministic from the gameData.id** so both clients see the same back rank.
- Glicko-2 rating updates on completion via `glicko2_update` RPC, idempotent.
- Hard-refresh recovery: clocks reconcile from `last_move_at`, capped at 5 min so a stale row doesn't insta-time out.
- Post-game: rematch / new game / analyze / copy + download PGN / inline PGN viewer.
- Chat: 200-char cap, basic word filter, 500ms client throttle, dedup on broadcast vs DB sync arrival order.
- Connection-degraded banner if Realtime doesn't subscribe within 8s; moves still go via DB write path.
- Realtime broadcast verification: terminal events (resign / draw_accept / game_over) are NOT trusted on receipt - the handler refetches the games row before terminating locally.

## Puzzles - DONE

- Lichess puzzle DB trimmed to ~10k high-popularity puzzles (`public/puzzledb/puzzles.csv`), streamed at runtime.
- Glicko-1 adaptive rating system, persisted client-side and synced to `puzzle_progress` for signed-in users.
- Adaptive picker: avoids historically attempted puzzles (Tier 1) before falling back to recent-only avoidance (Tier 2) then pure random (Tier 3).
- Timer options: Off / 15s / 30s / 60s / Infinite, with rating bonuses for fast solves.
- Auto-advance toggle, streak tracking (current + best), 2-mistake limit, reveal best move on failure, AI coach explanation per puzzle.
- Direct puzzle links by ID (`/puzzles/:id`).
- "Save to Anki" on failed puzzles: persists the full remaining UCI line so review can replay it move-by-move.
- Per-puzzle attempt logging in `puzzle_attempts` for the cross-device repeat-avoidance check.

## Analysis board - DONE

- Free play: both sides can make any legal move.
- Stockfish evaluation, adjustable depth (10/14/18/22/26/30), engine on/off toggle, PV line display, best-move highlighting.
- Board editor: click-to-place pieces with floating-piece cursor feedback, eraser mode, turn selector, custom-position load.
- FEN + PGN import/export with copy + paste; PGN-from-URL import (Lichess + chess.com game links).
- Move list with clickable plies, keyboard navigation (arrows / Home / End / Delete), opening name lookup.
- Material count bars + vertical eval bar with color coding.
- Save/load up to 5 analysis boards in localStorage.
- "+ Review" button to add positions to the Anki deck.
- AI coach explanation modal per ply (uses the same Edge Function as the Plan-tab plan generator).

## Anki review system - DONE

The post-game improvement loop. Local-first; all state lives in `localStorage`.

- Real Anki state machine in `lib/review-engine.js`:
  - NEW -> LEARNING (1m, 10m steps) -> REVIEW
  - REVIEW -> RELEARNING on Again (10m), graduates back at 30% of pre-lapse interval
  - Per-rating ease deltas (Again -0.20, Hard -0.15, Good 0, Easy +0.15)
  - Anki-stock interval fuzz (±15% / ±5% / ±2.5% bands)
  - Min ease 1.3, 5y interval cap, 21d mature threshold
- **Multi-move play-out:** puzzles save the full UCI line; the user drags their move, opponent's reply auto-plays after 450ms, repeat until line completes, then rate.
- **Wrong moves don't lock the user out:** red flash + "Try again" banner, prompt stays interactive.
- **Predicted intervals on rating buttons** ("Again 1m / Hard 10m / Good 1d / Easy 4d") via `predictNextIntervals()`.
- **State pill** on every card (NEW / LEARNING / MATURE / YOUNG / RELEARNING) with its own tone palette.
- **Card-type chip** with type-specific prompt + sub-instruction (puzzles say "find the best move", mistakes say "what should you have played?", analysis says "recall the position", etc.).
- **Sidebar widgets**: CardMetadata (eval-loss bar, played-vs-engine SAN, theme chips, opening, source link), QueueBreakdown (Anki-style state counts), Forecast (7-day bar chart).
- **Deck filters** with live counts: All / Puzzles / Games / Analysis.
- **Card sharing** via `?import=<base64>` URLs. Recipient gets a fresh id + ts; dedup against existing deck.
- **Drill sets**: persistent named filter sets (e.g. "Hanging queens") - free-text query + chip filter, saved to localStorage. Shown above the ad-hoc filter so a returning user sees their saved drills first.

## AI Plan tab - DONE (OPT-IN: needs Groq API key)

The "what should I work on?" surface in `/review` -> Plan tab.

- **Game import** from chess.com (archive iteration) and Lichess (NDJSON streaming) by username. 5,000-game hard cap + per-source rolling-hour throttle of 8 imports.
- **Stockfish-driven mistake detection**: runs the engine on each user move at depth 12, flags positions where eval dropped >= 100cp from the user's POV. **Black-side detection works correctly** (a regression in earlier versions was sign-inverted).
- **Mate score handling**: missed mates / walked-into-mates dominate the eval-loss ordering instead of registering as 0cp.
- **Inline username editor** + **game count picker** (30 / 100 / 200 / 500 / 1000).
- **Cancel** with partial-progress save: stopping mid-analysis still keeps every mistake found so far.
- **Weakness profile**: phase counts (opening / middlegame / endgame) + top theme chips.
- **Drill chips**: Blunders >3 pawns / Hanging queens / Missed mates / Missed captures / Opening / Middlegame / Endgame.
- **Free-text drill** ("hanging queen middlegame") with AND-match against phase / themes / played_san / best_san / opening / source.
- **Today's plan**: 5 cards matching the current filter, sorted by oldest-first.

### AI Coach (OPT-IN: needs `GROQ_API_KEY` Supabase function secret)

- Edge Function `coach` calls Groq's free Llama 3.3 70B (fall back to 3.1 8B).
- Per-account rate limit: **3 calls per 5 minutes**, server-enforced via `record_coach_call` RPC. Blocked attempts return a structured 429 with `retry_after_seconds`; the client renders a countdown banner and disables the button.
- Returns `{ summary, plan: [{ day, focus, query, explanation, card_count }], insights, model, rate_limit }`.
- **Each plan day is actionable**: dedicated **Practice now** + **Save as drill** buttons that resolve the day's filter against the live mistake corpus.
- **Save all as drills**: one-click creates 3-5 named drill sets from the multi-day plan.
- **Filter vocabulary** is constrained: prompt explicitly lists `phase / themes / source / piece` so the model can't invent themes that match zero cards.

## Variants - DONE

21 variants in `lib/variants.js`, with a unified factory (`createVariantGame`) so OnlineGameScreen and VariantGameScreen route every game through one code path.

| Variant | Online | Bot | Notes |
|---|---|---|---|
| standard | yes | yes | no-op shell over chess.js |
| chess960 / Fischer Random | yes | yes | deterministic seed from gameData.id |
| kingOfTheHill | yes | yes | win by getting your king to d4/d5/e4/e5 |
| threeCheck | yes | yes | three checks wins; counter resets on `loadPgn` |
| antichess | yes | no | forced capture, lose all pieces = win |
| atomic | no | yes | captures explode 8-square perimeter |
| racingKings | yes | no | first king to rank 8 wins |
| horde | yes | no | white pawn horde vs black standard |
| fogOfWar | yes | no | opponent visible only if attacked or adjacent |
| rifle / circe | no | yes | capture-then-rebound mechanics |
| monster / marseillais / progressive | no | yes | multi-move turns |
| extinction | no | yes | lose any piece type = lose |
| dunsanys / peasants / weakArmy | no | yes | asymmetric setups |
| noCastling / torpedo / checkless | no | yes | rule-modifier shells |

Variants without online support hide the friend-match CTA on `/variants` and offer bot play instead.

## Profile - DONE

- Username, display name, country, bio, lichess username, chess.com username.
- **Avatar upload**: PNG / JPEG / WEBP / GIF, 4MB cap. Per-user folder in the public `avatars` bucket; storage RLS enforces upload path matches `auth.uid()`. **Old avatars auto-cleaned** on re-upload.
- Glicko-2 ratings per time category (bullet / blitz / rapid / classical).
- Recent games table with result + opponent + opening name.
- Public profile by `/u/:username` with the same shape (read-only).
- Puzzle stats panel (rating, RD, games solved).

## Friends - DONE

- Search by username or display name (case-insensitive).
- Add / accept / decline / remove with bidirectional dedup (the same pair can't be requested in both directions).
- Realtime updates via `friendships` postgres_changes (incoming requests appear in <2s).
- Friend rail visible on every signed-in route on viewports >= 2xl. Hidden on lobby pages (`/create-challenge`, `/challenge/:code`).
- "Play" button on a friend opens the create-challenge flow pre-filled.

## Auth - DONE

- Email + password (with confirmation email).
- Google OAuth (PKCE flow). Tokens never appear in browser history / referrer / server logs.
- Guest mode (`localStorage` flag). Online features show a "sign in to use this" banner.
- Username validation client-side (regex + reserved-name check) and server-side (unique constraint on `profiles.username`).
- Username + email lookup case-insensitively.

## Legal pages - DONE

- `/legal/privacy` - privacy policy grounded in the canonical schema.
- `/legal/terms` - terms of service.
- `/legal/attribution` - Stockfish / Lichess credits + license summary.
- All linked from the footer. Operator (Helsinki, Finland) + contact email constants at the top of `LegalPage.jsx`.

## Monitoring - OPT-IN (needs env vars)

`lib/monitoring.js` thinly wraps Sentry + PostHog. Both are dynamically imported so they only land in the bundle when their env vars are set.

| Provider | Env var | What it does |
|---|---|---|
| Sentry | `VITE_SENTRY_DSN` | Render errors via the top-level ErrorBoundary; chrome-extension noise filtered out |
| PostHog | `VITE_POSTHOG_KEY` (+ optional `VITE_POSTHOG_HOST`) | Named events on auth (`auth.signed_in`, `auth.signed_out`); privacy defaults baked in (no autocapture, no pageviews, respect-DNT) |

`identify()` ties the monitoring identity to the signed-in user; `reset()` clears it on signout.

## Custom cursor - DONE

- 8x8px white circle with mix-blend-mode: difference. Position: fixed, z-index 9999, pointer-events: none.
- Scales to 2x with white border on interactive elements (button / a / .group). Detected via `elementFromPoint` + `closest` on every mousemove.
- Touch / coarse-pointer devices revert to the system cursor.

## What's intentionally not built (COMING-SOON)

- **/study** route - repertoire / opening study trees. Currently shows a `<ComingSoon page="Study" />` shell.
- **VariantsPage upcoming list** - several variant rule-sets are toggle-listed but not playable yet (the toggle just shows the catalog).
- **Tournaments / arenas** - not in current product scope.
- **Leaderboards / achievements** - not in current product scope.

## Test surface

- 496 unit tests across 57 files (Vitest + Testing Library).
- 15 Playwright e2e smoke tests across desktop + mobile viewports.
- 15 Supabase project shape checks (`npm run check:supabase`).
