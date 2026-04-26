const ANNOTATIONS = {
  book:       { glyph: "Book", label: "Book move",   bg: "#a68a64", text: "#fff" },
  brilliant:  { glyph: "!!",   label: "Brilliant",   bg: "#1baca6", text: "#fff" },
  great:      { glyph: "!",    label: "Great move",  bg: "#5c9e31", text: "#fff" },
  best:       { glyph: "★",   label: "Best move",   bg: "#5c9e31", text: "#fff" },
  inaccuracy: { glyph: "?!",   label: "Inaccuracy",  bg: "#e6a817", text: "#fff" },
  mistake:    { glyph: "?",    label: "Mistake",     bg: "#e07020", text: "#fff" },
  blunder:    { glyph: "??",   label: "Blunder",     bg: "#ca3431", text: "#fff" },
};

function mateToRelCp(mate, sign) {
  if (mate == null) return null;
  const absM = Math.abs(mate);
  return (mate > 0 ? 1 : -1) * sign * (10000 - absM);
}

export function classifyMove(evalBefore, evalAfter, movingColor, options = {}) {
  const { isBook = false, isBestMove = false } = options;

  if (isBook) return ANNOTATIONS.book;
  if (!evalBefore || !evalAfter) return null;

  const sign = movingColor === "w" ? 1 : -1;

  const cpBefore = evalBefore.mate != null
    ? mateToRelCp(evalBefore.mate, 1)
    : (evalBefore.cp ?? 0);
  const cpAfter = evalAfter.mate != null
    ? mateToRelCp(evalAfter.mate, 1)
    : (evalAfter.cp ?? 0);
  const loss = (cpBefore - cpAfter) * sign;

  if (evalBefore.mate != null && evalAfter.mate != null) {
    const mateBefore = evalBefore.mate * sign;
    const mateAfter = evalAfter.mate * sign;
    if (mateBefore > 0 && mateAfter < 0) return ANNOTATIONS.blunder;
    if (mateBefore < 0 && mateAfter > 0) return ANNOTATIONS.brilliant;
    if (mateBefore > 0 && mateAfter > 0) {
      if (mateAfter > mateBefore + 3) return ANNOTATIONS.inaccuracy;
      if (isBestMove) return ANNOTATIONS.best;
      return null;
    }
    if (mateBefore < 0 && mateAfter < 0) {
      if (Math.abs(mateAfter) < Math.abs(mateBefore) - 3) return ANNOTATIONS.inaccuracy;
      return null;
    }
  }

  if (loss >= 300) return ANNOTATIONS.blunder;
  if (loss >= 100) return ANNOTATIONS.mistake;
  if (loss >= 50) return ANNOTATIONS.inaccuracy;
  if (isBestMove && loss <= 0) return ANNOTATIONS.brilliant;
  if (loss <= -150) return ANNOTATIONS.great;
  if (loss <= -50) return ANNOTATIONS.great;
  if (isBestMove) return ANNOTATIONS.best;
  return null;
}

export { ANNOTATIONS };
