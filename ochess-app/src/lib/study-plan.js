/**
 * Study plan engine.
 *
 * Pulls the user's recent games from Lichess / Chess.com, runs them
 * through Stockfish to find positions where the user threw away
 * eval, and stores each one as a `type: "mistake"` Anki card in the
 * existing `ochess_review_cards` localStorage. From there the
 * existing SM-2 review flow takes over - mistake cards are first-
 * class citizens alongside puzzle / analysis / game cards.
 *
 * Mistake judgement is delegated to `lib/win-chances.js` so it
 * matches Lichess exactly: classify by *winning-chances delta*,
 * not raw centipawn loss. The thresholds (0.10 / 0.20 / 0.30) are
 * Lichess server-side analysis values from lila PR #5337.
 *
 * Design notes:
 *
 *   - Analysis runs entirely client-side via `lib/engine.js`. We only
 *     analyze the user's moves (skip the opponent's) and only at
 *     moderate depth (12) to keep wall-clock time reasonable on a
 *     typical laptop. ~50 games = ~250 evaluations = ~1 minute.
 *
 *   - The default save floor is wc loss >= 0.10 (Lichess inaccuracy
 *     threshold). This catches everything from "?" to "??" without
 *     drowning the user in <0.10-wc near-perfect moves Lichess
 *     itself wouldn't annotate.
 *
 *   - Each card carries BOTH eval_loss_cp (raw centipawns, for
 *     back-compat) and eval_loss_wc (winning-chances delta in
 *     [0, 1], the new source of truth). New consumers should read
 *     wc; old data without wc can fall back to cp.
 */

import { Chess } from "chess.js";
import { init as initEngine, evaluate } from "./engine";
import {
  scoreToCp as wcScoreToCp,
  winningChances,
  WC_INACCURACY,
  WC_MISTAKE,
  WC_BLUNDER,
} from "./win-chances";

// Re-exports of the Lichess thresholds. cp-equivalents are
// approximate (the wc curve isn't a linear function of cp) and
// only correct from a roughly equal starting eval - use the wc
// thresholds for any real classification work.
export const WC_MISTAKE_FLOOR = WC_INACCURACY; // save floor: 0.10
export { WC_INACCURACY, WC_MISTAKE, WC_BLUNDER };

// Back-compat cp-aliases: chosen so that from an equal start,
// these cp losses cross the corresponding wc threshold. Used by
// UI copy that wants a "lost ~1.3 pawns" hint, NOT for actual
// classification (which goes through the wc functions).
export const MISTAKE_CP_THRESHOLD = 130; // wc(130) ≈ 0.234 (mistake)
export const BLUNDER_CP_THRESHOLD = 185; // wc(185) ≈ 0.317 (blunder)

export const ANALYSIS_DEPTH = 12;
export const OPENING_PLY_LIMIT = 24; // moves 1..12 = opening
export const ENDGAME_PIECE_LIMIT = 16;

/** Stable id for a mistake card, derived from the PGN-source + ply. */
function mistakeId(source, gameId, ply) {
  return `mistake-${source}-${gameId}-${ply}`;
}

/**
 * Collapse a Stockfish score (cp + mate) down to a single user-POV
 * centipawn number. Engines emit `score mate N` separately from
 * `score cp K`; treating mate as 0 makes a missed-mate look like a
 * 0 cp swing, which silently un-flags the worst class of mistake.
 *
 * Mate distance is mapped to a very large cp value so any change
 * between mating / non-mating positions dominates the threshold.
 *
 * Wraps `win-chances.scoreToCp` but in the legacy `eval_cp` /
 * `eval_mate` field shape used by `engine.js`. New code should
 * prefer `win-chances.scoreToCp` directly with `{ cp, mate }`.
 */
export function scoreToUserCp(result) {
  if (!result) return 0;
  // engine.js puts mate in eval_mate; win-chances expects mate.
  if (Number.isFinite(result.eval_mate) && result.eval_mate !== null) {
    return wcScoreToCp({ mate: result.eval_mate });
  }
  if (Number.isFinite(result.eval_cp)) return result.eval_cp;
  return 0;
}

/** Phase classification at a given chess.js position. */
export function inferPhase(chess, ply) {
  if (ply < OPENING_PLY_LIMIT) return "opening";
  let pieces = 0;
  for (const row of chess.board()) for (const sq of row) if (sq) pieces++;
  if (pieces <= ENDGAME_PIECE_LIMIT) return "endgame";
  return "middlegame";
}

/**
 * Heuristic themes derived from a single mistaken move + the engine's
 * recommendation. No LLM - just SAN inspection. Cheap and good enough
 * for the free-text filter ("show me my hanging queen mistakes").
 *
 * Severity tags ("blunder" / "mistake" / "inaccuracy") come from the
 * Lichess winning-chances loss; "hanging_X" heuristics also gate on
 * wc severity so a 100 cp wobble in a lost endgame doesn't claim the
 * user "hung their queen".
 */
export function inferThemes(playedMove, bestMove, evalLossWc) {
  const themes = [];
  if (evalLossWc >= WC_BLUNDER) themes.push("blunder");
  else if (evalLossWc >= WC_MISTAKE) themes.push("mistake");
  else if (evalLossWc >= WC_INACCURACY) themes.push("inaccuracy");
  // SAN inspection - chess.js gives us .san, .piece, .captured, .flags.
  const bestSan = bestMove?.san || "";
  if (bestSan.includes("#")) themes.push("missed_mate");
  if (bestMove?.captured && !playedMove?.captured) themes.push("missed_capture");
  if (playedMove?.captured) themes.push("capture_blunder");
  // Hanging-piece heuristics. Tier each piece against a wc severity
  // appropriate to its value: queens/rooks need a real blunder swing
  // (you don't "hang" a queen for 0.18 wc), minor pieces need at
  // least a mistake swing.
  if (playedMove?.piece === "q" && evalLossWc >= WC_BLUNDER)  themes.push("hanging_queen");
  if (playedMove?.piece === "r" && evalLossWc >= WC_BLUNDER)  themes.push("hanging_rook");
  if (playedMove?.piece === "b" && evalLossWc >= WC_MISTAKE)  themes.push("hanging_bishop");
  if (playedMove?.piece === "n" && evalLossWc >= WC_MISTAKE)  themes.push("hanging_knight");
  return themes;
}

/**
 * Run Stockfish on each of the user's moves in a single PGN and
 * return any mistakes (winning-chances delta >= floor from the
 * user's POV).
 *
 * @param {string} pgn        PGN of the game.
 * @param {string} userColor  "w" or "b" - which side is the user.
 * @param {object} opts
 * @param {AbortSignal=} opts.signal       Cancellation hook.
 * @param {Function=}   opts.onProgress    Called with (movesAnalyzed, totalMoves).
 * @param {number=}     opts.depth         Stockfish depth (default 12).
 * @param {number=}     opts.wcFloor       Min wc loss to count as a mistake (default 0.10 = Lichess inaccuracy).
 * @param {number=}     opts.threshold     Legacy alias - cp floor. Kept for old call sites; ignored when wcFloor is set.
 * @param {object=}     opts.gameMeta      Forwarded onto each mistake card.
 *
 * @returns {Promise<Array>} mistake card objects.
 */
export async function analyzeGameForMistakes(pgn, userColor, opts = {}) {
  const { signal, onProgress, depth = ANALYSIS_DEPTH, gameMeta = {} } = opts;
  // Resolve the floor in wc units. Direct wcFloor opt wins. If the
  // caller still passes a legacy cp `threshold`, convert via the
  // sigmoid (using "from equal" anchor) so old tests keep working.
  const wcFloor = Number.isFinite(opts.wcFloor)
    ? opts.wcFloor
    : Number.isFinite(opts.threshold)
      ? Math.max(0, winningChances(opts.threshold))
      : WC_MISTAKE_FLOOR;
  if (!pgn || (userColor !== "w" && userColor !== "b")) return [];

  // Replay the PGN to extract every position before each user move.
  const replayer = new Chess();
  try { replayer.loadPgn(pgn); } catch { return []; }
  const fullHistory = replayer.history({ verbose: true });
  if (fullHistory.length === 0) return [];

  // Build the list of (positionFen, playedMove, ply) for the user's
  // moves only. ply is 0-indexed - index 0 = white's first move.
  const replay = new Chess();
  const userMoves = [];
  for (let i = 0; i < fullHistory.length; i++) {
    const positionFen = replay.fen();
    const move = fullHistory[i];
    if (move.color === userColor) {
      userMoves.push({ fen: positionFen, move, ply: i });
    }
    replay.move({ from: move.from, to: move.to, promotion: move.promotion });
  }

  if (userMoves.length === 0) return [];

  await initEngine();
  const mistakes = [];
  let analyzed = 0;

  for (const { fen, move, ply } of userMoves) {
    if (signal?.aborted) break;

    // 1. Eval BEFORE the move - what was the best the user could do.
    const before = await evaluate(fen, depth);
    if (signal?.aborted) break;

    // 2. Eval AFTER - actual position after the move was played.
    const afterChess = new Chess(fen);
    try { afterChess.move({ from: move.from, to: move.to, promotion: move.promotion }); } catch { continue; }
    const after = await evaluate(afterChess.fen(), depth);
    if (signal?.aborted) break;

    analyzed++;
    onProgress?.(analyzed, userMoves.length);

    if (!before || !after) continue;

    // Compute eval loss from the user's POV. evaluate() returns
    // score from the side-to-move's POV - positive = side-to-move
    // winning. Before the user's move the user IS the side to move,
    // so before's score is already user-POV regardless of color.
    // After the user's move the OPPONENT is the side to move, so
    // after's score must be flipped to user-POV - again regardless
    // of color.
    //
    // (The previous version flipped on userColor instead, which was
    // a sign error: it cancelled out for white and inverted for
    // black, so Black-side blunders never crossed the threshold.)
    const userPovBefore = scoreToUserCp(before);
    const userPovAfter = -scoreToUserCp(after);
    const evalLossCp = userPovBefore - userPovAfter;

    // The actual judgement is wc-based. cp loss is stored alongside
    // for back-compat with existing UI copy ("lost ~1.3 pawns") but
    // it is NOT what gates the threshold check - per Lichess.
    // Convert both before/after (already in user POV) through the
    // sigmoid and take the difference. Saturation cap inside
    // winningChances() handles missed-mate / hanging-mate cleanly.
    const evalLossWc = winningChances(userPovBefore) - winningChances(userPovAfter);

    if (!Number.isFinite(evalLossWc) || evalLossWc < wcFloor) continue;

    // Extract Stockfish's preferred move from the PV (UCI -> SAN).
    let bestMove = null;
    try {
      if (before.bestMove) {
        const sf = new Chess(fen);
        bestMove = sf.move({
          from: before.bestMove.slice(0, 2),
          to: before.bestMove.slice(2, 4),
          promotion: before.bestMove.length > 4 ? before.bestMove[4] : undefined,
        });
      }
    } catch { /* ignore - bestMove stays null */ }

    const phaseChess = new Chess(fen);
    const phase = inferPhase(phaseChess, ply);
    const themes = inferThemes(move, bestMove, evalLossWc);

    mistakes.push({
      id: mistakeId(gameMeta.source || "import", gameMeta.gameId || gameMeta.id || "x", ply),
      type: "mistake",
      fen,
      played_san: move.san,
      best_san: bestMove?.san || null,
      // Both fields stored. eval_loss_cp keeps existing UI copy
      // working ("lost ~1.3 pawns"). eval_loss_wc is the new source
      // of truth for severity / theme tagging / classification.
      eval_loss_cp: Math.round(evalLossCp),
      eval_loss_wc: Math.round(evalLossWc * 1000) / 1000, // 3 decimals
      phase,
      themes,
      opening: gameMeta.opening || null,
      source: gameMeta.source || "import",
      source_url: gameMeta.url || null,
      game_id: gameMeta.gameId || gameMeta.id || null,
      ply,
      moveNumber: Math.floor(ply / 2) + 1,
      // Keep an `answerMove` so the existing Review handler can grade
      // a self-assessment against the engine's preferred line - same
      // shape PuzzlesPage uses when saving puzzle failures.
      answerMove: bestMove ? { from: bestMove.from, to: bestMove.to, promotion: bestMove.promotion } : null,
      answerText: bestMove?.san
        ? `Stockfish prefers ${bestMove.san} (you played ${move.san}, eval lost ~${(Math.round(evalLossCp) / 100).toFixed(1)} pawns).`
        : null,
      ts: Date.now(),
    });
  }

  return mistakes;
}

/**
 * Categorize a card collection into a weakness profile. Used by the
 * Plan tab to surface "you make 14 middlegame mistakes" stats.
 */
export function buildWeaknessProfile(cards) {
  const phaseCount = { opening: 0, middlegame: 0, endgame: 0 };
  const themeCount = {};
  const sourceCount = {};
  let total = 0;
  for (const c of cards) {
    if (c.type !== "mistake" && c.type !== "puzzle") continue;
    total += 1;
    if (c.phase && phaseCount[c.phase] !== undefined) phaseCount[c.phase] += 1;
    for (const t of c.themes || []) themeCount[t] = (themeCount[t] || 0) + 1;
    if (c.source) sourceCount[c.source] = (sourceCount[c.source] || 0) + 1;
  }
  // Top themes ordered by frequency.
  const topThemes = Object.entries(themeCount)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([theme, count]) => ({ theme, count }));
  return { total, phaseCount, themeCount, topThemes, sourceCount };
}

/**
 * Free-text filter against a card collection. Tokenizes on whitespace
 * and AND-matches each token against a flat searchable representation
 * of the card. No LLM - just substring matching against what the
 * extractors already wrote on the card.
 */
export function filterCardsByQuery(cards, query) {
  if (!query?.trim()) return cards;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return cards.filter((c) => {
    const haystack = [
      c.type,
      c.phase,
      c.played_san,
      c.best_san,
      c.opening,
      c.source,
      ...(Array.isArray(c.themes) ? c.themes : []),
    ].filter(Boolean).join(" ").toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });
}

/**
 * Pre-baked filter chips for one-click drill-downs. Each chip's
 * `match` runs against a card and returns true if the card belongs to
 * the chip's bucket.
 *
 * The "Blunders" chip uses Lichess's wc threshold (>= 0.30 winning-
 * chances delta). Cards saved before the wc switch only carry
 * `eval_loss_cp`; the matcher falls back to the cp-equivalent
 * threshold (~185 cp from equal) so legacy data still classifies
 * sensibly.
 */
function isCardBlunder(c) {
  if (!c) return false;
  const wc = c.eval_loss_wc;
  if (Number.isFinite(wc)) return wc >= WC_BLUNDER;
  const cp = c.eval_loss_cp;
  return Number.isFinite(cp) && cp >= BLUNDER_CP_THRESHOLD;
}

export const COMMON_WEAKNESS_CHIPS = [
  { id: "blunders",     label: "Blunders (??)",    match: isCardBlunder },
  { id: "hanging_q",    label: "Hanging queens",   match: (c) => (c.themes || []).includes("hanging_queen") },
  { id: "missed_mate",  label: "Missed mates",     match: (c) => (c.themes || []).includes("missed_mate") },
  { id: "missed_capture", label: "Missed captures", match: (c) => (c.themes || []).includes("missed_capture") },
  { id: "opening",      label: "Opening mistakes", match: (c) => c.phase === "opening" },
  { id: "middlegame",   label: "Middlegame",       match: (c) => c.phase === "middlegame" },
  { id: "endgame",      label: "Endgame",          match: (c) => c.phase === "endgame" },
];

/**
 * Daily-plan picker.
 *
 *   1. Filter cards to mistakes (or matching `query`/`chip` if given).
 *   2. Sort by recency (oldest first) so the user works through the
 *      backlog instead of repeatedly seeing this morning's mistakes.
 *   3. Slice to `quota` (default 5).
 *
 * `schedules` is the SM-2 schedule map; cards already due bubble up
 * first, then any others. This keeps the queue predictable.
 */
export function buildDailyPlan(cards, schedules, { quota = 5, query = "", chipId = null } = {}) {
  let pool = cards.filter((c) => c.type === "mistake" || c.type === "puzzle");
  if (chipId) {
    const chip = COMMON_WEAKNESS_CHIPS.find((c) => c.id === chipId);
    if (chip) pool = pool.filter(chip.match);
  }
  if (query) pool = filterCardsByQuery(pool, query);

  const due = [];
  const notDue = [];
  for (const c of pool) {
    const id = c.id || `${c.type}|${c.fen}|${c.ts}`;
    if (!schedules || !schedules[id] || isCardDueLite(schedules[id])) due.push(c);
    else notDue.push(c);
  }
  due.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  notDue.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return [...due, ...notDue].slice(0, quota);
}

/** Lightweight in-place "is due now?" check for the planner. */
function isCardDueLite(schedule) {
  if (!schedule || !schedule.dueAt) return true;
  const due = new Date(schedule.dueAt).getTime();
  return Number.isFinite(due) ? due <= Date.now() : true;
}

/**
 * Convert a string like "2026-04-27" to a stable plan-cache key so
 * the Plan tab doesn't re-pick a different five cards every time you
 * navigate back. The plan rebuilds when the date rolls over.
 */
export function planCacheKey(dateStr) {
  return `ochess_study_plan_${dateStr || new Date().toISOString().slice(0, 10)}`;
}
