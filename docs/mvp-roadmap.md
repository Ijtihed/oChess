# oChess - Roadmap snapshot

The MVP is shipped. This file tracks what's now stable, what's deliberately deferred, and what's left for v1.1.

The granular per-phase history this file used to track (Phases 1-10) is preserved in git history; the canonical "what works today" surface lives in [`feature-spec.md`](./feature-spec.md).

---

## Stable features (shipped + tested)

| Surface | Status |
|---|---|
| Bot play (8 levels, clocks, premove, save/resume) | **shipped** |
| Online play (matchmaking + friend challenges) | **shipped** |
| Puzzles (adaptive, rated, timed, streaks, coach explanation) | **shipped** |
| Analysis board (engine, editor, save/load, FEN/PGN, AI explanation modal) | **shipped** |
| Anki review (full SM-2 state machine, multi-move play-out, predicted intervals, queue breakdown, 7-day forecast, drill sets, card sharing) | **shipped** |
| Game library import (chess.com + Lichess) + Stockfish-driven mistake detection | **shipped** |
| AI Plan tab + actionable per-day Practice / Save-as-drill buttons | **shipped** (opt-in, needs Groq key) |
| 21 variants in `lib/variants.js`, 8 of them online-supported (chess960 deterministic) | **shipped** |
| Auth (email + Google PKCE + guest mode), profiles, public profiles, avatar upload with auto-cleanup | **shipped** |
| Friends (search / add / accept / decline / remove) with bidirectional dedup + realtime updates | **shipped** |
| Glicko-2 ratings per time category, server-side via `glicko2_update` RPC | **shipped** |
| Realtime chat in-game with broadcast/DB-sync dedup + 500ms throttle | **shipped** |
| Custom cursor, board picker (38 piece sets, multiple themes) | **shipped** |
| Legal pages (privacy / terms / attribution) | **shipped** |
| AI coach rate limit (3 calls / 5 min) server-enforced via `record_coach_call` RPC | **shipped** |
| Sentry + PostHog wrappers, opt-in via env vars | **shipped** |

---

## Deferred (intentionally COMING-SOON)

| Surface | Why |
|---|---|
| `/study` (repertoire / opening tree) | Out of scope for current product cycle. Route shows a `<ComingSoon page="Study" />` shell. |
| Variant catalog "upcoming" toggle | The 21 variants without playable bot/online support are listed for visibility only. |
| Tournaments / arenas | Not in product scope. |
| Leaderboards / achievements | Not in product scope. |

---

## v1.1 candidates

Things that would meaningfully expand the post-game loop without changing the product shape.

- **Server-side review-card sync.** The `review_cards` table exists in the schema as a future home for cross-device sync. Currently every Anki feature reads / writes localStorage only.
- **Personalized weakness suggestions.** The Plan tab already shows a weakness profile (phase counts + theme chips). The next step is surfacing "you keep missing forks - try these 5 cards" as a notification or dashboard widget without the user having to click into the Plan tab.
- **Repertoire / opening study.** The `/study` shell is the natural home for an opening tree with annotations + spaced-repetition coverage.
- **Server-side import rate limit.** Currently client-side throttle (8 imports / source / hour, localStorage-keyed). A determined user can bypass it. If abuse becomes a problem, proxy game-import calls through an Edge Function with postgres-backed counters (mirror the coach rate limit pattern).
- **Coach prompt customization.** The Edge Function pins prompt + filter vocabulary. Letting the user steer the prompt ("focus on my endgame" / "be brutal") would deepen the personalization without much code.
- **Multi-board correspondence play.** Long time-controls + multiple concurrent games + email reminders would broaden the audience past the current real-time-blitz target.
- **Mobile native apps.** PWA already works on mobile viewports; native shells would unlock push notifications for friend requests / rematch / move-played.

---

## What landed since the last roadmap snapshot

- Full Anki state machine (NEW / LEARNING / REVIEW / RELEARNING) with interval fuzz + faithful lapse policy.
- AI coach via Groq Edge Function with per-account rate limit + actionable per-day plan.
- Drill sets - persistent named filter sets in the Plan tab.
- Card sharing via `?import=<base64>` URLs with deduplication.
- Black-side mistake detection fix (the engine was sign-inverted; Black blunders weren't being flagged).
- Chess960 deterministic seeding from `gameData.id` so both online clients see the same start position.
- Avatar upload cleanup (no more orphan files).
- Sentry + PostHog wrappers (opt-in).
- PKCE auth flow (replaced implicit).
- Client-side import throttle for Lichess / chess.com.
- Schema migrations folder + `coach_calls` rate-limit table.
- 496 unit tests / 15 e2e / 15 supabase shape checks.
