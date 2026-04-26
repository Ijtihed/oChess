/**
 * Bot engine for oChess.
 *
 * Levels 0-3: js-chess-engine in a Web Worker (non-blocking)
 * Levels 4-7: Stockfish WASM in a Web Worker (UCI protocol)
 */

import { Chess } from "chess.js";

/* ── JCE Worker (levels 0-3) ── */

let jceWorker = null;
let jceResolve = null;

function initJCE() {
  if (jceWorker) return;
  jceWorker = new Worker(new URL("./jce-worker.js", import.meta.url), { type: "module" });
  jceWorker.onmessage = (e) => {
    const cb = jceResolve;
    jceResolve = null;
    if (cb) cb(e.data);
  };
  jceWorker.onerror = () => {
    const cb = jceResolve;
    jceResolve = null;
    if (cb) cb({ ok: false });
  };
}

function jceGetMove(fen, level) {
  initJCE();
  return new Promise((resolve) => {
    jceResolve = resolve;
    jceWorker.postMessage({ fen, level });
    setTimeout(() => {
      if (jceResolve === resolve) { jceResolve = null; resolve({ ok: false }); }
    }, 5000);
  });
}

function jceMoveToVerbose(chess, jceResult) {
  if (!jceResult) return null;
  const entries = Object.entries(jceResult);
  if (entries.length === 0) return null;
  const [from, to] = entries[0];
  const moves = chess.moves({ verbose: true });
  return moves.find((m) => m.from === from.toLowerCase() && m.to === to.toLowerCase()) || null;
}

/* ── Stockfish Worker (levels 4-7) ── */

let sfWorker = null;
let sfReady = false;
let sfResolve = null;

async function initStockfish() {
  if (sfWorker && sfReady) return true;
  if (sfWorker) return new Promise((resolve) => {
    const check = setInterval(() => { if (sfReady) { clearInterval(check); resolve(true); } }, 50);
    setTimeout(() => { clearInterval(check); resolve(false); }, 5000);
  });
  return new Promise((resolve) => {
    try {
      sfWorker = new Worker("/stockfish.js");
      sfWorker.onmessage = (e) => {
        const line = e.data;
        if (line === "readyok") { sfReady = true; resolve(true); return; }
        if (sfResolve && typeof line === "string" && line.startsWith("bestmove")) {
          const match = line.match(/bestmove\s+(\S+)/);
          const cb = sfResolve;
          sfResolve = null;
          cb(match ? match[1] : null);
        }
      };
      sfWorker.onerror = () => {
        try { sfWorker.terminate(); } catch {}
        sfWorker = null;
        sfReady = false;
        if (sfResolve) { const cb = sfResolve; sfResolve = null; cb(null); }
        resolve(false);
      };
      sfWorker.postMessage("uci");
      sfWorker.postMessage("isready");
    } catch { resolve(false); }
  });
}

function sfGetMove(fen, elo) {
  return new Promise((resolve) => {
    sfResolve = resolve;
    if (elo > 0) {
      sfWorker.postMessage("setoption name UCI_LimitStrength value true");
      sfWorker.postMessage(`setoption name UCI_Elo value ${elo}`);
    } else {
      sfWorker.postMessage("setoption name UCI_LimitStrength value false");
    }
    sfWorker.postMessage(`position fen ${fen}`);
    const depth = elo > 0 ? Math.min(14, Math.max(8, Math.floor(elo / 200))) : 18;
    sfWorker.postMessage(`go depth ${depth}`);
    setTimeout(() => { if (sfResolve === resolve) { sfResolve = null; resolve(null); } }, 10000);
  });
}

function uciToVerbose(chess, uci) {
  if (!uci || uci === "(none)") return null;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promo = uci.length > 4 ? uci[4] : undefined;
  const moves = chess.moves({ verbose: true });
  return moves.find((m) => m.from === from && m.to === to && (!promo || m.promotion === promo)) || moves.find((m) => m.from === from && m.to === to) || null;
}

/* ── Bot config ── */

const BOT_CONFIG = [
  { level: 0, name: "Random",      engine: "random",            desc: "Random legal moves. Pure chaos." },
  { level: 1, name: "Rookie",      engine: "jce", jceLevel: 0,  desc: "Beginner. Misses basic tactics." },
  { level: 2, name: "Patzer",      engine: "jce", jceLevel: 1,  desc: "Sees some tactics. Inconsistent." },
  { level: 3, name: "Club",        engine: "jce", jceLevel: 3,  desc: "Solid fundamentals. Punishes mistakes." },
  { level: 4, name: "Expert",      engine: "sf",  sfElo: 1700,  desc: "Strong positional play." },
  { level: 5, name: "Master",      engine: "sf",  sfElo: 2100,  desc: "Master level. Deep vision." },
  { level: 6, name: "Grandmaster", engine: "sf",  sfElo: 2600,  desc: "Near-perfect play." },
  { level: 7, name: "Stockfish",   engine: "sf",  sfElo: 0,     desc: "Full engine strength. No mercy." },
];

async function getBotMove(fen, level) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return null;

  const config = BOT_CONFIG[level] || BOT_CONFIG[0];

  if (config.engine === "random") {
    return moves[Math.floor(Math.random() * moves.length)];
  }

  if (config.engine === "jce") {
    const data = await jceGetMove(fen, config.jceLevel);
    if (data.ok) {
      const move = jceMoveToVerbose(chess, data.result);
      if (move) return move;
    }
    throw new Error(`JCE engine failed (level ${config.jceLevel}): ${data.error || "no valid move returned"}`);
  }

  if (config.engine === "sf") {
    const ready = await initStockfish();
    if (!ready) throw new Error("Stockfish WASM failed to initialize");
    const uci = await sfGetMove(fen, config.sfElo);
    const move = uciToVerbose(chess, uci);
    if (move) return move;
    throw new Error(`Stockfish returned invalid move: ${uci || "null"}`);
  }

  throw new Error(`Unknown engine type: ${config.engine}`);
}

function getThinkDelay(level) {
  if (level <= 1) return 200 + Math.random() * 400;
  if (level <= 3) return 300 + Math.random() * 500;
  if (level <= 5) return 500 + Math.random() * 600;
  return 700 + Math.random() * 800;
}

export { getBotMove, getThinkDelay, BOT_CONFIG };
