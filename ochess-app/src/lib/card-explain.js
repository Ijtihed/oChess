/**
 * Per-card explanations for the Anki review surface.
 *
 * Composes a 1-3 sentence "what happened + why the right move
 * worked" from whatever metadata is on the card. Used in the
 * post-rating Solved / Answer panel.
 *
 * Why local templating instead of an LLM call per card?
 *   - No latency: explanation appears the moment the user
 *     finishes the line.
 *   - No rate-limit budget burn: the existing 3-per-5-min cap on
 *     the AI deck generator stays available for deck creation.
 *   - The card metadata we already store (themes, played_san,
 *     best_san, eval_loss_cp, opening, phase) is enough to write
 *     specific, concrete sentences. A generic LLM doing the same
 *     thing without the original FEN would mostly just rephrase
 *     this metadata anyway.
 *
 * The output reads coach-y on purpose - "you played X, but Y was
 * better because Z". When a card already carries a stored
 * `answerText` or `notes` (set by the writer side, e.g. by
 * AnalysisPage's "save with note"), we prefer that over the
 * templated version.
 */

const PHASE_LABELS = { opening: "opening", middlegame: "middlegame", endgame: "endgame" };

const PIECE_NAME = { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight", P: "pawn" };

/** Pick the most-instructive single theme tag from a card. The
 *  Stockfish analyzer can stamp several at once (e.g. "blunder"
 *  + "hanging_queen" + "missed_capture"); this picks the one
 *  most worth surfacing in a one-line coach note. */
function leadTheme(themes) {
  if (!Array.isArray(themes) || themes.length === 0) return null;
  // Priority order - earlier wins.
  const priority = [
    "missed_mate",
    "hanging_queen", "hanging_rook", "hanging_bishop", "hanging_knight",
    "missed_capture", "capture_blunder",
    "blunder", "mistake",
  ];
  for (const t of priority) if (themes.includes(t)) return t;
  return themes[0];
}

/** SAN -> piece word ("Qxh7" -> "queen"). Returns null on
 *  ambiguous pawn moves so we can fall back to "pawn move". */
function pieceFromSan(san) {
  if (!san) return null;
  const head = san[0];
  if (PIECE_NAME[head]) return PIECE_NAME[head];
  // Pawn moves don't carry a piece letter (e.g. "e4", "exd5").
  if (/^[a-h][1-8x]/.test(san)) return "pawn";
  return null;
}

/** Big-eval-loss copy. Severity buckets are keyed off Lichess
 *  winning-chances loss (the same source of truth as the move
 *  classifier) when present, falling back to centipawns for old
 *  cards saved before the wc switch.
 *
 *  Bands:
 *    decisive: wc >= 0.50  (~250 cp from equal, "game over")
 *    blunder:  wc >= 0.30  (Lichess "??" floor)
 *    mistake:  wc >= 0.20  (Lichess "?" floor)
 *    null:     anything below 0.20 wc - not bucket-worthy
 */
function severity(card) {
  if (!card) return null;
  const wc = card.eval_loss_wc;
  if (Number.isFinite(wc)) {
    if (wc >= 0.50) return "decisive";
    if (wc >= 0.30) return "blunder";
    if (wc >= 0.20) return "mistake";
    return null;
  }
  // Legacy fallback for cards saved before eval_loss_wc was a thing.
  // These thresholds match the *original* cp-based bucketing the
  // explanation copy was authored against, so old cards still read
  // sensibly. They're intentionally more permissive than the wc
  // path (e.g. 350 cp = "blunder" via cp, but ≈ 0.55 wc = "decisive"
  // by Lichess) - we'd rather leave old cards in their historical
  // bucket than re-classify them after the fact.
  const cp = card.eval_loss_cp;
  if (!Number.isFinite(cp)) return null;
  if (cp >= 500) return "decisive";
  if (cp >= 300) return "blunder";
  if (cp >= 150) return "mistake";
  return null;
}

function lossPawns(cp) {
  if (!Number.isFinite(cp) || cp <= 0) return null;
  return (cp / 100).toFixed(cp < 200 ? 1 : 1);
}

/**
 * Build a coach-tone explanation paragraph for a mistake card.
 * Up to 3 sentences:
 *   1. What you played + the size of the loss in pawns.
 *   2. Why the engine line is better, framed by the lead theme.
 *   3. Optional opening / phase context.
 */
function explainMistakeCard(card) {
  const playedSan = card.played_san;
  const bestSan = card.best_san;
  const cp = card.eval_loss_cp;
  const opening = card.opening;
  const phase = PHASE_LABELS[card.phase] || null;
  const theme = leadTheme(card.themes);
  const pawns = lossPawns(cp);
  const sev = severity(card);

  const lines = [];

  // Sentence 1: what you played + how badly.
  if (playedSan && pawns) {
    if (sev === "decisive") {
      lines.push(`You played ${playedSan}. The engine sees this as decisive - down ${pawns} pawns.`);
    } else if (sev === "blunder") {
      lines.push(`You played ${playedSan}, a blunder worth ${pawns} pawns.`);
    } else if (sev === "mistake") {
      lines.push(`You played ${playedSan}. The eval drops by ${pawns} pawns from your position before the move.`);
    } else {
      lines.push(`You played ${playedSan}, losing ${pawns} pawn${pawns === "1.0" ? "" : "s"} of evaluation.`);
    }
  } else if (playedSan) {
    lines.push(`You played ${playedSan}.`);
  }

  // Sentence 2: why the engine's line is better. Framed by theme.
  if (bestSan) {
    const piece = pieceFromSan(bestSan);
    const playedPiece = pieceFromSan(playedSan);
    switch (theme) {
      case "missed_mate":
        lines.push(`${bestSan} was forced mate - look for forcing checks first when the king is exposed.`);
        break;
      case "hanging_queen":
        lines.push(`${bestSan} kept your queen safe. Your last move left it on a square the opponent attacks for free.`);
        break;
      case "hanging_rook":
        lines.push(`${bestSan} kept your rook protected. Always check whether your major pieces are defended before moving them.`);
        break;
      case "hanging_bishop":
      case "hanging_knight": {
        const word = theme === "hanging_bishop" ? "bishop" : "knight";
        lines.push(`${bestSan} kept your ${word} on a defended square. Minor pieces hang easily once their defender moves.`);
        break;
      }
      case "missed_capture":
        lines.push(`${bestSan} grabs material the opponent left undefended. Scan for unprotected pieces every move.`);
        break;
      case "capture_blunder":
        lines.push(`${bestSan} avoids the trade. The capture you made loses material because of the recapture sequence.`);
        break;
      case "blunder":
      case "mistake":
      default:
        if (piece && playedPiece && piece !== playedPiece) {
          lines.push(`${bestSan} was the engine's pick - the ${piece} move keeps the position holding, while your ${playedPiece} move loosens it.`);
        } else {
          lines.push(`${bestSan} was the engine's pick. Compare it to your move and find the difference in tactics or piece activity.`);
        }
    }
  }

  // Sentence 3: opening / phase context. Optional.
  if (opening && phase === "opening") {
    lines.push(`Position from the ${opening}.`);
  } else if (opening && phase) {
    lines.push(`This is a ${phase} position from the ${opening}.`);
  } else if (phase) {
    lines.push(`A ${phase} pattern - worth flagging the next time you reach a similar structure.`);
  }

  return lines.join(" ");
}

/**
 * Build an explanation for a puzzle card. Puzzles carry rating +
 * themes from Lichess but no engine eval, so we lean on the
 * theme tags + the answer move SAN.
 */
function explainPuzzleCard(card) {
  const themes = Array.isArray(card.themes) ? card.themes : [];
  const ratingNote = card.rating ? `Lichess rating ${card.rating}.` : "";
  const themeNote = themes.length > 0 ? `Themes: ${themes.slice(0, 3).join(", ")}.` : "";
  const head = "Solved! ";
  return [head, ratingNote, themeNote].filter(Boolean).join(" ");
}

/**
 * Public surface: pick the right explanation for a card.
 * Prefers a writer-supplied `answerText` or `notes` field if
 * present (those are explicitly authored). Otherwise falls
 * through to a templated coach note based on card type.
 */
export function explainCard(card) {
  if (!card) return "";
  if (typeof card.answerText === "string" && card.answerText.trim()) return card.answerText.trim();
  if (typeof card.notes === "string" && card.notes.trim()) return card.notes.trim();
  if (card.type === "mistake" || card.type === "game") return explainMistakeCard(card);
  if (card.type === "puzzle") return explainPuzzleCard(card);
  return "";
}
