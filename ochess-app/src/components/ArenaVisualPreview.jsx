/**
 * ArenaVisualPreview - tiny in-lobby canvas showing what the
 * variant's slot draws look like, BEFORE the user launches the
 * room.
 *
 * Runs the same iframe sandbox as the in-game overlay, so what
 * the user sees here is exactly what they'll see in the game
 * (modulo board size). Renders a fake mini-board with one of
 * each piece type so every defined slot key has at least one
 * piece to paint on.
 *
 * No-op (returns null) when the variant has no visuals.
 *
 * Props:
 *   visuals   - the rules.visuals object from the AI's output
 *               (NOT the compiled form - we compile here)
 *   seed      - any string; used by the iframe's PRNG
 */

import { useMemo } from "react";
import ArenaVisualOverlay from "./ArenaVisualOverlay";
import { compileVisuals } from "../lib/arena/visual-sandbox/compile-draws";

// Fake "position" shape that ArenaVisualOverlay needs. We
// hand-build a board with one piece per type so every slot key
// (q.aura, n.aura, etc.) gets at least one paintable piece.
const PREVIEW_POSITION = (() => {
  const board = new Array(64).fill(null);
  // a3=p, b3=n, c3=b, d3=r, e3=q, f3=k (white).
  // a6=p, b6=n, c6=b, d6=r, e6=q, f6=k (black).
  const placements = [
    // file 0..5, rank 2 (=row 5 in board[i]) for white
    { file: 0, rank: 2, type: "p", color: "w" },
    { file: 1, rank: 2, type: "n", color: "w" },
    { file: 2, rank: 2, type: "b", color: "w" },
    { file: 3, rank: 2, type: "r", color: "w" },
    { file: 4, rank: 2, type: "q", color: "w" },
    { file: 5, rank: 2, type: "k", color: "w" },
    // black on rank 5
    { file: 0, rank: 5, type: "p", color: "b" },
    { file: 1, rank: 5, type: "n", color: "b" },
    { file: 2, rank: 5, type: "b", color: "b" },
    { file: 3, rank: 5, type: "r", color: "b" },
    { file: 4, rank: 5, type: "q", color: "b" },
    { file: 5, rank: 5, type: "k", color: "b" },
  ];
  for (const p of placements) {
    board[p.rank * 8 + p.file] = { type: p.type, color: p.color };
  }
  return {
    board,
    turn: "w",
    history: [],
    crazyState: { effects: {} },
  };
})();

export default function ArenaVisualPreview({ visuals, seed = "preview" }) {
  const compiled = useMemo(() => {
    if (!visuals || typeof visuals !== "object") return null;
    return compileVisuals(visuals).compiled;
  }, [visuals]);

  if (!compiled) return null;

  return (
    <div className="mt-3">
      <p className="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant/40 mb-1.5">
        Visual preview
      </p>
      <div className="relative w-full aspect-square max-w-[280px] mx-auto">
        {/* Background mini-board so the iframe paints over a
            chess-like surface. Two-color wash + grid lines. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "repeating-conic-gradient(#3b3b3b 0% 25%, #2c2c2c 0% 50%) 50% / 25% 25%",
          }}
        />
        {/* Mini "pieces" - rendered as filled circles so the
            user sees WHERE the iframe's slot draws are landing
            in the absence of real chess SVGs. The real game
            board would have proper sprites underneath. */}
        <PreviewPieces />
        <ArenaVisualOverlay
          compiledDraws={compiled}
          seed={seed}
          position={PREVIEW_POSITION}
          orientation="white"
          disabled={false}
        />
      </div>
    </div>
  );
}

/**
 * Render a circle for each piece in PREVIEW_POSITION. White
 * pieces are light circles; black are dark. Lets the user see
 * where the AI's slot draws are landing relative to a piece.
 */
function PreviewPieces() {
  const placements = [];
  for (let i = 0; i < 64; i++) {
    const pc = PREVIEW_POSITION.board[i];
    if (!pc) continue;
    const file = i % 8;
    const rank = Math.floor(i / 8);
    placements.push({ file, rank, ...pc });
  }
  const sq = 100 / 8; // % per square
  return (
    <>
      {placements.map((p, i) => {
        const left = p.file * sq;
        // Board is rendered with rank 0 at the BOTTOM in the
        // overlay's squareToScreen (orientation=white, rank 7
        // at top). Mirror that here.
        const top = (7 - p.rank) * sq;
        const bg = p.color === "w" ? "#eaeaea" : "#222";
        const fg = p.color === "w" ? "#333" : "#ddd";
        return (
          <div
            key={i}
            className="absolute flex items-center justify-center font-headline font-extrabold"
            style={{
              left: left + "%", top: top + "%",
              width: sq + "%", height: sq + "%",
              fontSize: "10px",
              color: fg,
            }}
          >
            <div
              className="w-[58%] h-[58%] rounded-full flex items-center justify-center"
              style={{ background: bg }}
            >
              {p.type.toUpperCase()}
            </div>
          </div>
        );
      })}
    </>
  );
}
