/**
 * Variant rules for oChess.
 * Each variant wraps chess.js with extra win/draw conditions,
 * multi-move turns, post-move board manipulation, and visibility masking.
 */

import { Chess } from "chess.js";

// ── Helpers ──

function generate960Position() {
  const pieces = Array(8).fill(null);
  const place = (piece, filter) => {
    const open = [];
    for (let i = 0; i < 8; i++) if (pieces[i] === null && (!filter || filter(i))) open.push(i);
    pieces[open[Math.floor(Math.random() * open.length)]] = piece;
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
        const dirs = [];
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

export const VARIANT_DEFS = {
  chess960: {
    name: "Chess960", startFen: () => generate960Position(),
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
    checkCustomEnd: (chess, state) => {
      if (chess.inCheck()) {
        if (chess.turn() === "w") state.checksOnWhite = (state.checksOnWhite || 0) + 1;
        else state.checksOnBlack = (state.checksOnBlack || 0) + 1;
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
      if (totalPieces(chess, turn) === 0) return { result: turn === "w" ? "1-0" : "0-1", reason: "Lost all pieces — you win!" };
      if (chess.moves().length === 0) return { result: turn === "w" ? "1-0" : "0-1", reason: "No moves — you win!" };
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

  torpedo: { name: "Torpedo", startFen: null, checkCustomEnd: () => null },

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

// ── Game wrapper ──

export function createVariantGame(variantId) {
  const def = VARIANT_DEFS[variantId];
  if (!def) return createVariantGame("chess960");
  const fen = typeof def.startFen === "function" ? def.startFen() : def.startFen;
  const chess = fen ? new Chess(fen) : new Chess();
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
      try { result = chess.move(moveObj); } catch { return null; }
      if (!result) return null;

      if (def.afterMove) def.afterMove(chess, result);

      return result;
    },

    checkEnd() {
      const custom = def.checkCustomEnd(chess, state);
      if (custom) return custom;
      if (def.forcedCapture) {
        if (chess.moves().length === 0) {
          const t = chess.turn();
          return { result: t === "w" ? "1-0" : "0-1", reason: "No moves — you win!" };
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
  };
}
