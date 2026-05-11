/**
 * Variant rules for oChess.
 * Each variant wraps chess.js with extra win/draw conditions,
 * multi-move turns, post-move board manipulation, and visibility masking.
 */

import { Chess } from "chess.js";

// ── Helpers ──

/**
 * Hash a string seed into a 32-bit unsigned integer. Plain string
 * accumulator suitable for non-crypto seeding - the goal is just
 * to make `generate960Position(gameId)` deterministic across two
 * browser clients.
 */
function seedToUint32(seed) {
  if (!seed || typeof seed !== "string") return 0;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h) + seed.charCodeAt(i);
    h |= 0; // 32-bit cast
  }
  return h >>> 0;
}

/** Tiny seeded PRNG (xorshift32). Good enough for picking 960
 *  positions deterministically from a game id; not for crypto. */
function makeSeededRandom(seed) {
  let state = seedToUint32(seed);
  if (state === 0) state = 0x9e3779b9; // any non-zero constant
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/**
 * Generate a Chess960 / Fischer Random starting position.
 *
 * If `seed` is provided (e.g. the gameData.id of an online match)
 * the same seed always yields the same position - both clients in
 * an online game pass the same game id, so they construct the same
 * board even before the first PGN syncs. Without a seed we fall
 * back to `Math.random()` which is the right behavior for local /
 * bot games.
 */
function generate960Position(seed) {
  const rand = seed ? makeSeededRandom(seed) : Math.random;
  const pieces = Array(8).fill(null);
  const place = (piece, filter) => {
    const open = [];
    for (let i = 0; i < 8; i++) if (pieces[i] === null && (!filter || filter(i))) open.push(i);
    pieces[open[Math.floor(rand() * open.length)]] = piece;
  };
  place("b", (i) => i % 2 === 0);
  place("b", (i) => i % 2 === 1);
  place("q"); place("n"); place("n");
  const empty = [];
  for (let i = 0; i < 8; i++) if (pieces[i] === null) empty.push(i);
  pieces[empty[0]] = "r"; pieces[empty[1]] = "k"; pieces[empty[2]] = "r";
  const backRank = pieces.join("");
  const kingFile = pieces.indexOf("k");
  let c = "";
  for (let i = 0; i < 8; i++) if (pieces[i] === "r" && i > kingFile) { c += "K"; break; }
  for (let i = 7; i >= 0; i--) if (pieces[i] === "r" && i < kingFile) { c += "Q"; break; }
  for (let i = 0; i < 8; i++) if (pieces[i] === "r" && i > kingFile) { c += "k"; break; }
  for (let i = 7; i >= 0; i--) if (pieces[i] === "r" && i < kingFile) { c += "q"; break; }
  return `${backRank}/pppppppp/8/8/8/8/PPPPPPPP/${backRank.toUpperCase()} w ${c || "-"} - 0 1`;
}

function countPieces(chess) {
  const board = chess.board();
  const counts = { w: {}, b: {} };
  for (const row of board) for (const sq of row) if (sq) counts[sq.color][sq.type] = (counts[sq.color][sq.type] || 0) + 1;
  return counts;
}

function totalPieces(chess, color) {
  let n = 0;
  for (const row of chess.board()) for (const sq of row) if (sq && sq.color === color) n++;
  return n;
}

function boardToFen(board) {
  let fen = "";
  for (let r = 0; r < 8; r++) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (!p) { empty++; }
      else { if (empty) { fen += empty; empty = 0; } fen += p.color === "w" ? p.type.toUpperCase() : p.type; }
    }
    if (empty) fen += empty;
    if (r < 7) fen += "/";
  }
  return fen;
}

function getVisibleSquares(chess, color) {
  const visible = new Set();
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (p && p.color === color) {
        const sq = String.fromCharCode(97 + f) + (8 - r);
        visible.add(sq);
        try {
          const moves = chess.moves({ square: sq, verbose: true });
          for (const m of moves) { visible.add(m.to); }
        } catch {}
        if (p.type === "p") {
          const dir = color === "w" ? -1 : 1;
          if (f > 0) visible.add(String.fromCharCode(97 + f - 1) + (8 - r - dir));
          if (f < 7) visible.add(String.fromCharCode(97 + f + 1) + (8 - r - dir));
        }
        if (p.type === "k") {
          for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
            if (dr === 0 && df === 0) continue;
            const nr = r + dr, nf = f + df;
            if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) visible.add(String.fromCharCode(97 + nf) + (8 - nr));
          }
        }
      }
    }
  }
  return visible;
}

function maskFen(chess, playerColor) {
  const board = chess.board();
  const visible = getVisibleSquares(chess, playerColor);
  const masked = board.map((row, r) => row.map((sq, f) => {
    if (!sq) return null;
    if (sq.color === playerColor) return sq;
    const sqName = String.fromCharCode(97 + f) + (8 - r);
    return visible.has(sqName) ? sq : null;
  }));
  const fenParts = chess.fen().split(" ");
  return boardToFen(masked) + " " + fenParts.slice(1).join(" ");
}

function rebuildFen(board, oldFen) {
  const parts = oldFen.split(" ");
  return boardToFen(board) + " " + parts.slice(1).join(" ");
}

const STARTING_SQUARES = {
  w: { r: ["a1", "h1"], n: ["b1", "g1"], b: ["c1", "f1"], q: ["d1"], k: ["e1"], p: ["a2","b2","c2","d2","e2","f2","g2","h2"] },
  b: { r: ["a8", "h8"], n: ["b8", "g8"], b: ["c8", "f8"], q: ["d8"], k: ["e8"], p: ["a7","b7","c7","d7","e7","f7","g7","h7"] },
};

// ── Variant definitions ──

const HORDE_FEN = "rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/4K3 w kq - 0 1";
const RACING_FEN = "8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1";
const DUNSANY_FEN = "rnbqkbnr/pppppppp/8/8/PPPPPPPP/PPPPPPPP/PPPPPPPP/4K3 w kq - 0 1";

/**
 * Subset of variants that are supported in online play.
 *
 * To qualify, a variant must round-trip cleanly through chess.js'
 * `loadPgn` so that a mid-game refresh / second tab / opponent's
 * realtime sync rebuilds the same position. That excludes:
 *
 *   - atomic    - `afterMove` mutates the board; chess.js replay
 *                 doesn't re-fire those mutations.
 *   - crazyhouse - uses drop notation that chess.js doesn't parse.
 *
 * The shipped friend-challenge UI hides those two; bots-only stays
 * supported on /variant-game.
 */
export const ONLINE_SUPPORTED_VARIANTS = new Set([
  "standard",
  "antichess",
  "kingOfTheHill",
  "threeCheck",
  "horde",
  "racingKings",
  "fogOfWar",
  "chess960",
  "noCastling",
  "extinction",
  "dunsanys",
  "checkless",
  "peasants",
  "weakArmy",
]);

export function isOnlineSupportedVariant(variantId) {
  return ONLINE_SUPPORTED_VARIANTS.has(variantId);
}

export const VARIANT_DEFS = {
  // "standard" is intentionally a no-op definition so OnlineGameScreen
  // can always go through the variant wrapper instead of branching
  // chess.js vs createVariantGame at every call site. It just exposes
  // raw chess.js with no extra rules.
  standard: {
    name: "Standard",
    startFen: null,
    checkCustomEnd: () => null,
  },
  chess960: {
    name: "Chess960",
    // Accepts an optional seed string. createVariantGame passes
    // the gameData.id from OnlineGameScreen so both browsers in an
    // online match deterministically construct the same start
    // position; bot / local games leave it undefined and get a
    // fresh random one each time.
    startFen: (seed) => generate960Position(seed),
    checkCustomEnd: () => null,
  },

  kingOfTheHill: {
    name: "King of the Hill", startFen: null, hillSquares: ["d4", "d5", "e4", "e5"],
    checkCustomEnd: (chess) => {
      const board = chess.board();
      for (const sq of ["d4", "d5", "e4", "e5"]) {
        const f = sq.charCodeAt(0) - 97, r = 8 - parseInt(sq[1]);
        const p = board[r]?.[f];
        if (p?.type === "k") return { result: p.color === "w" ? "1-0" : "0-1", reason: "King reached the hill!" };
      }
      return null;
    },
  },

  threeCheck: {
    name: "Three-Check", startFen: null,
    // Increment on the MOVE that delivered the check (afterMove)
    // AND defensively in checkCustomEnd when callers bypass the
    // wrapper. `lastCheckedPly` makes the increment idempotent
    // across both paths so polling `checkEnd()` between moves
    // doesn't double-count, and `loadPgn` rebuilds the counter
    // correctly via the wrapper's afterMove replay.
    afterMove: (chess, _move, state) => {
      if (chess.inCheck()) {
        const ply = chess.history().length;
        if (state.lastCheckedPly !== ply) {
          state.lastCheckedPly = ply;
          if (chess.turn() === "w") state.checksOnWhite = (state.checksOnWhite || 0) + 1;
          else state.checksOnBlack = (state.checksOnBlack || 0) + 1;
        }
      }
    },
    checkCustomEnd: (chess, state) => {
      if (chess.inCheck()) {
        const ply = chess.history().length;
        if (state.lastCheckedPly !== ply) {
          state.lastCheckedPly = ply;
          if (chess.turn() === "w") state.checksOnWhite = (state.checksOnWhite || 0) + 1;
          else state.checksOnBlack = (state.checksOnBlack || 0) + 1;
        }
      }
      if ((state.checksOnWhite || 0) >= 3) return { result: "0-1", reason: "Three checks!" };
      if ((state.checksOnBlack || 0) >= 3) return { result: "1-0", reason: "Three checks!" };
      return null;
    },
  },

  noCastling: { name: "No Castling", startFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1", checkCustomEnd: () => null },

  antichess: {
    name: "Antichess", startFen: null, forcedCapture: true,
    checkCustomEnd: (chess) => {
      const turn = chess.turn();
      if (totalPieces(chess, turn) === 0) return { result: turn === "w" ? "1-0" : "0-1", reason: "Lost all pieces - you win!" };
      if (chess.moves().length === 0) return { result: turn === "w" ? "1-0" : "0-1", reason: "No moves - you win!" };
      return null;
    },
  },

  atomic: {
    name: "Atomic", startFen: null, isAtomic: true,
    checkCustomEnd: (chess) => {
      let wK = false, bK = false;
      for (const row of chess.board()) for (const sq of row) {
        if (sq?.type === "k" && sq.color === "w") wK = true;
        if (sq?.type === "k" && sq.color === "b") bK = true;
      }
      if (!wK) return { result: "0-1", reason: "White king destroyed!" };
      if (!bK) return { result: "1-0", reason: "Black king destroyed!" };
      return null;
    },
  },

  racingKings: {
    name: "Racing Kings", startFen: RACING_FEN,
    checkCustomEnd: (chess, state) => {
      const board = chess.board();
      for (let f = 0; f < 8; f++) {
        const p = board[0]?.[f];
        if (p?.type === "k" && p.color === "w") {
          if (chess.turn() === "b") { state.whiteReached8 = true; } else return { result: "1-0", reason: "White reached rank 8!" };
        }
        if (p?.type === "k" && p.color === "b") {
          if (state.whiteReached8) return { result: "1/2-1/2", reason: "Both reached rank 8!" };
          return { result: "0-1", reason: "Black reached rank 8!" };
        }
      }
      if (state.whiteReached8 && chess.turn() === "w") return { result: "1-0", reason: "White reached rank 8 first!" };
      return null;
    },
  },

  horde: {
    name: "Horde", startFen: HORDE_FEN,
    checkCustomEnd: (chess) => {
      const counts = countPieces(chess);
      const wPawns = counts.w.p || 0;
      const wTotal = Object.values(counts.w).reduce((a, b) => a + b, 0);
      if (wPawns === 0 && wTotal <= 1) return { result: "0-1", reason: "All pawns captured!" };
      return null;
    },
  },

  extinction: {
    name: "Extinction", startFen: null,
    checkCustomEnd: (chess, state) => {
      const counts = countPieces(chess);
      for (const color of ["w", "b"]) {
        const prev = state[`prev_${color}`] || {};
        for (const type of Object.keys(prev)) {
          if ((prev[type] || 0) > 0 && (counts[color][type] || 0) === 0) {
            const name = { k: "kings", q: "queens", r: "rooks", b: "bishops", n: "knights", p: "pawns" }[type] || type;
            return { result: color === "w" ? "0-1" : "1-0", reason: `Lost all ${name}!` };
          }
        }
        state[`prev_${color}`] = { ...counts[color] };
      }
      return null;
    },
  },

  torpedo: {
    name: "Torpedo", startFen: null,
    isTorpedo: true,
    checkCustomEnd: () => null,
  },

  // ── NEW: 10 more variants ──

  fogOfWar: {
    name: "Fog of War", startFen: null, isFogOfWar: true,
    checkCustomEnd: () => null,
  },

  rifle: {
    name: "Rifle Chess", startFen: null,
    afterMove: (chess, moveResult) => {
      if (!moveResult.captured) return;
      const board = chess.board();
      const toF = moveResult.to.charCodeAt(0) - 97;
      const toR = 8 - parseInt(moveResult.to[1]);
      const fromF = moveResult.from.charCodeAt(0) - 97;
      const fromR = 8 - parseInt(moveResult.from[1]);
      const piece = board[toR][toF];
      if (piece) {
        board[fromR][fromF] = piece;
        board[toR][toF] = null;
        const newFen = rebuildFen(board, chess.fen());
        chess.load(newFen);
      }
    },
    checkCustomEnd: () => null,
  },

  circe: {
    name: "Circe Chess", startFen: null,
    afterMove: (chess, moveResult) => {
      if (!moveResult.captured) return;
      const capturedColor = moveResult.color === "w" ? "b" : "w";
      const capturedType = moveResult.captured;
      const starts = STARTING_SQUARES[capturedColor][capturedType];
      if (!starts || starts.length === 0) return;
      const board = chess.board();
      for (const sq of starts) {
        const f = sq.charCodeAt(0) - 97;
        const r = 8 - parseInt(sq[1]);
        if (!board[r][f]) {
          board[r][f] = { type: capturedType, color: capturedColor };
          const newFen = rebuildFen(board, chess.fen());
          chess.load(newFen);
          return;
        }
      }
    },
    checkCustomEnd: () => null,
  },

  monster: {
    name: "Monster Chess",
    startFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPP1PPP/4K3 w kq - 0 1",
    movesPerTurn: (turn) => turn === "w" ? 2 : 1,
    checkCustomEnd: () => null,
  },

  marseillais: {
    name: "Marseillais Chess", startFen: null,
    movesPerTurn: (turn, moveNum) => moveNum === 0 && turn === "w" ? 1 : 2,
    checkEndsSequence: true,
    checkCustomEnd: () => null,
  },

  progressive: {
    name: "Progressive Chess", startFen: null,
    movesPerTurn: (turn, moveNum, state) => {
      state.progressiveCount = (state.progressiveCount || 0);
      return state.progressiveCount + 1;
    },
    checkEndsSequence: true,
    checkCustomEnd: () => null,
  },

  dunsanys: {
    name: "Dunsany's Chess", startFen: DUNSANY_FEN,
    checkCustomEnd: (chess) => {
      const counts = countPieces(chess);
      const wPawns = counts.w.p || 0;
      if (wPawns === 0) return { result: "0-1", reason: "All white pawns captured!" };
      const board = chess.board();
      for (let f = 0; f < 8; f++) {
        const p = board[0]?.[f];
        if (p?.type === "p" && p.color === "w") return { result: "1-0", reason: "White pawn reached rank 8!" };
      }
      return null;
    },
  },

  checkless: {
    name: "Checkless Chess", startFen: null, isCheckless: true,
    checkCustomEnd: () => null,
  },

  peasants: {
    name: "Peasants' Revolt",
    startFen: "1nn1k1n1/4p3/8/8/8/8/PPPPPPPP/4K3 w - - 0 1",
    checkCustomEnd: () => null,
  },

  weakArmy: {
    name: "Weak Army",
    startFen: "1nbqkbn1/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQ - 0 1",
    checkCustomEnd: () => null,
  },
};

// Variants the standard `chess.js` + bot engine pair can play without
// generating illegal moves. Variants outside this set either change
// the move rules (atomic, antichess, rifle, circe, torpedo) or require
// information masking (fogOfWar) or asymmetric setup (horde, monster)
// that the standard engine doesn't model. Their UI shows "bot not
// available" and asks the player to challenge a friend instead.
export const BOT_SUPPORTED_VARIANTS = new Set([
  "chess960",
  "kingOfTheHill",
  "threeCheck",
  "noCastling",
]);

export function isBotSupportedVariant(variantId) {
  return BOT_SUPPORTED_VARIANTS.has(variantId);
}

// ── Game wrapper ──

/**
 * Build a variant-aware game wrapper.
 *
 * @param {string} variantId  one of the keys in VARIANT_DEFS
 * @param {object} [opts]
 * @param {string} [opts.seed]  Optional deterministic seed for
 *   variants whose startFen is a function (currently chess960).
 *   Online games pass `gameData.id` so both clients construct the
 *   same starting position before any PGN has synced; local /
 *   bot games leave it unset and get a fresh random position.
 */
export function createVariantGame(variantId, opts = {}) {
  const def = VARIANT_DEFS[variantId];
  if (!def) return createVariantGame("chess960", opts);
  const fen = typeof def.startFen === "function" ? def.startFen(opts?.seed) : def.startFen;
  const chess = fen ? new Chess(fen) : new Chess();
  // Lock in the concrete starting FEN for variants with a
  // function-valued startFen (currently chess960). `loadPgn`
  // replay needs to rebuild from the EXACT same starting
  // position - if we re-called def.startFen() during replay it
  // would draw a fresh random 960 setup and the move list
  // wouldn't apply cleanly. Capturing the resolved FEN once at
  // construction time keeps replay deterministic without
  // forcing every caller to thread the seed back through.
  const initialFen = fen || null;
  const state = { checksOnWhite: 0, checksOnBlack: 0, whiteReached8: false, progressiveCount: 0, turnMoveNum: 0, totalMoveNum: 0 };

  if (variantId === "extinction") {
    const initial = countPieces(chess);
    state.prev_w = { ...initial.w };
    state.prev_b = { ...initial.b };
  }

  const getMovesForTurn = () => {
    if (!def.movesPerTurn) return 1;
    return def.movesPerTurn(chess.turn(), state.totalMoveNum, state);
  };

  return {
    chess, variantId, def, state,
    startFen: chess.fen(),

    move(moveObj) {
      if (def.forcedCapture) {
        const captures = chess.moves({ verbose: true }).filter((m) => m.captured);
        if (captures.length > 0 && !captures.some((c) => c.from === moveObj.from && c.to === moveObj.to)) return null;
      }

      if (def.isCheckless) {
        const testChess = new Chess(chess.fen());
        let testResult;
        try { testResult = testChess.move(moveObj); } catch { return null; }
        if (!testResult) return null;
        if (testChess.inCheck() && !testChess.isCheckmate()) {
          return null;
        }
        chess.load(chess.fen());
      }

      let result;
      try { result = chess.move(moveObj); } catch { result = null; }
      // Torpedo: if chess.js rejected a pawn double-push from a
      // non-starting rank, handle it manually. Verify the path is
      // clear, no capture, and the resulting position is legal.
      if (!result && def.isTorpedo) {
        const from = moveObj.from;
        const to = moveObj.to;
        if (from && to) {
          const piece = chess.get(from);
          const turn = chess.turn();
          if (piece && piece.type === "p" && piece.color === turn) {
            const ff = from.charCodeAt(0) - 97, fr = parseInt(from[1]);
            const tf = to.charCodeAt(0) - 97, tr = parseInt(to[1]);
            const dir = turn === "w" ? 1 : -1;
            const promoRank = turn === "w" ? 8 : 1;
            if (ff === tf && tr === fr + 2 * dir && tr !== promoRank && !chess.get(to)) {
              const midSq = String.fromCharCode(97 + ff) + (fr + dir);
              if (!chess.get(midSq)) {
                const board = chess.board();
                const fromR = 8 - fr, fromF = ff;
                const toR = 8 - tr, toF = tf;
                board[toR][toF] = board[fromR][fromF];
                board[fromR][fromF] = null;
                const newFen = rebuildFen(board, chess.fen());
                const parts = newFen.split(" ");
                parts[1] = turn === "w" ? "b" : "w";
                parts[3] = midSq;
                parts[4] = "0";
                parts[5] = turn === "b" ? String(parseInt(parts[5]) + 1) : parts[5];
                const candidateFen = parts.join(" ");
                const testChess = new Chess(candidateFen);
                // The side that just moved must not be in check
                const prevTurn = turn;
                const testFenParts = candidateFen.split(" ");
                testFenParts[1] = prevTurn;
                try {
                  const checkTest = new Chess(testFenParts.join(" "));
                  if (checkTest.inCheck()) return null;
                } catch { return null; }
                chess.load(candidateFen);
                result = { from, to, color: turn, piece: "p", san: to, flags: "b" };
              }
            }
          }
        }
      }
      if (!result) return null;

      // Pass `state` to afterMove so state-tracking variants
      // (threeCheck etc.) can update their counters on the move
      // that actually delivered the effect, rather than relying
      // on `checkCustomEnd` polling.
      if (def.afterMove) def.afterMove(chess, result, state);

      return result;
    },

    checkEnd() {
      const custom = def.checkCustomEnd(chess, state);
      if (custom) return custom;
      if (def.forcedCapture) {
        if (chess.moves().length === 0) {
          const t = chess.turn();
          return { result: t === "w" ? "1-0" : "0-1", reason: "No moves - you win!" };
        }
        return null;
      }
      if (chess.isCheckmate()) return { result: chess.turn() === "w" ? "0-1" : "1-0", reason: "checkmate" };
      if (chess.isStalemate()) return { result: "1/2-1/2", reason: "stalemate" };
      if (chess.isDraw()) return { result: "1/2-1/2", reason: "draw" };
      return null;
    },

    shouldEndSequence() {
      return def.checkEndsSequence && chess.inCheck();
    },

    getMovesForTurn,

    onTurnStart() {
      const n = getMovesForTurn();
      state.turnMoveNum = 0;
      return n;
    },

    onSubMoveComplete() {
      state.turnMoveNum++;
      state.totalMoveNum++;
    },

    onTurnEnd() {
      if (def.movesPerTurn && variantId === "progressive") {
        state.progressiveCount++;
      }
    },

    fen() { return chess.fen(); },
    turn() { return chess.turn(); },
    history(opts) { return chess.history(opts); },
    pgn() { return chess.pgn(); },
    isGameOver() { return chess.isGameOver() || !!def.checkCustomEnd(chess, state); },
    getCheckCounts() { return { white: state.checksOnWhite || 0, black: state.checksOnBlack || 0 }; },
    getHillSquares() { return def.hillSquares || []; },
    board() { return chess.board(); },

    getMaskedFen(playerColor) {
      if (!def.isFogOfWar) return chess.fen();
      return maskFen(chess, playerColor);
    },

    isMultiMove() { return !!def.movesPerTurn; },
    isFogOfWar() { return !!def.isFogOfWar; },

    // ── chess.js proxy methods used by OnlineGameScreen's shared
    //    code path. These keep the surface symmetric with `new Chess()`
    //    so the same component logic drives both standard and variant
    //    online games. State-tracking variants (e.g. threeCheck) lose
    //    their counters across `loadPgn` because chess.js does not
    //    re-run our `afterMove`; this is a documented degradation
    //    (covered in `ONLINE_SUPPORTED_VARIANTS` comments).
    loadPgn(pgn) {
      chess.loadPgn(pgn);
      // For state-tracking variants we replay through the wrapper so
      // afterMove fires for each move and `state` is reconstructed.
      if (def.afterMove) {
        const moves = chess.history({ verbose: true });
        chess.reset();
        // Use the FEN we resolved at construction time so a future
        // variant with both `afterMove` and a function-valued
        // `startFen` (e.g. seeded chess960 + state tracking) replays
        // against the same starting position both clients agreed on,
        // instead of drawing a fresh random one here.
        if (initialFen) chess.load(initialFen);
        // Reset wrapper state and replay through `move()`.
        for (const k of Object.keys(state)) state[k] = typeof state[k] === "boolean" ? false : (typeof state[k] === "object" ? {} : 0);
        for (const m of moves) {
          try { chess.move({ from: m.from, to: m.to, promotion: m.promotion }); }
          catch { break; }
          if (def.afterMove) def.afterMove(chess, m, state);
        }
      }
    },
    isCheckmate() { return chess.isCheckmate(); },
    isStalemate() { return chess.isStalemate(); },
    isDraw() { return chess.isDraw(); },
    inCheck() { return chess.inCheck(); },
    moves(opts) { return chess.moves(opts); },
  };
}
