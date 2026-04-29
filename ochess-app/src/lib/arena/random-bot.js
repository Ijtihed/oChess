/**
 * Tiny dumb-as-rocks bot for the AI Arena warmup phase.
 *
 * Picks a uniformly random legal move under the active rules.
 * No evaluation, no preference, no opening book. The point is
 * to give the human something to push pieces against for ~30
 * seconds before the real 1v1 starts - it's a sparring dummy,
 * not an opponent.
 *
 * The bot DOES respect the variant rules (because move-gen
 * does the work), so a "first to 3 captures" warmup will see
 * the bot capture pieces just as readily as the human can.
 *
 * Optional thinking delay so the move doesn't appear instantly
 * and the user gets the sense something happened. The default
 * range (200-450ms) is short enough that the warmup feels live
 * without dragging.
 */

import { generateLegalMoves } from "./move-gen";

/**
 * Pick a random legal move from the position. Returns null if
 * there are no legal moves (game over for this color).
 *
 * @param {import("./position").Position} position
 * @param {import("./schema").Rules}     rules
 * @param {() => number} [random]                Inject a deterministic RNG; defaults to Math.random.
 */
export function pickRandomMove(position, rules, random = Math.random) {
  const moves = generateLegalMoves(position, rules);
  if (moves.length === 0) return null;
  const idx = Math.floor(random() * moves.length) % moves.length;
  return moves[idx];
}

/**
 * Promise wrapper for use in the warmup UI - resolves to the
 * picked move after a short randomized delay so the bot's
 * move doesn't slam onto the board the same frame as the
 * human's. Cancellable via AbortSignal so navigating away
 * mid-warmup doesn't fire moves on an unmounted board.
 *
 * @param {import("./position").Position} position
 * @param {import("./schema").Rules}     rules
 * @param {Object} [opts]
 * @param {number} [opts.minMs]            Default 200.
 * @param {number} [opts.maxMs]            Default 450.
 * @param {AbortSignal} [opts.signal]      Cancellation hook.
 * @param {() => number} [opts.random]     Deterministic RNG injection.
 * @returns {Promise<import("./schema").Move|null>}
 */
export function pickRandomMoveAsync(position, rules, opts = {}) {
  const random = typeof opts.random === "function" ? opts.random : Math.random;
  const minMs = Number.isFinite(opts.minMs) ? opts.minMs : 200;
  const maxMs = Number.isFinite(opts.maxMs) ? opts.maxMs : 450;
  const delayMs = Math.max(0, minMs + (maxMs - minMs) * random());
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve(pickRandomMove(position, rules, random));
    }, delayMs);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    function cleanup() {
      clearTimeout(t);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    }
    if (opts.signal) opts.signal.addEventListener("abort", onAbort);
  });
}
