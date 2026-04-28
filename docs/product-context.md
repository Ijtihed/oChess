# oChess — Product Context

## What oChess is

oChess is a chess-first web application built for serious play, deep analysis, and long-term improvement. It is not a content platform, gaming portal, or ad-heavy consumer product. It is a tool for people who play chess and want to get better at it.

## Identity

Simple. Classy. Cool. Dark. Premium. Modern. Chess-first. Fast. Minimal. Restrained.

Inspired by Lichess in speed and clarity, but more premium and cleaner. It should feel like a serious chess tool — not a noisy consumer app.

## Core thesis

Most chess platforms treat the post-game experience as an afterthought. oChess treats it as a first-class product surface. A game should lead naturally into understanding your mistakes, building memory, and improving over time.

The built-in spaced repetition system (Review) is a major differentiator. Mistakes, positions, tactics, openings, endgames, and coach explanations become reviewable memory cards — not one-time analysis you forget.

## Current state

oChess is a fully functional chess platform with an end-to-end post-game improvement loop. All major surfaces work today:

1. **Play bots** - 8 difficulty levels with proper engines (js-chess-engine for weak, Stockfish WASM for strong), clock management, premoves, draw/abort/takeback, saved games, post-game eval.
2. **Online play** - Live matchmaking, friend challenges, 21 variants (8 of them online-supported with deterministic chess960 seeding), Glicko-2 ratings, full rematch flow with cancel/decline broadcasts.
3. **Puzzles** - Adaptive Glicko-1 rated puzzles from a trimmed Lichess DB (committed to the repo), timed, streaks, AI coach explanations, direct links.
4. **Analysis** - Full analysis board with Stockfish eval, board editor, piece placement, save/load boards, opening wiki, PGN/FEN import/export, AI coach modal per ply.
5. **Anki review** - Real Anki SM-2 state machine (NEW/LEARNING/REVIEW/RELEARNING with proper learning steps + interval fuzz + faithful lapse policy), multi-move puzzle play-out with opponent auto-reply, predicted intervals on rating buttons, queue breakdown + 7-day forecast, drill sets (persistent named filters), card sharing via URL.
6. **AI Plan tab** - Game library import from Lichess + chess.com, Stockfish-driven mistake detection, weakness profile, AI coach plan with one-click "Practice now" / "Save as drill" buttons (3 calls / 5 min server-side rate limit).
7. **Auth + profile** - Email + Google PKCE OAuth + guest mode. Avatar upload with auto-cleanup of orphan files.
8. **Friends** - Search, add, accept, decline, remove. Realtime updates via Supabase postgres_changes.
9. **Legal** - Privacy / Terms / Attribution pages grounded in the canonical schema.

## Main differentiators

1. **Chess-first design** - The board and play loop matter most. Bigger board presence, cleaner controls, less clutter.

2. **Built-in spaced repetition (Anki)** - A real Anki-faithful SM-2 implementation, not a toy version. Mistakes from imported games + failed puzzles + saved analysis positions all become reviewable memory cards. Multi-move puzzles play out as real chess interactions, not "drag once and disappear" snapshots.

3. **End-to-end weakness loop** - Import games -> Stockfish detects mistakes -> AI coach groups them into a multi-day plan -> each plan day becomes a saveable drill set -> drilled cards re-enter the SM-2 schedule. This is the chain other platforms don't close.

4. **AI coach behind an Edge Function** - Calls Groq's free Llama 3.3 70B via a JWT-gated Supabase Edge Function. Per-account rate limit (3 calls / 5 min) is server-enforced via a postgres RPC, surfaced as a countdown banner in the UI. The provider is swappable - the client only knows the structured response schema.

5. **No-cheating-by-default** - Engine evaluation is locked during live play, only available post-game and in analysis.

6. **Robust error handling** - Engine failures show explicit error codes and debug info, never silent fallback to random behavior. Realtime broadcasts are NEVER trusted on receipt for terminal events - the handler refetches the games row before terminating locally.

7. **Privacy-first observability** - Sentry + PostHog wrappers ship opt-in via env vars. PostHog defaults to no autocapture, no pageviews, no session recording, respect-DNT.

## Target users

**Serious players** — Want fast queue, ratings, clean analysis, strong tools, public profiles, minimal friction, and long-term improvement.

**Casual players** — Want easy play, bots, puzzles, coaching, and fun variants without feeling overwhelmed.

## What oChess is not

- Not a content-heavy homepage
- Not a lesson marketplace
- Not a noisy feed
- Not a streamer-first experience
- Not decorated with AI-generated art
- Not image-heavy design
- Not a crypto or gambling product
