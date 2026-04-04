import { Chess } from "chess.js";

const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

const PST = {
  p: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  r: [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     0,  0,  0,  5,  5,  0,  0,  0,
  ],
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  k: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20,
  ],
};

function squareIndex(sq) {
  const file = sq.charCodeAt(0) - 97;
  const rank = 8 - parseInt(sq[1]);
  return rank * 8 + file;
}

function pstValue(type, square, color) {
  const table = PST[type];
  if (!table) return 0;
  const idx = squareIndex(square);
  return color === "w" ? table[idx] : table[63 - idx];
}

function evaluate(chess) {
  if (chess.isCheckmate()) {
    return chess.turn() === "w" ? -99999 : 99999;
  }
  if (chess.isDraw() || chess.isStalemate() || chess.isThreefoldRepetition() || chess.isInsufficientMaterial()) {
    return 0;
  }

  const board = chess.board();
  let score = 0;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) continue;
      const sq = String.fromCharCode(97 + c) + (8 - r);
      const val = PIECE_VALUE[piece.type] + pstValue(piece.type, sq, piece.color);
      score += piece.color === "w" ? val : -val;
    }
  }

  const mobility = chess.moves().length;
  score += (chess.turn() === "w" ? 1 : -1) * mobility * 2;

  return score;
}

function orderMoves(moves) {
  return moves.sort((a, b) => {
    const aScore = (a.captured ? PIECE_VALUE[a.captured] * 10 - PIECE_VALUE[a.piece] : 0) + (a.san.includes("+") ? 50 : 0);
    const bScore = (b.captured ? PIECE_VALUE[b.captured] * 10 - PIECE_VALUE[b.piece] : 0) + (b.san.includes("+") ? 50 : 0);
    return bScore - aScore;
  });
}

function minimax(chess, depth, alpha, beta, maximizing) {
  if (depth === 0 || chess.isGameOver()) {
    return evaluate(chess);
  }

  const moves = orderMoves(chess.moves({ verbose: true }));

  if (maximizing) {
    let best = -Infinity;
    for (const move of moves) {
      chess.move(move);
      const val = minimax(chess, depth - 1, alpha, beta, false);
      chess.undo();
      best = Math.max(best, val);
      alpha = Math.max(alpha, val);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const move of moves) {
      chess.move(move);
      const val = minimax(chess, depth - 1, alpha, beta, true);
      chess.undo();
      best = Math.min(best, val);
      beta = Math.min(beta, val);
      if (beta <= alpha) break;
    }
    return best;
  }
}

const BOT_CONFIG = [
  { level: 0, name: "Random",      depth: 0, noise: 0 },
  { level: 1, name: "Rookie",      depth: 1, noise: 400 },
  { level: 2, name: "Patzer",      depth: 1, noise: 200 },
  { level: 3, name: "Club",        depth: 2, noise: 100 },
  { level: 4, name: "Expert",      depth: 3, noise: 40 },
  { level: 5, name: "Master",      depth: 3, noise: 15 },
  { level: 6, name: "Grandmaster", depth: 4, noise: 5 },
  { level: 7, name: "Stockfish",   depth: 4, noise: 0 },
];

function getBotMove(fen, level) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return null;

  const config = BOT_CONFIG[level] || BOT_CONFIG[0];

  if (config.depth === 0) {
    return moves[Math.floor(Math.random() * moves.length)];
  }

  const maximizing = chess.turn() === "w";
  let bestMove = moves[0];
  let bestScore = maximizing ? -Infinity : Infinity;

  for (const move of orderMoves(moves)) {
    chess.move(move);
    let score = minimax(chess, config.depth - 1, -Infinity, Infinity, !maximizing);
    chess.undo();

    if (config.noise > 0) {
      score += (Math.random() - 0.5) * 2 * config.noise;
    }

    if (maximizing ? score > bestScore : score < bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  return bestMove;
}

function getThinkDelay(level) {
  if (level <= 1) return 200;
  if (level <= 3) return 400;
  if (level <= 5) return 600;
  return 800;
}

export { getBotMove, getThinkDelay, BOT_CONFIG };
