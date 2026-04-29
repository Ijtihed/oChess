/**
 * Lichess-style winning-chances algorithm for move quality.
 *
 * The classic chess-engine output is centipawns ("the engine
 * thinks White is +0.50 pawns better"). Centipawns are great for
 * raw position eval but a poor unit for *move quality*: a swing
 * from +50 to -250 cp matters very differently to a swing from
 * -600 to -900, even though both lose 300 cp. The first hands the
 * game away, the second is noise.
 *
 * Lichess solved this by mapping cp to "winning chances" - a
 * sigmoid-shaped probability of winning, derived empirically from
 * 75k+ games at 2300+ ELO. Move classifications (?!/?/??) and the
 * "Learn from your mistakes" feature are then driven by *delta in
 * winning chances*, which is naturally bounded and doesn't punish
 * the loser for "blundering" a lost position twice.
 *
 * This module wraps Lichess's published formula and threshold
 * constants so every move-quality decision in oChess (board
 * annotations, Anki mistake detection, AI explanation severity)
 * uses the same source of truth.
 *
 * References:
 *   - lila PR #5337: server analysis switched from raw cp to
 *     winning-chances delta with thresholds 0.1 / 0.2 / 0.3.
 *   - lila PR #11148: regression-fit `k = -0.00368208` from
 *     Lichess game data (replacing the older -0.004).
 *   - lila modules/analyse/src/main/AccuracyPercent.scala:
 *     production reference for fromWinPercents().
 */

// Saturation cap for cp values. Anything beyond ±10000 cp is
// "totally winning / losing" already, and at this magnitude the
// winning-chances sigmoid is within 1e-15 of ±1 anyway. Clamping
// here is purely defensive against NaN / Infinity slipping in
// from upstream eval sources.
export const CP_CAP = 10000;

// Lichess's regression-fit sigmoid coefficient (PR #11148).
// Don't change this unless Lichess does - downstream thresholds
// were calibrated against this exact value.
export const K = 0.00368208;

// Server-side classification thresholds in winning-chances space.
// These match Lichess's lila Advice.scala and reproduce the
// ?!/?/?? annotations on a Lichess analysis report.
//
// The "Learn from your mistakes" UI uses 0.075 for inaccuracy
// (slightly more permissive); we follow the server thresholds
// because that's what shows in the analysis on lichess.org and
// what the user expects when they say "Lichess thinks this is a
// blunder".
export const WC_INACCURACY = 0.10;
export const WC_MISTAKE    = 0.20;
export const WC_BLUNDER    = 0.30;

/**
 * Convert a centipawn evaluation to winning chances in [-1, 1].
 *
 *   +1  = white certain to win
 *    0  = perfectly balanced
 *   -1  = black certain to win
 *
 * Mate scores must be converted via `mateToCp` first. The cp
 * input is auto-clamped to ±CP_CAP so saturated evals don't blow
 * up the exponential.
 */
export function winningChances(cp) {
  if (!Number.isFinite(cp)) return 0;
  const clamped = Math.max(-CP_CAP, Math.min(CP_CAP, cp));
  return 2 / (1 + Math.exp(-K * clamped)) - 1;
}

/**
 * Convert winning chances [-1, 1] to a 0..100 win percentage from
 * White's POV. Convenient for UI bars and the "Win %" label.
 */
export function winPercent(cp) {
  return 50 + 50 * winningChances(cp);
}

/**
 * Convert a mate score to a centipawn equivalent.
 *
 *   mate = +N  -> +(CP_CAP - N) cp  (white mates in N)
 *   mate = -N  -> -(CP_CAP - N) cp  (black mates in N)
 *
 * Subtracting the mate distance gives a longer mate slightly less
 * weight than a shorter one, which agrees with intuition (mate-in-1
 * > mate-in-30) without changing the winning-chances output once
 * clamping kicks in.
 */
export function mateToCp(mate) {
  if (!Number.isFinite(mate) || mate === 0) return 0;
  const sign = mate > 0 ? 1 : -1;
  const absM = Math.min(Math.abs(mate), CP_CAP - 1);
  return sign * (CP_CAP - absM);
}

/**
 * Normalise a Stockfish-style score object `{ cp, mate }` into a
 * single centipawn value usable by `winningChances`.
 *
 *   { cp: 50 }       -> 50
 *   { mate: 3 }      -> 997   (white mates in 3)
 *   { mate: -5 }     -> -995  (black mates in 5)
 *   null / undefined -> null  (caller decides what to do)
 */
export function scoreToCp(score) {
  if (!score) return null;
  if (Number.isFinite(score.mate)) return mateToCp(score.mate);
  if (Number.isFinite(score.cp))   return score.cp;
  return null;
}

/**
 * The signed winning-chances *loss* a side suffered going from
 * `before` to `after`. Positive = the side that just moved is now
 * worse off (i.e. they made a bad move). The result is in [-1, 1]
 * but for classification only the magnitude matters; the sign is
 * useful for distinguishing "good move" vs "bad move".
 *
 * @param {number} cpBefore - cp eval *before* the move (white POV)
 * @param {number} cpAfter  - cp eval *after* the move (white POV)
 * @param {"w"|"b"} mover   - which side just moved
 * @returns {number} winning-chances loss for `mover`. e.g. white
 *   played a blunder dropping the eval from +100 cp to -300 cp
 *   ⇒ wcBefore ≈ +0.184, wcAfter ≈ -0.537 ⇒ loss ≈ 0.72.
 */
export function winChancesLoss(cpBefore, cpAfter, mover) {
  if (cpBefore == null || cpAfter == null) return null;
  const sign = mover === "w" ? 1 : -1;
  // Convert both evaluations to the moving side's POV so a
  // higher number always means "good for me". Then loss = before
  // - after - i.e. how much winning prob did I just give up.
  const wcBeforePov = sign * winningChances(cpBefore);
  const wcAfterPov  = sign * winningChances(cpAfter);
  return wcBeforePov - wcAfterPov;
}

/**
 * Classify a move from its winning-chances loss.
 *
 *   loss < 0.1   -> null         (no judgement; ordinary move)
 *   0.10 - 0.19  -> "inaccuracy" (?!)
 *   0.20 - 0.29  -> "mistake"    (?)
 *   0.30+        -> "blunder"    (??)
 *
 * Negative losses (i.e. the side gained winning chances) return
 * null - this function is for *bad* move detection. Good-move
 * detection (best / great / brilliant) is handled separately by
 * `move-classify.js` because it needs side-channel info like
 * "was this the engine's #1 choice".
 */
export function classifyByWcLoss(wcLoss) {
  if (!Number.isFinite(wcLoss) || wcLoss < WC_INACCURACY) return null;
  if (wcLoss >= WC_BLUNDER)    return "blunder";
  if (wcLoss >= WC_MISTAKE)    return "mistake";
  return "inaccuracy";
}

/**
 * Convenience one-shot: take Stockfish-style score objects from
 * before and after the move + the moving color, return the loss
 * in winning chances. Useful when you have raw engine scores and
 * don't want to mateToCp/scoreToCp/winChancesLoss separately.
 */
export function lossFromScores(before, after, mover) {
  const cpBefore = scoreToCp(before);
  const cpAfter  = scoreToCp(after);
  return winChancesLoss(cpBefore, cpAfter, mover);
}
