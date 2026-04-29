/**
 * Import validator: should this game make it into Anki review
 * cards?
 *
 * The Stockfish-based mistake detector + chess.js PGN replay
 * assume STANDARD chess rules. Variants (Chess960, Atomic,
 * Crazyhouse, KOTH, 3-check, Antichess, Horde, Racing Kings,
 * etc.) either fail to load or produce nonsense cards because
 * the engine evaluates moves under rules that don't apply.
 *
 * We also drop:
 *   - Unfinished games (Result "*"). The "did the user
 *     blunder" judgement makes no sense if we don't know how
 *     the game ended.
 *   - Ultra-short games (<10 plies). Resignations on move 4
 *     don't have learnable mistake positions.
 *
 * One reason per skip lets the import panel surface a useful
 * "X games skipped (variant)" tally instead of a silent drop.
 *
 * @typedef {Object} ImportableGame
 * @property {string} pgn
 * @property {string} [variant]      Lichess `variant`, Chess.com `rules`, or absent.
 * @property {string} [speed]        Lichess `speed`, Chess.com `time_class`, or absent.
 * @property {string} [perfType]     Lichess perf bucket if known.
 *
 * @typedef {Object} ImportFilterResult
 * @property {boolean} ok
 * @property {string}  [skipReason]  One of: "variant", "incomplete", "too_short", "no_user_color", "no_pgn"
 *                                   when ok is false.
 */

const STANDARD_VARIANT_NAMES = new Set([
  "",
  "standard",
  "chess",
  // Lichess "From Position" reuses standard rules with a
  // custom starting FEN. Allowed because chess.js + Stockfish
  // still give valid analysis. Listed both with and without
  // the space because our normalizer only strips _ and -, not
  // whitespace - and Lichess JSON sends the camelCase form
  // ("fromPosition") which would normalize to "fromposition".
  "from position",
  "fromposition",
]);

const NON_STANDARD_VARIANT_NAMES = new Set([
  "chess960",
  "fischerandom",
  "fischer random",
  "atomic",
  "crazyhouse",
  "antichess",
  "horde",
  "kingofthehill",
  "king of the hill",
  "threecheck",
  "three-check",
  "3check",
  "racingkings",
  "racing kings",
  "bughouse",
  "suicide",
  "giveaway",
  "losers",
]);

/**
 * Read the PGN [Variant "..."] header in a regex-only way (no
 * chess.js dep). Returns "" when the tag is absent.
 */
export function readPgnVariant(pgn) {
  if (typeof pgn !== "string") return "";
  const m = pgn.match(/\[Variant\s+"([^"]*)"\]/i);
  return m ? m[1].trim().toLowerCase() : "";
}

/**
 * Read the PGN [Result "..."] header. Returns "" when absent.
 */
export function readPgnResult(pgn) {
  if (typeof pgn !== "string") return "";
  const m = pgn.match(/\[Result\s+"([^"]*)"\]/i);
  return m ? m[1].trim() : "";
}

/**
 * Normalize a variant string from any source (PGN tag, Lichess
 * JSON, Chess.com JSON, our own internal label) into the
 * lowercased-no-punctuation form we test against the allow /
 * deny lists. Returns "" for nothing/empty.
 */
export function normalizeVariantName(raw) {
  if (raw == null) return "";
  return String(raw).trim().toLowerCase().replace(/[_-]/g, "");
}

/**
 * Decide whether a game is importable for Anki review-card
 * generation. Pure: takes the metadata + pgn we already have,
 * returns ok/skipReason.
 *
 * @param {ImportableGame} game
 * @param {Object} [opts]
 * @param {number} [opts.minPlies]                 Default 10. Games shorter than this are skipped.
 * @returns {ImportFilterResult}
 */
export function isStandardImportableGame(game, opts = {}) {
  const minPlies = Number.isFinite(opts.minPlies) ? opts.minPlies : 10;
  if (!game || !game.pgn) return { ok: false, skipReason: "no_pgn" };

  // Variant gate: prefer caller-supplied metadata if present
  // (Lichess JSON / Chess.com archive surface variant info
  // separately), else fall back to the [Variant] PGN tag. We
  // ALSO check the explicit deny-list because some platforms
  // ship "from position" or "thematic" labels that are still
  // standard-rules with a custom starting FEN.
  const callerVariant = normalizeVariantName(
    game.variant || game.rules || game.perfType
  );
  const headerVariant = normalizeVariantName(readPgnVariant(game.pgn));
  for (const v of [callerVariant, headerVariant]) {
    if (!v) continue;
    if (NON_STANDARD_VARIANT_NAMES.has(v)) {
      return { ok: false, skipReason: "variant" };
    }
    // If the caller supplied a variant name we don't
    // explicitly allow, default to allow ONLY when it's the
    // empty string / standard / from-position. Anything else
    // (e.g. "fromPosition" raw, or future Lichess additions)
    // gets denied to be safe; users can rename their accounts'
    // game pools to standard chess if they want imports.
    if (!STANDARD_VARIANT_NAMES.has(v) && !STANDARD_VARIANT_NAMES.has(v.replace(/\s/g, ""))) {
      return { ok: false, skipReason: "variant" };
    }
  }

  // Completion gate: drop in-progress games. The mistake
  // detector reads the user's whole game vs Stockfish, so a
  // truncated PGN produces partial / misleading cards.
  const result = readPgnResult(game.pgn);
  if (result === "*" || result === "" || result === "?") {
    return { ok: false, skipReason: "incomplete" };
  }

  // Length gate: count plies via the trailing movetext after
  // the headers. Cheap heuristic - count tokens that look
  // like SAN moves. Anything under minPlies is skipped.
  const plies = countPliesFromPgn(game.pgn);
  if (plies < minPlies) {
    return { ok: false, skipReason: "too_short" };
  }

  return { ok: true };
}

/**
 * Cheap ply counter. Strips PGN headers, NAGs, comments, and
 * variations, then counts whitespace-separated SAN-shaped
 * tokens. Not a chess.js replay - just a "is this a real game
 * or two opening moves" gate. Tolerates non-standard
 * annotations because the actual analyzer (chess.js) does the
 * strict parse later.
 */
export function countPliesFromPgn(pgn) {
  if (typeof pgn !== "string") return 0;
  let body = pgn;
  // Drop headers.
  body = body.replace(/\[[^\]]*\]\s*/g, "");
  // Drop comments and variations.
  body = body.replace(/\{[^}]*\}/g, " ");
  // Strip nested variations iteratively (hand-rolled because
  // regex can't balance parens).
  let prev = "";
  while (prev !== body) {
    prev = body;
    body = body.replace(/\([^()]*\)/g, " ");
  }
  // Drop NAGs ($1, $2, ...).
  body = body.replace(/\$\d+/g, " ");
  // Drop game-result tokens.
  body = body.replace(/(1-0|0-1|1\/2-1\/2|\*)/g, " ");
  // Drop move numbers like "12." or "12...".
  body = body.replace(/\d+\.+/g, " ");
  // Tokenize and count SAN-shaped tokens.
  const tokens = body.split(/\s+/).filter(Boolean);
  let n = 0;
  for (const t of tokens) {
    if (/^[KQRBNa-h][a-h1-8x+#=O-]*[QRBN]?[+#]?$/.test(t)) n++;
    else if (/^O-O(-O)?[+#]?$/.test(t)) n++;
    else if (/^[a-h]\d[+#]?$/.test(t)) n++;        // pawn push like e4
    else if (/^[a-h]x[a-h]\d(?:=[QRBN])?[+#]?$/.test(t)) n++; // pawn capture exd5
  }
  return n;
}

/**
 * Filter a list of games by importability, returning the
 * surviving games + a tally of skip reasons. Used by the
 * import panel to surface "X games skipped (variant)" copy.
 *
 * @param {ImportableGame[]} games
 * @param {Object} [opts]
 * @param {number} [opts.minPlies]
 * @returns {{ games: ImportableGame[], skipped: Record<string, number> }}
 */
export function filterImportableGames(games, opts = {}) {
  const out = [];
  const skipped = { variant: 0, incomplete: 0, too_short: 0, no_pgn: 0, no_user_color: 0 };
  for (const g of games || []) {
    const verdict = isStandardImportableGame(g, opts);
    if (verdict.ok) {
      out.push(g);
    } else if (verdict.skipReason && skipped[verdict.skipReason] != null) {
      skipped[verdict.skipReason] += 1;
    }
  }
  return { games: out, skipped };
}

/**
 * Human-readable summary of a skipped-game tally for surfacing
 * in the UI. Returns null when nothing was skipped.
 *
 * @param {Record<string, number>} skipped
 * @returns {string | null}
 */
export function summarizeSkipped(skipped) {
  if (!skipped) return null;
  const parts = [];
  if (skipped.variant > 0) parts.push(`${skipped.variant} variant game${skipped.variant === 1 ? "" : "s"}`);
  if (skipped.incomplete > 0) parts.push(`${skipped.incomplete} unfinished`);
  if (skipped.too_short > 0) parts.push(`${skipped.too_short} too short`);
  if (skipped.no_user_color > 0) parts.push(`${skipped.no_user_color} not yours`);
  if (skipped.no_pgn > 0) parts.push(`${skipped.no_pgn} missing pgn`);
  if (parts.length === 0) return null;
  return `Skipped ${parts.join(", ")}.`;
}
