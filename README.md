<div align="center">

<h1>OCHESS</h1>
<h3><em>Chess-first gameplay, analysis, and training in one clean loop</em></h3>
<img src="ochess-app/public/bishoplogo.png" alt="oChess Logo" width="150" />

<p>
  <a href="https://github.com/Ijtihed/ochess"><img src="https://img.shields.io/badge/Built_with-React-111111?style=for-the-badge&logo=react&logoColor=61DAFB" alt="Built with React"></a>
  <a href="https://github.com/Ijtihed/ochess"><img src="https://img.shields.io/badge/Engine-Chess.js-111111?style=for-the-badge" alt="Engine Chess.js"></a>
  <a href="https://github.com/Ijtihed/ochess"><img src="https://img.shields.io/badge/License-Apache_2.0-111111?style=for-the-badge" alt="Apache 2.0"></a>
</p>

<br />

<img src="ochess-app/public/screenshotpuzzle.png" alt="oChess puzzle experience" width="1080" />
</div>

---

> [!NOTE]
> oChess is designed around one idea: the game does not end at checkmate.
> Every major surface is built to move you from play to understanding to retention:
> game -> analysis -> coach feedback -> puzzle/review loop.
> The puzzle board shown above is one of the core UX anchors for this flow.

---

# IMPORTANT NOTICE

This repository is an original open project for building a modern, premium-feeling chess platform.

Key principles:
- Chess-first UI, minimal noise
- Fast iteration with practical tooling
- Improvement loop over vanity metrics
- Open-source with attribution-preserving licensing

For license and attribution terms, see `LICENSE` and `NOTICE`.

## Why oChess Exists

Most chess products stop at move history and basic eval bars.  
oChess is built to make post-game understanding and long-term improvement first-class.

## Technical Breakdown

### Core Product Surfaces
- `Play` - quick games with clean UX
- `Puzzles` - tactical drilling and session tracking
- `Analysis` - position review and engine context
- `Study` - structured learning workflows
- `Bots` - AI opponents by level
- `Variants` - alternate rulesets
- `Review` - spaced-repetition style recall
- `Profile` - progression and personal history

### Current Stack
- `React`
- `Vite`
- `Tailwind CSS`
- `react-router-dom`
- `chess.js`
- `react-chessboard`

### Engine Work
- Browser engine runtime support (Stockfish assets included)
- Utility wrappers for position evaluation and readable feedback
- Built to connect naturally into analysis and coaching flows

---

## How To Run

### Setup
```bash
cd ochess-app
npm install
```

### Development
```bash
npm run dev
```

### Production Build
```bash
npm run build
npm run preview
```

## Repository Structure

- `ochess-app/` - frontend application
- `docs/` - product context, roadmap, architecture notes
- `.github/` - CI, issue templates, PR templates, automation

## Contributing

Contributions are welcome and appreciated.

1. Fork the repository
2. Create your branch (`git checkout -b feature/amazing-change`)
3. Commit your updates
4. Push and open a pull request

See `CONTRIBUTING.md` for full contribution guidelines.

## Security

If you discover a vulnerability, please follow `SECURITY.md` for responsible reporting.

## License

Licensed under `Apache-2.0`.

Reuse is free (including commercial use) as long as license and attribution notices are preserved.

---

<div align="center">
<p>Built by <strong>Ijtihed</strong></p>
<p><em>Play better. Understand deeper. Remember longer.</em></p>
</div>
