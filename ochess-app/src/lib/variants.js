/**
 * Variant definitions for oChess.
 *
 * Standard chess is the default variant. Preset variants are defined here.
 * The architecture supports user-created variants later by extending
 * VariantDefinition with custom rules stored as JSON.
 */

const VARIANTS = [
  {
    id: "standard",
    name: "Standard",
    description: "Classic chess with all the standard rules.",
    initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    isBuiltin: true,
  },
  {
    id: "chess960",
    name: "Chess960",
    description: "Randomized back-rank starting position. Fischer Random.",
    initialFen: null, // generated per game
    isBuiltin: true,
  },
  {
    id: "crazyhouse",
    name: "Crazyhouse",
    description: "Captured pieces can be dropped back on the board.",
    initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    isBuiltin: true,
  },
  {
    id: "kingOfTheHill",
    name: "King of the Hill",
    description: "Win by getting your king to the center 4 squares.",
    initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    isBuiltin: true,
  },
  {
    id: "threeCheck",
    name: "Three-Check",
    description: "Check your opponent three times to win.",
    initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    isBuiltin: true,
  },
  {
    id: "antichess",
    name: "Antichess",
    description: "Lose all your pieces to win. Captures are forced.",
    initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    isBuiltin: true,
  },
  {
    id: "atomic",
    name: "Atomic",
    description: "Captures cause explosions that destroy surrounding pieces.",
    initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    isBuiltin: true,
  },
  {
    id: "horde",
    name: "Horde",
    description: "White has 36 pawns. Black has a standard army.",
    initialFen: "rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1",
    isBuiltin: true,
  },
  {
    id: "racingKings",
    name: "Racing Kings",
    description: "Race your king to the 8th rank. No checks allowed.",
    initialFen: "8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1",
    isBuiltin: true,
  },
];

function getVariant(id) {
  return VARIANTS.find((v) => v.id === id) ?? VARIANTS[0];
}

function getAllVariants() {
  return VARIANTS;
}

function getBuiltinVariants() {
  return VARIANTS.filter((v) => v.isBuiltin);
}

export { getVariant, getAllVariants, getBuiltinVariants };
