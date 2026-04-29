/**
 * Per-move quality annotations (?!/?/?? + best/great/brilliant).
 *
 * Bad-move detection is delegated to `lib/win-chances.js` so it
 * matches Lichess exactly: classify by *winning-chances delta*,
 * not raw centipawn loss. That's the same algorithm Lichess
 * uses on its analysis page (see lila PR #5337). The thresholds
 * (0.10 / 0.20 / 0.30) are the production server-side values.
 *
 * Good-move detection (best, great, brilliant) is local to this
 * module because it depends on context the win-chances loss
 * doesn't capture: was this the engine's #1 choice, did the
 * player gain ground, did the position invert from losing to
 * winning. None of that fits inside a "loss" scalar.
 */

import { lossFromScores, classifyByWcLoss, scoreToCp, winningChances } from "./win-chances";

const ANNOTATIONS = {
  book:       { glyph: "Book", label: "Book move",   bg: "#a68a64", text: "#fff" },
  brilliant:  { glyph: "!!",   label: "Brilliant",   bg: "#1baca6", text: "#fff" },
  great:      { glyph: "!",    label: "Great move",  bg: "#5c9e31", text: "#fff" },
  best:       { glyph: "★",   label: "Best move",   bg: "#5c9e31", text: "#fff" },
  inaccuracy: { glyph: "?!",   label: "Inaccuracy",  bg: "#e6a817", text: "#fff" },
  mistake:    { glyph: "?",    label: "Mistake",     bg: "#e07020", text: "#fff" },
  blunder:    { glyph: "??",   label: "Blunder",     bg: "#ca3431", text: "#fff" },
};

/**
 * Classify a move from before/after Stockfish scores.
 *
 *   - `evalBefore`, `evalAfter`: Stockfish-style score objects
 *       `{ cp }` or `{ mate }` (white POV, in centipawns).
 *   - `movingColor`: "w" or "b" - which side just played.
 *   - `options.isBook`: true for opening-book moves; short-
 *       circuits to the Book glyph regardless of eval.
 *   - `options.isBestMove`: true if this was the engine's #1
 *       pick. Used to upgrade not-bad moves to ★ Best.
 */
export function classifyMove(evalBefore, evalAfter, movingColor, options = {}) {
  const { isBook = false, isBestMove = false } = options;

  if (isBook) return ANNOTATIONS.book;
  if (!evalBefore || !evalAfter) return null;

  // ── Bad-move detection: pure Lichess winning-chances delta. ──
  const wcLoss = lossFromScores(evalBefore, evalAfter, movingColor);
  if (wcLoss == null) return null;
  const judgement = classifyByWcLoss(wcLoss);
  if (judgement) return ANNOTATIONS[judgement];

  // ── Good-move detection. The win-chances loss is now <0.10 (so
  // the move wasn't a clearly bad move). Three good-move flavours
  // we care about: BRILLIANT (winning-chances actually went UP for
  // the moving side, especially from a worse position), GREAT (a
  // notable swing in your favour), BEST (engine's #1, no fuss).
  // We compute the wc gain (negative loss) so the gates read
  // naturally below.
  const wcGain = -wcLoss; // positive when the move improved your side's wc

  // Detect "swing from losing to winning" or "best move with no
  // loss" - both qualify as Brilliant in casual chess UI.
  const cpBefore = scoreToCp(evalBefore);
  const cpAfter  = scoreToCp(evalAfter);
  const wcBeforePov = (movingColor === "w" ? 1 : -1) * winningChances(cpBefore);
  const wcAfterPov  = (movingColor === "w" ? 1 : -1) * winningChances(cpAfter);

  // Sign-flip: was losing (wc<0), now winning (wc>=0). The exact
  // -0.10 floor matches Lichess's inaccuracy threshold so we don't
  // call a "no-op equalising trade" Brilliant.
  if (wcBeforePov <= -0.10 && wcAfterPov >= 0.10) return ANNOTATIONS.brilliant;
  if (isBestMove && wcGain >= 0) return ANNOTATIONS.brilliant;

  // Notable positive swing (≥ inaccuracy threshold in the player's
  // favour). One-pawn-or-better gain when starting equal-ish.
  if (wcGain >= 0.10) return ANNOTATIONS.great;

  if (isBestMove) return ANNOTATIONS.best;
  return null;
}

export { ANNOTATIONS };
