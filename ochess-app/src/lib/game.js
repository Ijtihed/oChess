/**
 * Game session manager — wraps chess.js for oChess game lifecycle.
 *
 * Handles: move validation, game state, PGN export, position snapshots.
 * This is used both client-side and (eventually) server-side for validation.
 *
 * Storage model: moves live in chess.js memory during a game.
 * When the game ends, call toPgn() once and write that single string to the DB.
 * No per-move DB writes. PGN is ~2–5 KB per game.
 */

import { Chess } from "chess.js";

function createGame(options = {}) {
  const fen = options.fen || undefined;
  const chess = fen ? new Chess(fen) : new Chess();

  const headers = {};
  if (options.white) headers.White = options.white;
  if (options.black) headers.Black = options.black;
  if (options.timeControl) headers.TimeControl = options.timeControl;
  if (options.variant) headers.Variant = options.variant;
  if (options.event) headers.Event = options.event;
  if (options.date) headers.Date = options.date;
  else headers.Date = new Date().toISOString().slice(0, 10).replace(/-/g, ".");

  return {
    chess,
    headers,
    clockData: [],
    startedAt: Date.now(),
  };
}

function makeMove(game, move) {
  try {
    const result = game.chess.move(move);
    return result;
  } catch {
    return null;
  }
}

function isLegalMove(game, move) {
  const test = new Chess(game.chess.fen());
  try {
    test.move(move);
    return true;
  } catch {
    return false;
  }
}

function getLegalMoves(game) {
  return game.chess.moves({ verbose: true });
}

function getFen(game) {
  return game.chess.fen();
}

function isGameOver(game) {
  return game.chess.isGameOver();
}

function getResult(game) {
  if (game.chess.isCheckmate()) {
    return game.chess.turn() === "w" ? "0-1" : "1-0";
  }
  if (game.chess.isDraw() || game.chess.isStalemate() || game.chess.isThreefoldRepetition() || game.chess.isInsufficientMaterial()) {
    return "1/2-1/2";
  }
  return null;
}

function getResultReason(game) {
  if (game.chess.isCheckmate()) return "checkmate";
  if (game.chess.isStalemate()) return "stalemate";
  if (game.chess.isThreefoldRepetition()) return "threefold";
  if (game.chess.isInsufficientMaterial()) return "insufficient";
  if (game.chess.isDraw()) return "50-move";
  return null;
}

function recordClock(game, whiteMs, blackMs) {
  game.clockData.push({
    ply: game.chess.history().length,
    wtime: whiteMs,
    btime: blackMs,
  });
}

/**
 * Export the finished game as PGN. This is the one string you write to the DB.
 * Typical size: 2–5 KB. Contains all moves, headers, and result.
 */
function toPgn(game, result) {
  const chess = game.chess;
  const h = { ...game.headers };
  if (result) h.Result = result;
  else h.Result = getResult(game) || "*";

  Object.entries(h).forEach(([key, value]) => {
    chess.header(key, value);
  });

  return chess.pgn();
}

/**
 * Load a game from PGN. Used for analysis, review, replay.
 * chess.js parses this in microseconds — no need for a Move table.
 */
function fromPgn(pgn) {
  const chess = new Chess();
  chess.loadPgn(pgn);
  return { chess, headers: chess.header(), clockData: [], startedAt: null };
}

function getMoveHistory(game) {
  return game.chess.history({ verbose: true });
}

function getPositionAtPly(game, ply) {
  const history = game.chess.history({ verbose: true });
  const temp = new Chess();
  for (let i = 0; i < ply && i < history.length; i++) {
    temp.move(history[i].san);
  }
  return temp.fen();
}

export {
  createGame,
  makeMove,
  isLegalMove,
  getLegalMoves,
  getFen,
  isGameOver,
  getResult,
  getResultReason,
  recordClock,
  toPgn,
  fromPgn,
  getMoveHistory,
  getPositionAtPly,
};
