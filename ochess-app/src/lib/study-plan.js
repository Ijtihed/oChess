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
 * Design notes:
 *
 *   - Analysis runs entirely client-side via `lib/engine.js`. We only
 *     analyze the user's moves (skip the opponent's) and only at
 *     moderate depth (12) to keep wall-clock time reasonable on a
 *     typical laptop. ~50 games = ~250 evaluations = ~1 minute.
 *
 *   - The "mistake" threshold is conservative (eval drop >= 100 cp).
 *     That covers the standard "mistake / blunder" buckets without
 *     drowning the user in trivial inaccuracies.
 *
 *   - Each card carries enough metadata for the free-text filter and
 *     the weakness profile: phase, themes, opening, played_san,
 *     best_san, eval_loss_cp, source, ply.
 */

import { Chess } from "chess.js";
import { init as initEngine, evaluate } from "./engine";

export const MISTAKE_CP_THRESHOLD = 100;
export const BLUNDER_CP_THRESHOLD = 300;
export const ANALYSIS_DEPTH = 12;
export const OPENING_PLY_LIMIT = 24; // moves 1..12 = opening
export const ENDGAME_PIECE_LIMIT = 16;

/** Stable id for a mistake card, derived from the PGN-source + ply. */
function mistakeId(source, gameId, ply) {
  return `mistake-${source}-${gameId}-${ply}`;
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
 */
export function inferThemes(playedMove, bestMove, evalLossCp) {
  const themes = [];
  if (evalLossCp >= BLUNDER_CP_THRESHOLD) themes.push("blunder");
  else if (evalLossCp >= MISTAKE_CP_THRESHOLD) themes.push("mistake");
  // SAN inspection - chess.js gives us .san, .piece, .captured, .flags.
  const playedSan = playedMove?.san || "";
  const bestSan = bestMove?.san || "";
  if (bestSan.includes("#")) themes.push("missed_mate");
  if (bestMove?.captured && !playedMove?.captured) themes.push("missed_capture");
  if (playedMove?.captured) themes.push("capture_blunder");
  // Hanging-piece heuristic: lost a queen / rook with no compensation.
  if (playedMove?.piece === "q" && evalLossCp >= BLUNDER_CP_THRESHOLD) themes.push("hanging_queen");
  if (playedMove?.piece === "r" && evalLossCp >= BLUNDER_CP_THRESHOLD) themes.push("hanging_rook");
  if (playedMove?.piece === "b" && evalLossCp >= 200) themes.push("hanging_bishop");
  if (playedMove?.piece === "n" && evalLossCp >= 200) themes.push("hanging_knight");
  return themes;
}

/**
 * Run Stockfish on each of the user's moves in a single PGN and
 * return any mistakes (eval drop >= threshold from the user's POV).
 *
 * @param {string} pgn        PGN of the game.
 * @param {string} userColor  "w" or "b" - which side is the user.
 * @param {object} opts
 * @param {AbortSignal=} opts.signal       Cancellation hook.
 * @param {Function=}   opts.onProgress    Called with (movesAnalyzed, totalMoves).
 * @param {number=}     opts.depth         Stockfish depth (default 12).
 * @param {number=}     opts.threshold     Min eval drop to count as a mistake (cp).
 * @param {object=}     opts.gameMeta      Forwarded onto each mistake card.
 *
 * @returns {Promise<Array>} mistake card objects.
 */
export async function analyzeGameForMistakes(pgn, userColor, opts = {}) {
  const { signal, onProgress, depth = ANALYSIS_DEPTH, threshold = MISTAKE_CP_THRESHOLD, gameMeta = {} } = opts;
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

    analyzed++;
    onProgress?.(analyzed, userMoves.length);

    if (!before || !after) continue;

    // Compute eval loss from the user's POV. evaluate() returns
    // eval_cp from the side-to-move's POV, so we flip when needed.
    const userPovBefore = userColor === "w" ? (before.eval_cp ?? 0) : -(before.eval_cp ?? 0);
    // After the user moves, it's the opponent's turn - flip back.
    const userPovAfter  = userColor === "w" ? -(after.eval_cp ?? 0) : (after.eval_cp ?? 0);
    const evalLossCp = userPovBefore - userPovAfter;

    if (!Number.isFinite(evalLossCp) || evalLossCp < threshold) continue;

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
    const themes = inferThemes(move, bestMove, evalLossCp);

    mistakes.push({
      id: mistakeId(gameMeta.source || "import", gameMeta.gameId || gameMeta.id || "x", ply),
      type: "mistake",
      fen,
      played_san: move.san,
      best_san: bestMove?.san || null,
      eval_loss_cp: Math.round(evalLossCp),
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
 */
export const COMMON_WEAKNESS_CHIPS = [
  { id: "blunders",     label: "Blunders (>3pp)", match: (c) => (c.eval_loss_cp || 0) >= BLUNDER_CP_THRESHOLD },
  { id: "hanging_q",    label: "Hanging queens",  match: (c) => (c.themes || []).includes("hanging_queen") },
  { id: "missed_mate",  label: "Missed mates",    match: (c) => (c.themes || []).includes("missed_mate") },
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
