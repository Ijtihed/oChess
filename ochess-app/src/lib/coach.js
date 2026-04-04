/**
 * AI Coach for oChess.
 *
 * Architecture:
 * 1. CoachProvider interface — any provider implements explainPuzzle(), explainMove(), etc.
 * 2. LocalCoach — generates explanations from chess.js analysis (no API needed)
 * 3. LLMCoach — sends position + context to an LLM API (OpenAI, Anthropic, Ollama)
 *
 * The active provider is selected at runtime. LocalCoach works offline.
 * LLMCoach requires an API key or local Ollama instance.
 *
 * To add a new provider:
 *   1. Implement the CoachProvider interface
 *   2. Register it with setProvider()
 */

import { Chess } from "chess.js";

let activeProvider = null;

const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };

function pieceName(type) { return PIECE_NAMES[type] || type; }

function materialCount(fen) {
  const board = fen.split(" ")[0];
  let w = 0, b = 0;
  for (const ch of board) {
    const lower = ch.toLowerCase();
    if (PIECE_VALUES[lower]) {
      if (ch === ch.toUpperCase()) w += PIECE_VALUES[lower];
      else b += PIECE_VALUES[lower];
    }
  }
  return { white: w, black: b, advantage: w - b };
}

function analyzeMoveContext(fen, moveSan) {
  const g = new Chess(fen);
  const moves = g.moves({ verbose: true });
  const move = moves.find((m) => m.san === moveSan);
  if (!move) return null;

  g.move(move);
  const isCheck = g.isCheck();
  const isCheckmate = g.isCheckmate();
  const isCapture = !!move.captured;
  const capturedPiece = move.captured ? pieceName(move.captured) : null;
  const movingPiece = pieceName(move.piece);
  const matBefore = materialCount(fen);
  const matAfter = materialCount(g.fen());
  const matSwing = Math.abs(matAfter.advantage) - Math.abs(matBefore.advantage);

  const opponentMoves = g.moves({ verbose: true });
  const opponentCaptures = opponentMoves.filter((m) => m.captured);
  const threats = opponentMoves.filter((m) => {
    const test = new Chess(g.fen());
    test.move(m);
    return test.isCheck();
  });

  return {
    move, movingPiece, isCheck, isCheckmate, isCapture, capturedPiece,
    matBefore, matAfter, matSwing,
    opponentMoveCount: opponentMoves.length,
    opponentCaptures: opponentCaptures.length,
    threats: threats.length,
    fenAfter: g.fen(),
  };
}

function generateLocalExplanation(fen, solutionMoves, themes = []) {
  if (!solutionMoves || solutionMoves.length < 2) return "Analyze the position carefully.";

  const setupSan = solutionMoves[0];
  const playerSan = solutionMoves[1];
  const ctx = analyzeMoveContext(fen, setupSan);
  if (!ctx) return "Study the position to find the tactical idea.";

  const g2 = new Chess(ctx.fenAfter);
  const playerMoves = g2.moves({ verbose: true });
  const playerMove = playerMoves.find((m) => m.san === playerSan);

  const parts = [];

  if (playerMove) {
    g2.move(playerMove);
    const afterPlayer = g2.fen();

    if (playerMove.san.includes("#")) {
      parts.push(`${playerSan} delivers checkmate.`);
    } else if (playerMove.san.includes("+")) {
      parts.push(`${playerSan} gives check with the ${pieceName(playerMove.piece)}.`);
      if (playerMove.captured) {
        parts.push(`It also captures the ${pieceName(playerMove.captured)}, winning material.`);
      }
    } else if (playerMove.captured) {
      parts.push(`${playerSan} captures the ${pieceName(playerMove.captured)} with the ${pieceName(playerMove.piece)}.`);
      const matCtx = materialCount(afterPlayer);
      const swing = Math.abs(matCtx.advantage) - Math.abs(materialCount(ctx.fenAfter).advantage);
      if (swing >= 2) {
        parts.push(`This wins significant material.`);
      }
    } else {
      parts.push(`${playerSan} moves the ${pieceName(playerMove.piece)}.`);
    }

    if (solutionMoves.length > 3) {
      parts.push(`The combination continues for ${Math.ceil((solutionMoves.length - 1) / 2)} moves.`);
    }
  }

  if (themes.length > 0) {
    const themeExplanations = {
      fork: "The key idea is a fork — one piece attacks multiple targets simultaneously.",
      pin: "This involves a pin — a piece can't move without exposing a more valuable piece.",
      skewer: "A skewer forces a valuable piece to move, exposing what's behind it.",
      sacrifice: "The solution requires a sacrifice — giving up material for a decisive advantage.",
      mateIn1: "There's a forced checkmate in one move.",
      mateIn2: "There's a forced checkmate in two moves.",
      discoveredAttack: "A discovered attack — moving one piece reveals an attack from another.",
      backRankMate: "The back rank is weak — the king is trapped with no escape squares.",
      deflection: "Deflection — forcing a defender away from its critical duty.",
      attraction: "Attraction — luring a piece to a square where it can be exploited.",
      hangingPiece: "There's an undefended piece that can be captured for free.",
      crushing: "This move creates a crushing advantage that's impossible to recover from.",
      endgame: "Precise endgame technique is required here.",
    };

    for (const t of themes) {
      if (themeExplanations[t]) { parts.push(themeExplanations[t]); break; }
    }
  }

  if (parts.length === 0) {
    parts.push("This position requires careful calculation to find the best continuation.");
  }

  return parts.join(" ");
}

const LocalCoach = {
  name: "Local",

  async explainPuzzle(fen, solutionSAN, themes) {
    return generateLocalExplanation(fen, solutionSAN, themes);
  },

  async explainMove(fen, moveSan) {
    const ctx = analyzeMoveContext(fen, moveSan);
    if (!ctx) return "Analyze this move in context.";

    const parts = [];
    if (ctx.isCheckmate) parts.push(`${moveSan} is checkmate!`);
    else if (ctx.isCheck) parts.push(`${moveSan} gives check.`);

    if (ctx.isCapture) parts.push(`Captures the ${ctx.capturedPiece}.`);
    if (ctx.matSwing >= 3) parts.push("This wins significant material.");
    if (ctx.opponentMoveCount <= 3) parts.push("The opponent has very few options.");

    return parts.join(" ") || `${moveSan} improves the position.`;
  },

  async reviewGame(pgn) {
    return "Game review requires deeper analysis. Use the analysis board with engine evaluation for detailed insights.";
  },
};

/**
 * LLM Coach stub — replace with real API calls.
 * Supports: OpenAI, Anthropic, Ollama (local).
 *
 * To activate:
 *   import { setProvider, createLLMCoach } from './coach';
 *   setProvider(createLLMCoach({ provider: 'openai', apiKey: '...', model: 'gpt-4o-mini' }));
 */
function createLLMCoach(config = {}) {
  const { provider = "openai", apiKey, model = "gpt-4o-mini", baseUrl } = config;

  const urls = {
    openai: "https://api.openai.com/v1/chat/completions",
    anthropic: "https://api.anthropic.com/v1/messages",
    ollama: (baseUrl || "http://localhost:11434") + "/api/chat",
  };

  return {
    name: `LLM (${provider})`,

    async explainPuzzle(fen, solutionSAN, themes) {
      const prompt = `You are a chess coach. Explain this puzzle concisely in 2-3 sentences.
Position (FEN): ${fen}
Solution: ${solutionSAN.join(" ")}
Themes: ${themes.join(", ")}
Explain why the first player move is correct and what tactical idea it exploits.`;

      return callLLM(urls[provider], apiKey, model, provider, prompt);
    },

    async explainMove(fen, moveSan) {
      const prompt = `You are a chess coach. In 1-2 sentences, explain why ${moveSan} is the best move in this position (FEN: ${fen}).`;
      return callLLM(urls[provider], apiKey, model, provider, prompt);
    },

    async reviewGame(pgn) {
      const prompt = `You are a chess coach. Review this game concisely. Identify the 2-3 most important moments and explain what went wrong or right.
PGN: ${pgn}`;
      return callLLM(urls[provider], apiKey, model, provider, prompt);
    },
  };
}

async function callLLM(url, apiKey, model, provider, prompt) {
  try {
    const headers = { "Content-Type": "application/json" };
    let body;

    if (provider === "openai") {
      headers["Authorization"] = `Bearer ${apiKey}`;
      body = JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 200 });
    } else if (provider === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      body = JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 200 });
    } else if (provider === "ollama") {
      body = JSON.stringify({ model, messages: [{ role: "user", content: prompt }] });
    }

    const res = await fetch(url, { method: "POST", headers, body });
    const data = await res.json();

    if (provider === "openai") return data.choices?.[0]?.message?.content || "No response.";
    if (provider === "anthropic") return data.content?.[0]?.text || "No response.";
    if (provider === "ollama") return data.message?.content || "No response.";
  } catch (e) {
    return LocalCoach.explainPuzzle("", [], []);
  }
}

function getProvider() {
  return activeProvider || LocalCoach;
}

function setProvider(provider) {
  activeProvider = provider;
}

async function explainPuzzle(fen, solutionSAN, themes) {
  return getProvider().explainPuzzle(fen, solutionSAN, themes);
}

async function explainMove(fen, moveSan) {
  return getProvider().explainMove(fen, moveSan);
}

async function reviewGame(pgn) {
  return getProvider().reviewGame(pgn);
}

export {
  LocalCoach,
  createLLMCoach,
  getProvider,
  setProvider,
  explainPuzzle,
  explainMove,
  reviewGame,
};
