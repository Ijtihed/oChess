/**
 * Pure-function orchestrator for AI Arena match flow.
 *
 * No React, no Supabase, no DOM. Every function takes a state
 * snapshot and returns the next state (or a derived value).
 * Makes the state machine easy to test and lets the UI stay
 * thin: components just dispatch actions and re-render against
 * the new snapshot.
 *
 * The orchestrator owns three responsibilities:
 *
 *   1. Color assignment per round.
 *      - Round 1: creator (rule designer) plays Black, joiner
 *        plays White. Designer-as-Black gives the opponent
 *        the slight first-move advantage to compensate for
 *        the designer knowing the rules they wrote.
 *      - Round 2: mirror. Joiner plays Black under their own
 *        rules.
 *      - Tie-break: same shape as round 1 (creator Black) but
 *        with vanilla rules and a 1+0 clock.
 *
 *   2. Round-end resolution.
 *      - Translates a {ended, winner: 'w'|'b'|null} GameStatus
 *        from the engine into a {winner: 'creator'|'joiner'|null}
 *        result.
 *      - Logs the round into match_result.rounds.
 *      - Decides what status to advance to: warmup_round_2 ->
 *        round_2 -> tiebreak (only when 1-1) -> done.
 *
 *   3. Match-result resolver.
 *      - 2-0 / 0-2 -> match winner.
 *      - 1-1 -> tie-break determines winner.
 *      - Tie-break draws -> match drawn.
 *
 * `match_result` shape stored in the room row:
 *   {
 *     winner: "creator" | "joiner" | null,
 *     score: { creator: number, joiner: number },
 *     rounds: [
 *       {
 *         round: 1 | 2 | "tiebreak",
 *         winner: "creator" | "joiner" | null,
 *         reason: string,                // engine GameStatus.reason
 *         endedAt: ISO string,
 *         finalFen: string,
 *         plyCount: number,
 *         clockSpent: { creator: ms, joiner: ms },  // optional
 *       },
 *       ...
 *     ],
 *   }
 */

// ── Constants ─────────────────────────────────────────────

/**
 * Per-round time control. 10-minute base + 0 increment for
 * rounds 1 / 2; 1-minute base + 0 increment for the tie-break.
 * Times are in MILLISECONDS so they line up with the
 * deadline-based clock module.
 */
export const ROUND_CLOCK_MS = 10 * 60 * 1000;
export const TIEBREAK_CLOCK_MS = 1 * 60 * 1000;

/** Status names live here so the UI doesn't sprinkle string literals. */
export const STATUS = Object.freeze({
  WAITING_FOR_JOINER: "waiting_for_joiner",
  PROMPTING: "prompting",
  WARMUP_ROUND_1: "warmup_round_1",
  ROUND_1: "round_1",
  WARMUP_ROUND_2: "warmup_round_2",
  ROUND_2: "round_2",
  TIEBREAK: "tiebreak",
  DONE: "done",
});

// ── Color assignment ─────────────────────────────────────

/**
 * Determine which color a given role plays in a given round.
 *
 * Round 1 + tiebreak: creator = Black, joiner = White.
 * Round 2: creator = White, joiner = Black.
 *
 * @param {"creator"|"joiner"} role
 * @param {"round_1"|"round_2"|"tiebreak"} status
 * @returns {"w"|"b"}
 */
export function colorFor(role, status) {
  const swap = status === "round_2";
  if (role === "creator") return swap ? "w" : "b";
  return swap ? "b" : "w";
}

/**
 * Given a roundLabel (1, 2, or "tiebreak"), return the
 * { creator, joiner } color pair used for that round.
 */
export function colorPairFor(roundLabel) {
  const status = roundLabel === 2 ? "round_2" : "round_1";
  return {
    creator: colorFor("creator", status),
    joiner: colorFor("joiner", status),
  };
}

// ── Round result resolution ──────────────────────────────

/**
 * Take a GameStatus from the engine + the round we're on +
 * who played which color, and return a round-result entry
 * suitable for `match_result.rounds`.
 *
 * `reasonOverride` lets callers stamp a non-engine reason
 * like "resigned" or "clock expired" while still piggy-backing
 * on the orchestrator's color/role math. When set, it
 * overrides the engine's reason but the winner is still
 * resolved from the explicit `forcedWinnerColor` parameter.
 *
 * @param {Object} args
 * @param {1|2|"tiebreak"} args.round
 * @param {Object} args.gameStatus            { ended, winner, reason }
 * @param {string} [args.reasonOverride]
 * @param {("w"|"b")} [args.forcedWinnerColor]
 * @param {string} args.finalFen
 * @param {number} args.plyCount
 * @param {Object} [args.clockSpent]          { creator: ms, joiner: ms }
 * @param {string} [args.endedAt]             ISO timestamp; defaults to now.
 * @returns {Object} round entry
 */
export function buildRoundEntry({
  round,
  gameStatus,
  reasonOverride,
  forcedWinnerColor,
  finalFen,
  plyCount,
  clockSpent,
  endedAt,
}) {
  const colorPair = colorPairFor(round);
  const winnerColor = forcedWinnerColor || gameStatus?.winner || null;
  let winnerRole = null;
  if (winnerColor === colorPair.creator) winnerRole = "creator";
  else if (winnerColor === colorPair.joiner) winnerRole = "joiner";
  return {
    round,
    winner: winnerRole,
    reason: reasonOverride || gameStatus?.reason || "unknown",
    endedAt: endedAt || new Date().toISOString(),
    finalFen,
    plyCount,
    ...(clockSpent ? { clockSpent } : {}),
  };
}

/**
 * Append a round entry to the match_result and recompute the
 * score totals. Pure: returns a new match_result object,
 * doesn't mutate the input.
 *
 * @param {Object} matchResult                 Existing match_result (or null)
 * @param {Object} roundEntry                  Entry from buildRoundEntry
 * @returns {Object} updated match_result
 */
export function appendRound(matchResult, roundEntry) {
  const prevRounds = Array.isArray(matchResult?.rounds) ? matchResult.rounds : [];
  // Defensive: ignore duplicate calls for the same round so a
  // double-fired effect can't double-count the score.
  if (prevRounds.some((r) => r.round === roundEntry.round)) {
    return matchResult || { winner: null, score: { creator: 0, joiner: 0 }, rounds: prevRounds };
  }
  const rounds = [...prevRounds, roundEntry];
  const score = scoreFromRounds(rounds);
  return { winner: null, ...(matchResult || {}), rounds, score };
}

/**
 * Compute the (creator, joiner) score from a round list.
 * Rounds 1 and 2 are full points; tie-break is a single
 * sudden-death point that resolves the match. Draws contribute
 * 0.5 to each (rare in chess but possible via stalemate).
 */
export function scoreFromRounds(rounds) {
  const score = { creator: 0, joiner: 0 };
  for (const r of rounds || []) {
    if (r.winner === "creator") score.creator += 1;
    else if (r.winner === "joiner") score.joiner += 1;
    else { score.creator += 0.5; score.joiner += 0.5; }
  }
  return score;
}

/**
 * Given the rounds completed so far, decide what status the
 * room should advance to. Doesn't perform the write - the
 * caller passes the result to updateRoom().
 *
 * The state machine post-warmup:
 *
 *   warmup_round_1 -> round_1
 *   round_1 ends   -> warmup_round_2
 *   warmup_round_2 -> round_2
 *   round_2 ends   -> tiebreak  (only if score is 1-1)
 *                  -> done      (otherwise)
 *   tiebreak ends  -> done
 *
 * `currentStatus` is the room's status when round_X just
 * concluded, so for round_1 ending it's "round_1" (the caller
 * already attached the round_1 entry to match_result before
 * calling).
 *
 * @param {string} currentStatus
 * @param {Object} matchResult                 Updated AFTER the round entry was appended
 * @returns {string} next status
 */
export function nextStatusAfterRound(currentStatus, matchResult) {
  if (currentStatus === "round_1") return "warmup_round_2";
  if (currentStatus === "round_2") {
    const score = matchResult?.score || scoreFromRounds(matchResult?.rounds);
    if (score.creator === score.joiner) return "tiebreak";
    return "done";
  }
  if (currentStatus === "tiebreak") return "done";
  // warmup -> round transitions are handled by the warmup
  // component's both-ready logic; if we get one of those
  // statuses here, just hand it back.
  return currentStatus;
}

// ── Match resolution ─────────────────────────────────────

/**
 * Final match winner from the rounds list. Used at status =
 * "done" to render the results screen.
 *
 *   2-0  -> creator wins
 *   0-2  -> joiner wins
 *   1.5-0.5 (a draw and a win) -> winner of the win
 *   tiebreak winner takes the match in the 1-1 case
 *   tiebreak draw -> match drawn
 */
export function resolveMatchWinner(matchResult) {
  if (!matchResult) return null;
  const rounds = Array.isArray(matchResult.rounds) ? matchResult.rounds : [];
  // Tie-break is the trump card.
  const tb = rounds.find((r) => r.round === "tiebreak");
  if (tb) return tb.winner; // null = draw
  const score = matchResult.score || scoreFromRounds(rounds);
  if (score.creator > score.joiner) return "creator";
  if (score.joiner > score.creator) return "joiner";
  return null;
}

/**
 * Finalize the match_result: stamp the winner and return the
 * new object. Caller writes this back to arena_rooms with
 * status='done'.
 */
export function finalizeMatch(matchResult) {
  if (!matchResult) return { winner: null, score: { creator: 0, joiner: 0 }, rounds: [] };
  return { ...matchResult, winner: resolveMatchWinner(matchResult) };
}

// ── Helpers ──────────────────────────────────────────────

/** Has the match reached a conclusive 2-0 / 0-2 before tie-break? */
export function isMatchDecidedEarly(matchResult) {
  const score = matchResult?.score || scoreFromRounds(matchResult?.rounds);
  return Math.abs(score.creator - score.joiner) >= 2;
}

/** Map a round label to the corresponding clock budget. */
export function clockBudgetFor(roundLabel) {
  return roundLabel === "tiebreak" ? TIEBREAK_CLOCK_MS : ROUND_CLOCK_MS;
}

/** Status -> roundLabel coercion used by the round-play UI. */
export function roundLabelFor(status) {
  if (status === "round_1") return 1;
  if (status === "round_2") return 2;
  if (status === "tiebreak") return "tiebreak";
  return null;
}
