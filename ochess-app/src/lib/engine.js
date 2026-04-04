/**
 * Stockfish WASM engine wrapper for oChess.
 * Runs Stockfish 18 (lite, single-threaded) in the browser.
 * ~7MB WASM download on first use, cached by the browser after that.
 */

let worker = null;
let ready = false;
let pendingResolve = null;
let evalLines = [];

function init() {
  if (worker) return Promise.resolve();

  return new Promise((resolve, reject) => {
    try {
      worker = new Worker("/stockfish.js");
    } catch {
      reject(new Error("Failed to create Stockfish worker"));
      return;
    }

    worker.onmessage = (e) => {
      const line = e.data;

      if (line === "readyok") {
        ready = true;
        resolve();
        return;
      }

      if (pendingResolve && typeof line === "string") {
        evalLines.push(line);

        if (line.startsWith("bestmove")) {
          const result = parseEvalLines(evalLines);
          evalLines = [];
          const cb = pendingResolve;
          pendingResolve = null;
          cb(result);
        }
      }
    };

    worker.onerror = () => {
      reject(new Error("Stockfish worker error"));
    };

    worker.postMessage("uci");
    worker.postMessage("isready");
  });
}

function parseEvalLines(lines) {
  let bestMove = null;
  let eval_cp = null;
  let eval_mate = null;
  let pv = null;
  let depth = 0;

  for (const line of lines) {
    if (line.startsWith("bestmove")) {
      const match = line.match(/bestmove\s+(\S+)/);
      if (match) bestMove = match[1];
    }

    if (line.includes(" depth ") && line.includes(" pv ")) {
      const depthMatch = line.match(/depth\s+(\d+)/);
      const d = depthMatch ? parseInt(depthMatch[1]) : 0;
      if (d >= depth) {
        depth = d;
        const cpMatch = line.match(/score cp\s+(-?\d+)/);
        const mateMatch = line.match(/score mate\s+(-?\d+)/);
        if (cpMatch) { eval_cp = parseInt(cpMatch[1]); eval_mate = null; }
        if (mateMatch) { eval_mate = parseInt(mateMatch[1]); eval_cp = null; }
        const pvMatch = line.match(/pv\s+(.+)/);
        if (pvMatch) pv = pvMatch[1].trim().split(/\s+/);
      }
    }
  }

  return { bestMove, eval_cp, eval_mate, pv, depth };
}

async function evaluate(fen, depthLimit = 16) {
  await init();
  if (!worker) return null;

  return new Promise((resolve) => {
    pendingResolve = resolve;
    evalLines = [];
    worker.postMessage("ucinewgame");
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${depthLimit}`);
  });
}

function formatEval(result) {
  if (!result) return "?";
  if (result.eval_mate !== null) return `M${result.eval_mate}`;
  if (result.eval_cp !== null) return (result.eval_cp / 100).toFixed(1);
  return "?";
}

function evalToText(result, sideToMove) {
  if (!result) return "";
  if (result.eval_mate !== null) {
    const m = result.eval_mate;
    if (m > 0) return sideToMove === "w" ? `White has mate in ${m}` : `Black has mate in ${m}`;
    return sideToMove === "w" ? `Black has mate in ${Math.abs(m)}` : `White has mate in ${Math.abs(m)}`;
  }
  if (result.eval_cp !== null) {
    const cp = result.eval_cp;
    const pawns = Math.abs(cp / 100).toFixed(1);
    if (Math.abs(cp) < 30) return "The position is roughly equal.";
    if (cp > 0) return sideToMove === "w" ? `White is better by ${pawns} pawns.` : `Black is better by ${pawns} pawns (from black's perspective).`;
    return sideToMove === "w" ? `Black is better by ${pawns} pawns.` : `White is better by ${pawns} pawns.`;
  }
  return "";
}

function isReady() { return ready; }

function destroy() {
  if (worker) { worker.terminate(); worker = null; ready = false; }
}

export { init, evaluate, formatEval, evalToText, isReady, destroy };
