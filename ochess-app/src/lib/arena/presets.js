/**
 * Hand-curated rule presets for AI Arena Phase 1.
 *
 * Phase 1 doesn't have the AI rule generator wired in yet, so
 * the lobby uses this catalog of ready-made rule modifiers as
 * a placeholder. Each preset returns a rule diff (extends:
 * "vanilla" + overrides) that the engine resolves to a full
 * spec at runtime.
 *
 * The presets are deliberately diverse - they exercise every
 * code path the engine added on top of standard chess so the
 * orchestration loop has confidence the engine works for
 * non-trivial variants:
 *
 *   - "no-castling"        : kills both castling sides on the king spec
 *   - "reverse-pawns"      : pawns can also step 1 backward (no capture)
 *   - "first-to-3-captures": new top-priority win condition
 *   - "king-of-the-hill"   : race-to-squares variant on e4-e5-d4-d5
 *   - "atomic-lite"        : explosion radius 1 on any capture
 *
 * All presets keep a fallback "checkmate" win condition where
 * applicable so games still terminate the standard way when
 * the variant-specific condition doesn't fire.
 *
 * @typedef {Object} ArenaPreset
 * @property {string} id          Stable id used in URLs / DB.
 * @property {string} label       Human-readable name for the picker.
 * @property {string} summary     1-2 sentence description.
 * @property {Object} diff        Rule diff (extends + overrides).
 */

import { vanillaRules } from "./rules";
import { DIR } from "./schema";

/** @type {ArenaPreset[]} */
export const PRESETS = [
  {
    id: "vanilla",
    label: "Standard",
    summary: "Plain chess. Useful as a baseline and for the tie-break sudden-death round.",
    diff: { extends: "vanilla", name: "Standard chess" },
  },

  {
    id: "no-castling",
    label: "No castling",
    summary: "Castling is disabled for both sides. Encourages early king activity.",
    diff: {
      extends: "vanilla",
      name: "No castling",
      description: "Castling is disabled for both sides.",
      pieces: {
        k: {
          castling: {
            kingside: false,
            queenside: false,
            requireUnmoved: true,
            requireEmpty: [],
            requireSafe: [],
          },
        },
      },
    },
  },

  {
    id: "reverse-pawns",
    label: "Reverse pawns",
    summary: "Pawns can step one square backward (no capture). Adds escape options + new tactics.",
    diff: {
      extends: "vanilla",
      name: "Reverse pawns",
      description: "Pawns can also move 1 square backward (no capture).",
      pieces: {
        p: {
          // Replace the entire moves array because we want the
          // standard 4 primitives PLUS the new backward step.
          moves: [
            { kind: "step", dirs: [DIR.N], conditions: { onlyNonCapture: true } },
            { kind: "step", dirs: [[0, 2]], conditions: { onlyFirstMove: true, onlyNonCapture: true } },
            { kind: "step", dirs: [DIR.NE, DIR.NW], conditions: { onlyCapture: true } },
            { kind: "step", dirs: [DIR.NE, DIR.NW], conditions: { enPassant: true } },
            // New: backward 1-step.
            { kind: "step", dirs: [DIR.S], conditions: { onlyNonCapture: true } },
          ],
          promotion: { type: ["n", "b", "r", "q"] },
        },
      },
    },
  },

  {
    id: "first-to-3-captures",
    label: "First to 3 captures",
    summary: "First side to capture 3 enemy pieces wins. Checkmate still wins if it happens first.",
    diff: {
      extends: "vanilla",
      name: "First to 3 captures",
      description: "First color to capture 3 enemy pieces wins. Checkmate still wins if it happens first.",
      // first_to_n_captures comes first so it fires before
      // checkmate when both could trigger on the same ply.
      winConditions: [
        { type: "first_to_n_captures", target: 3 },
        { type: "checkmate" },
      ],
    },
  },

  {
    id: "king-of-the-hill",
    label: "King of the hill",
    summary: "First side to step their king to e4, e5, d4, or d5 wins. Checkmate still wins.",
    diff: {
      extends: "vanilla",
      name: "King of the hill",
      description: "First color to plant their king on a center square (d4/d5/e4/e5) wins.",
      winConditions: [
        {
          type: "race_to_squares",
          piece: "k",
          squaresWhite: ["d4", "d5", "e4", "e5"],
          squaresBlack: ["d4", "d5", "e4", "e5"],
        },
        { type: "checkmate" },
      ],
    },
  },

  {
    id: "atomic-lite",
    label: "Atomic-lite",
    summary: "Captures explode: every non-pawn piece in the surrounding 8 squares is also removed.",
    diff: {
      extends: "vanilla",
      name: "Atomic-lite",
      description: "Captures destroy every non-pawn piece in the surrounding squares.",
      capture: { explosionRadius: 1, convert: false },
      // Atomic chess uses capture-king as the win condition
      // because checkmate detection breaks when the king can
      // be exploded out of existence by a capture chain.
      winConditions: [
        { type: "capture_king" },
        { type: "checkmate" },
      ],
    },
  },
];

/**
 * Look up a preset by id. Returns the resolver-ready diff or
 * null. Vanilla can also be returned by passing `null` /
 * undefined as a convenience (used by the tie-break round).
 */
export function presetById(id) {
  if (!id) return PRESETS.find((p) => p.id === "vanilla");
  return PRESETS.find((p) => p.id === id) || null;
}

/**
 * The vanilla full-spec rules object, exposed for callers that
 * want the resolved form without going through the resolver
 * (e.g. the tie-break round renderer that wants to skip the
 * resolveRules() call entirely).
 */
export function vanillaPresetResolved() {
  return vanillaRules();
}
