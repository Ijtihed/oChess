/**
 * Shared player-bar + clock primitives for any board surface
 * (Online play, AI Arena rounds, future variants). The
 * styling is identical to OnlineGameScreen's original inline
 * versions - extracted here so multiple game routes can
 * reuse the same bar without copy-paste drift.
 *
 * <PlayerBar /> renders a row above or below the board with
 * the player's avatar, name, optional rating, captures, and a
 * live <ClockDisplay /> if a time is supplied. The component
 * is purely presentational - the parent owns clock state and
 * passes the remaining ms in `time`.
 */

import { formatTime } from "../hooks/useClock";

// Captures math: derives material counts from a FEN so the
// PlayerBar's captured-pieces strip stays in sync with the
// board without any extra bookkeeping. Comparing piece counts
// against the standard initial population (8 pawns, 2
// knights, ...) catches captures via standard moves; for
// variants that *add* pieces (Crazyhouse, atomic with
// detonations, etc.) we just clamp counts to >= 0 so the bar
// degrades gracefully instead of rendering nonsense.
const STARTING_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const PIECE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const PIECE_ORDER = ["q", "r", "b", "n", "p"];

/**
 * Parse the placement field of a FEN and produce captured
 * piece arrays + a material advantage. Used by the Online
 * play screen and AI Arena rounds. Pure - no React, no DOM.
 *
 * @param {string} fen
 * @returns {{ capturedByWhite: string[], capturedByBlack: string[], advantage: number }}
 */
export function getCaptured(fen) {
  if (!fen || typeof fen !== "string") {
    return { capturedByWhite: [], capturedByBlack: [], advantage: 0 };
  }
  const board = fen.split(" ")[0] || "";
  const w = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  const b = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  for (const ch of board) {
    if (ch >= "A" && ch <= "Z") { const k = ch.toLowerCase(); if (k in w) w[k]++; }
    else if (ch >= "a" && ch <= "z") { if (ch in b) b[ch]++; }
  }
  const capturedByWhite = [];
  const capturedByBlack = [];
  let whiteMat = 0;
  let blackMat = 0;
  for (const p of PIECE_ORDER) {
    whiteMat += w[p] * PIECE_VAL[p];
    blackMat += b[p] * PIECE_VAL[p];
    for (let i = 0; i < Math.max(0, STARTING_COUNTS[p] - b[p]); i++) capturedByWhite.push(p);
    for (let i = 0; i < Math.max(0, STARTING_COUNTS[p] - w[p]); i++) capturedByBlack.push(p);
  }
  return { capturedByWhite, capturedByBlack, advantage: whiteMat - blackMat };
}

/**
 * @typedef {Object} PlayerBarProps
 * @property {string} name
 * @property {string|number} [rating]
 * @property {string} [avatar]                URL or null.
 * @property {string[]} [captured]            Lowercase piece chars (p/n/b/r/q).
 * @property {number} [advantage]             Material advantage; rendered next to captures.
 * @property {"w"|"b"} pieceColor             This player's color (used to color captures).
 * @property {number|null} [time]             ms remaining; pass null/undefined to skip the clock.
 * @property {boolean} [active]               Highlights clock when this player is to move.
 * @property {boolean} [isPlayer]             Visually distinguishes "you" from the opponent.
 * @property {boolean|null} [online]          Optional online dot; null = hidden.
 */
export default function PlayerBar({
  name,
  rating,
  avatar,
  captured = [],
  advantage = 0,
  pieceColor,
  time,
  active,
  isPlayer,
  online,
}) {
  return (
    <div className={`w-full flex items-center justify-between py-2 px-2 rounded ${isPlayer ? "mt-2 bg-surface-low/50" : "mb-2 bg-surface-low/50"}`}>
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 relative overflow-hidden ${
          isPlayer ? "bg-primary/25" : "bg-surface-high"
        }`}>
          {avatar ? (
            <img src={avatar} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <span className={`font-headline text-sm font-bold uppercase ${isPlayer ? "text-primary" : "text-on-surface-variant/70"}`}>
              {(name || "?")[0]}
            </span>
          )}
          {online != null && (
            <>
              <span aria-hidden="true"
                className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-surface ${online ? "bg-emerald-500" : "bg-on-surface-variant/20"}`} />
              <span className="sr-only">{online ? "online" : "offline"}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`font-headline text-sm font-bold truncate ${isPlayer ? "text-primary" : "text-on-surface-variant/80"}`}>
            {name || "?"}
          </span>
          {rating && <span className="text-xs text-on-surface-variant/35 tabular-nums shrink-0">{rating}</span>}
        </div>
        {captured.length > 0 && (
          <div className="flex items-center gap-px ml-1 shrink-0">
            {captured.map((p, i) => {
              const capturedColor = pieceColor === "w" ? "b" : "w";
              const needsBrighten = capturedColor === "b";
              return (
                <img key={i} src={`/piece/cburnett/${capturedColor}${p.toUpperCase()}.svg`} alt={p} className="w-4 h-4"
                  style={needsBrighten ? { filter: "brightness(2.5) grayscale(0.6)", opacity: 0.7 } : { opacity: 0.6 }} draggable={false} />
              );
            })}
            {advantage > 0 && <span className="text-[10px] font-bold text-on-surface-variant/30 ml-1 tabular-nums">+{advantage}</span>}
          </div>
        )}
      </div>
      {time != null && <ClockDisplay time={time} active={active} />}
    </div>
  );
}

/**
 * Compact clock pill that lives inside a <PlayerBar />. Tints
 * critical (<10s) red, low (<30s) primary, otherwise a neutral
 * background when active and muted when inactive.
 */
export function ClockDisplay({ time, active }) {
  const low = time < 30000;
  const critical = time < 10000;
  return (
    <div className={`px-3 py-1 font-mono text-base font-bold tabular-nums transition-colors shrink-0 ${
      active
        ? critical ? "bg-error/20 text-error" : low ? "bg-primary/10 text-primary" : "bg-surface-high text-primary"
        : "bg-surface-low/80 text-on-surface-variant/35"
    }`}>
      {formatTime(time)}
    </div>
  );
}
