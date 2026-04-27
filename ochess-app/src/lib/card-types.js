/**
 * Card-type registry for the Anki review surface.
 *
 * Cards in oChess come from several sources: Lichess puzzle saves,
 * AI-detected mistakes from imported games, hand-saved analysis
 * positions, share-imports, etc. Each source has a slightly
 * different "what is the user supposed to do here" semantics, and
 * the review UI used to flatten them all into "make your move".
 *
 * This registry centralises the per-type metadata so ReviewPage
 * (and any future surface) can render an opinionated UI per type
 * without an `if (card.type === ...)` ladder in every component.
 *
 * Each entry:
 *   id:          card.type string from the writer side
 *   label:       human-readable name (used in deck filters + chips)
 *   short:       1-word version for narrow chips
 *   prompt:      function(card) -> short prompt heading
 *   instruction: function(card) -> sub-instruction below the prompt
 *   color:       Tailwind tone for the type chip
 *   icon:        SVG path data for a 24x24 outlined icon
 *
 * Tone palette (kept narrow on purpose):
 *   blue   - puzzles (familiar tactical-trainer color)
 *   amber  - mistakes from imported games (warning / actionable)
 *   purple - hand-saved analysis (curated reflection)
 *   green  - shared cards (received from another user)
 *   teal   - opening / endgame (theory-style)
 */

const TURN_OF = (card) => ((card?.fen || "").includes(" b ") ? "Black" : "White");

const REGISTRY = {
  puzzle: {
    id: "puzzle",
    label: "Puzzle",
    short: "Puzzle",
    prompt: (card) => `${TURN_OF(card)} to move - find the best move`,
    instruction: (card) =>
      card?.lineMoves?.length > 1
        ? "Play out the line on the board"
        : "Make your move on the board",
    color: "blue",
    iconPath:
      "M4 7h3a2 2 0 012 2v0a2 2 0 01-2 2H4v5h5v-3a2 2 0 012-2v0a2 2 0 012 2v3h5v-5h-3a2 2 0 01-2-2v0a2 2 0 012-2h3V4h-5v3a2 2 0 01-2 2v0a2 2 0 01-2-2V4H4z",
  },
  mistake: {
    id: "mistake",
    label: "From a game",
    short: "Game",
    prompt: (card) => `${TURN_OF(card)} to move - what should you have played?`,
    instruction: (card) =>
      card?.played_san
        ? `You played ${card.played_san}. Find the better move.`
        : "Recall the better move you missed",
    color: "amber",
    iconPath:
      "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z",
  },
  analysis: {
    id: "analysis",
    label: "Analysis position",
    short: "Analysis",
    prompt: (card) => `${TURN_OF(card)} to move - recall the position`,
    instruction: () => "Reveal when you've thought it through",
    color: "purple",
    iconPath:
      "M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5",
  },
  game: {
    id: "game",
    label: "From a game",
    short: "Game",
    prompt: (card) => `${TURN_OF(card)} to move - what did you play?`,
    instruction: () => "Recall the move that was actually played",
    color: "amber",
    iconPath:
      "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z",
  },
  shared: {
    id: "shared",
    label: "Shared with you",
    short: "Shared",
    prompt: (card) => `${TURN_OF(card)} to move`,
    instruction: () => "Imported from a share link",
    color: "green",
    iconPath:
      "M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z",
  },
  tactic: {
    id: "tactic",
    label: "Tactic",
    short: "Tactic",
    prompt: (card) => `${TURN_OF(card)} to move - find the tactic`,
    instruction: () => "Make your move on the board",
    color: "blue",
    iconPath:
      "M4 7h3a2 2 0 012 2v0a2 2 0 01-2 2H4v5h5v-3a2 2 0 012-2v0a2 2 0 012 2v3h5v-5h-3a2 2 0 01-2-2v0a2 2 0 012-2h3V4h-5v3a2 2 0 01-2 2v0a2 2 0 01-2-2V4H4z",
  },
  opening: {
    id: "opening",
    label: "Opening",
    short: "Opening",
    prompt: (card) => `${TURN_OF(card)} to move - opening line`,
    instruction: () => "Recall the principled move from your repertoire",
    color: "teal",
    iconPath:
      "M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21",
  },
  endgame: {
    id: "endgame",
    label: "Endgame",
    short: "Endgame",
    prompt: (card) => `${TURN_OF(card)} to move - endgame technique`,
    instruction: () => "Find the winning method",
    color: "teal",
    iconPath:
      "M16 7.5L12 3.75 8 7.5M16 16.5l-4 3.75-4-3.75",
  },
};

export const CARD_TYPES = Object.values(REGISTRY);

export function getCardType(card) {
  return REGISTRY[card?.type] || REGISTRY.puzzle;
}

/** Tailwind tone class lookup. Each tone gets a 4-class
 *  combo: bg / border / text / dim-text. Centralised so the
 *  individual cards only have to care about the tone name. */
export const TONE_CLASSES = {
  blue:   { bg: "bg-blue-500/10",    border: "border-blue-500/20",    text: "text-blue-400",    dim: "text-blue-400/50" },
  amber:  { bg: "bg-amber-500/10",   border: "border-amber-500/20",   text: "text-amber-400",   dim: "text-amber-400/50" },
  purple: { bg: "bg-purple-500/10",  border: "border-purple-500/20",  text: "text-purple-400",  dim: "text-purple-400/50" },
  green:  { bg: "bg-emerald-500/10", border: "border-emerald-500/20", text: "text-emerald-400", dim: "text-emerald-400/50" },
  teal:   { bg: "bg-teal-500/10",    border: "border-teal-500/20",    text: "text-teal-400",    dim: "text-teal-400/50" },
};
