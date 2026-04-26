/**
 * Stockfish WASM engine wrapper for oChess.
 * Runs Stockfish 18 (lite, single-threaded) in the browser.
 * ~7MB WASM download on first use, cached by the browser after that.
 */

let worker = null;
let ready = false;
let pendingResolve = null;
let evalLines = [];
let evalId = 0;
let locked = false;
let currentMultiPV = 1;
let searchAccepting = false;
let watchdogTimer = null;

function resetWorker() {
  if (worker) {
    try { worker.terminate(); } catch {}
  }
  worker = null;
  ready = false;
  searchAccepting = false;
  if (pendingResolve) {
    const cb = pendingResolve;
    pendingResolve = null;
    evalLines = [];
    cb(null);
  }
}

function init() {
  if (worker && ready) return Promise.resolve();

  if (worker && !ready) {
    return new Promise((resolve, reject) => {
      const check = setInterval(() => { if (ready) { clearInterval(check); resolve(); } }, 50);
      setTimeout(() => { clearInterval(check); reject(new Error("Stockfish init timeout")); }, 15000);
    });
  }

  return new Promise((resolve, reject) => {
    try {
      worker = new Worker("/stockfish.js");
    } catch {
      reject(new Error("Failed to create Stockfish worker"));
      return;
    }

    worker.onmessage = (e) => {
      const line = e.data;
      if (typeof line !== "string") return;

      if (line.includes("readyok")) {
        if (!ready) { ready = true; resolve(); }
        return;
      }

      if (searchAccepting && pendingResolve) {
        evalLines.push(line);

        if (line.startsWith("bestmove")) {
          if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
          const result = currentMultiPV > 1
            ? parseMultiPVLines(evalLines, currentMultiPV)
            : parseEvalLines(evalLines);
          evalLines = [];
          searchAccepting = false;
          const cb = pendingResolve;
          pendingResolve = null;
          cb(result);
        }
      }
    };

    worker.onerror = (err) => {
      console.warn("Stockfish worker error, resetting:", err?.message || err);
      const wasReady = ready;
      resetWorker();
      if (!wasReady) reject(new Error("Stockfish worker error during init"));
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
      if (match && match[1] !== "(none)") bestMove = match[1];
    }

    if (line.includes(" depth ") && line.includes(" score ")) {
      const depthMatch = line.match(/depth\s+(\d+)/);
      const d = depthMatch ? parseInt(depthMatch[1]) : 0;
      if (d >= depth) {
        depth = d;
        const cpMatch = line.match(/score cp\s+(-?\d+)/);
        const mateMatch = line.match(/score mate\s+(-?\d+)/);
        if (cpMatch) { eval_cp = parseInt(cpMatch[1]); eval_mate = null; }
        if (mateMatch) { eval_mate = parseInt(mateMatch[1]); eval_cp = null; }
        const pvMatch = line.match(/ pv ([a-h][1-8][a-h][1-8].*)$/);
        if (pvMatch) pv = pvMatch[1].trim().split(/\s+/);
      }
    }
  }

  return { bestMove, eval_cp, eval_mate, pv, depth };
}

function parseMultiPVLines(lines, numPV) {
  const pvMap = {};
  let bestMove = null;

  for (const line of lines) {
    if (line.startsWith("bestmove")) {
      const match = line.match(/bestmove\s+(\S+)/);
      if (match && match[1] !== "(none)") bestMove = match[1];
    }

    if (line.includes(" depth ") && line.includes(" score ") && line.includes(" multipv ")) {
      const pvIdx = parseInt((line.match(/multipv\s+(\d+)/) || [])[1]);
      if (!pvIdx || pvIdx > numPV) continue;
      const d = parseInt((line.match(/depth\s+(\d+)/) || [])[1]) || 0;
      const prev = pvMap[pvIdx];
      if (prev && prev.depth > d) continue;

      const cpMatch = line.match(/score cp\s+(-?\d+)/);
      const mateMatch = line.match(/score mate\s+(-?\d+)/);
      const pvMatch = line.match(/ pv ([a-h][1-8][a-h][1-8].*)$/);
      pvMap[pvIdx] = {
        eval_cp: cpMatch ? parseInt(cpMatch[1]) : null,
        eval_mate: mateMatch ? parseInt(mateMatch[1]) : null,
        pv: pvMatch ? pvMatch[1].trim().split(/\s+/) : [],
        depth: d,
      };
    }
  }

  const result = [];
  for (let i = 1; i <= numPV; i++) {
    if (pvMap[i]) {
      const entry = pvMap[i];
      entry.bestMove = entry.pv[0] || null;
      result.push(entry);
    }
  }
  if (result.length > 0 && bestMove) result[0].bestMove = bestMove;
  return result;
}

async function evaluate(fen, depthLimit = 16, multiPV = 1) {
  if (locked) return null;

  try {
    await init();
  } catch {
    return null;
  }
  if (!worker) return null;

  if (pendingResolve) {
    searchAccepting = false;
    evalLines = [];
    const old = pendingResolve;
    pendingResolve = null;
    old(null);
    try {
      worker.postMessage("stop");
    } catch {
      resetWorker();
      return null;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!worker || !ready) {
    try { await init(); } catch { return null; }
  }

  const myId = ++evalId;

  return new Promise((resolve) => {
    currentMultiPV = multiPV;
    pendingResolve = (result) => resolve(result);
    evalLines = [];
    searchAccepting = true;

    try {
      worker.postMessage(`setoption name MultiPV value ${multiPV}`);
      worker.postMessage(`position fen ${fen}`);
      worker.postMessage(`go depth ${depthLimit}`);
    } catch {
      searchAccepting = false;
      pendingResolve = null;
      resetWorker();
      resolve(null);
      return;
    }

    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      if (pendingResolve && evalId === myId) {
        const cb = pendingResolve;
        pendingResolve = null;
        searchAccepting = false;
        try { worker.postMessage("stop"); } catch {}
        if (multiPV > 1) {
          const partial = evalLines.length > 0 ? parseMultiPVLines(evalLines, multiPV) : [];
          evalLines = [];
          cb(partial);
        } else {
          const partial = evalLines.length > 0 ? parseEvalLines(evalLines) : null;
          evalLines = [];
          cb(partial);
        }
      }
    }, 30000);
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
  resetWorker();
}

function unlockEval() { locked = false; }
function lockEval() { locked = true; }

export { init, evaluate, formatEval, evalToText, isReady, destroy, unlockEval, lockEval };
