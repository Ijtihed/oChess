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

oChess is a fully functional client-side chess application. The following core loops work end-to-end:

1. **Play bots** — 8 difficulty levels with proper engines (js-chess-engine for weak, Stockfish WASM for strong), clock management, premoves, draw/abort/takeback, saved games, post-game eval
2. **Puzzles** — Adaptive Glicko-1 rated puzzles from Lichess DB, timed, streaks, AI explanations, direct links
3. **Analysis** — Full analysis board with Stockfish eval, board editor, piece placement, save/load boards, opening wiki, PGN/FEN import/export
4. **Review** — SM-2 scheduling engine implemented, UI shell exists, integration points on analysis board

## Main differentiators

1. **Chess-first design** — The board and play loop matter most. Bigger board presence, cleaner controls, less clutter.

2. **Better post-game improvement loop** — Games flow naturally into: engine evaluation → move-by-move analysis → opening identification → position saving → review deck integration.

3. **Built-in spaced repetition (Review)** — An Anki-style memory system for chess learning. Turn blunders, tactics, opening lines, endgame positions, and coach explanations into reviewable cards with proper SM-2 scheduling. This is a first-class feature, not a bolt-on.

4. **AI coach in the core loop** — Explains blunders in simple language. Feels like a calm human coach. Designed behind an interface so it can support local models (Ollama) later.

5. **No-cheating-by-default** — Engine evaluation is locked during live play, only available post-game and in analysis.

6. **Robust error handling** — Engine failures show explicit error codes and debug info, never silent fallback to random behavior.

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
