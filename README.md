<h1 align="center">
  <img src="ochess-app/public/bishoplogo.png" alt="oChess Logo" width="120"/><br/>
  oChess
</h1>

<p align="center">
  A modern chess-first platform for play, analysis, puzzles, and long-term improvement.
</p>

<p align="center">
  <a href="https://github.com/Ijtihed/oChess/actions"><img src="https://img.shields.io/github/actions/workflow/status/Ijtihed/oChess/ci.yml?branch=main&style=flat&label=CI&logo=githubactions&logoColor=white&labelColor=0d0d0d&color=1a1a1a" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-1a1a1a?style=flat&labelColor=0d0d0d" alt="License"></a>
  <img src="https://img.shields.io/badge/Version-0.1.0-1a1a1a?style=flat&labelColor=0d0d0d" alt="Version">
  <img src="https://img.shields.io/badge/Platform-Web-1a1a1a?style=flat&labelColor=0d0d0d" alt="Platform">
  <img src="https://img.shields.io/badge/Node-20+-1a1a1a?style=flat&logo=nodedotjs&logoColor=white&labelColor=0d0d0d" alt="Node 20+">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-19-1a1a1a?style=flat&logo=react&logoColor=61dafb&labelColor=0d0d0d" alt="React 19">
  <img src="https://img.shields.io/badge/Vite-8-1a1a1a?style=flat&logo=vite&logoColor=646cff&labelColor=0d0d0d" alt="Vite 8">
  <img src="https://img.shields.io/badge/Tailwind-4-1a1a1a?style=flat&logo=tailwindcss&logoColor=38bdf8&labelColor=0d0d0d" alt="Tailwind 4">
  <img src="https://img.shields.io/badge/Stockfish-18-1a1a1a?style=flat&labelColor=0d0d0d" alt="Stockfish 18">
  <img src="https://img.shields.io/badge/Tests-496%20passing-1a1a1a?style=flat&logo=vitest&logoColor=6da13f&labelColor=0d0d0d" alt="Tests">
</p>

<p align="center">
  <img src="ochess-app/public/screenshotpuzzle.png" alt="oChess puzzle screenshot" width="1080" />
</p>

---

# Wait, Another Chess Platform?

<table>
<tr>
<td width="68%" valign="top">
  <p><strong>Yes, and intentionally so.</strong></p>
  <p><strong>oChess</strong> is built around one core idea: the game should not end when the clock hits zero.<br />
  Most platforms let your mistakes disappear into history; oChess turns them into a learning loop.</p>
  <p>From fast play and bots to analysis, review, and coaching, every feature is designed to feel:</p>
  <ul>
    <li>simple</li>
    <li>premium</li>
    <li>fast</li>
    <li>user-first</li>
  </ul>
</td>
<td width="32%" align="center" valign="middle">
  <img src="ochess-app/public/surprisedpiece.png" alt="Surprised chess piece" width="240"/>
</td>
</tr>
</table>

## What Makes oChess Different

### The post-game loop is the product

After a game, you should be able to move straight into:
- mistake review
- plain-language coach feedback
- puzzle generation from your errors
- study/review material for spaced repetition (Anki!)
- plain language game-rule generation
- anki-style repeatition based on your puzzles/games

This is the core experience.

### What is special here

- **Anki-style chess memory loop**: important positions become review cards with spaced repetition so that your mistakes do not disappear after one game.
- **LLM game-rule generation**: write rules in plain language, generate playable variants, and test them quickly.
- **Play those variants with friends**: generated rules are not just text; they are meant to be played in social games and challenges.
- **Chess-first UX**: no feed clutter, no content bloat, just simple board and progression.

## Product Surfaces

## Tech Stack

| Layer | Tech |
|-------|------|
| Framework | React 19, Vite 8 |
| Styling | Tailwind CSS v4 |
| Routing | React Router v7 |
| Chess logic | chess.js |
| Board UI | react-chessboard |
| Weak bots | js-chess-engine (Web Worker) |
| Strong bots + analysis | Stockfish 18 WASM |
| Spaced repetition | SM-2 engine (custom) |
| Testing | Vitest, @testing-library/react |
| CI/CD | GitHub Actions |

## Setup

### Requirements
- Node.js `20+`
- npm `10+`

### Run locally

```bash
cd ochess-app
npm install
npm run dev
```

### Production build

```bash
cd ochess-app
npm run build
npm run preview
```

## Project Structure

- `ochess-app/` - frontend app
- `docs/` - product and architecture notes
- `.github/` - CI and contribution workflows

## Roadmap Direction

- Stronger game-to-review automation
- Better player profiling and progression
- More polished analysis and study flows
- Collaboration-friendly chess tooling

## Contributing

Contributions are welcome.

1. Fork the repository
2. Create a branch (`git checkout -b feature/your-feature`)
3. Commit your changes
4. Open a PR

Read `CONTRIBUTING.md` for full guidelines.

## Security

Please follow `SECURITY.md` for responsible vulnerability reporting.

## License

Licensed under `Apache-2.0`.  
See `LICENSE` and `NOTICE`.

Reuse is free, including commercial use, as long as license/attribution notices are preserved.

---

<div align="center">
  <p>Made with intent by <strong>Ijtihed</strong></p>
  <p><em>Chess-first. Quietly premium.</em></p>
</div>
