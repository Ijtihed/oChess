import { Chess } from "chess.js";
import { evaluate, formatEval, init as initEngine } from "./engine";

const PN = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const PV = { p: 1, n: 3, b: 3, r: 5, q: 9 };

function materialDiff(fen) {
  const board = fen.split(" ")[0];
  let w = 0, b = 0;
  for (const ch of board) {
    const l = ch.toLowerCase();
    if (PV[l]) { if (ch === ch.toUpperCase()) w += PV[l]; else b += PV[l]; }
  }
  return w - b;
}

async function explainPuzzle(fen, solutionSAN, themes = []) {
  const g = new Chess(fen);
  try { g.move(solutionSAN[0]); } catch {}
  const pos = g.fen();
  const side = g.turn() === "w" ? "White" : "Black";
  const opp = g.turn() === "w" ? "Black" : "White";
  const playerSan = solutionSAN[1];

  let evBefore = null, evAfter = null;
  try {
    await initEngine();
    evBefore = await evaluate(pos, 14);
    if (playerSan) {
      const g2 = new Chess(pos);
      try { g2.move(playerSan); } catch {}
      evAfter = await evaluate(g2.fen(), 12);
    }
  } catch {}

  const lines = [];

  if (playerSan) {
    const g2 = new Chess(pos);
    try {
      const m = g2.move(playerSan);
      if (m) {
        const matBefore = materialDiff(pos);
        const matAfter = materialDiff(g2.fen());
        const matGain = g.turn() === "w" ? matAfter - matBefore : matBefore - matAfter;

        if (m.san.includes("#")) {
          lines.push(`${m.san} is checkmate.`);
        } else if (m.captured && m.san.includes("+")) {
          lines.push(`${m.san} takes the ${PN[m.captured]} with check.`);
          if (matGain >= 2) lines.push(`That's ${matGain} points of material won.`);
        } else if (m.san.includes("+")) {
          lines.push(`${m.san} checks with the ${PN[m.piece]}.`);
        } else if (m.captured) {
          lines.push(`${m.san} takes the ${PN[m.captured]}.`);
          if (matGain >= 2) lines.push(`Wins ${matGain} points of material.`);
          else if (matGain === 0 && PV[m.captured] >= 3) lines.push("It's a trade, but it opens up the position.");
        } else {
          lines.push(`The move is ${m.san}.`);
        }

        if (g2.isCheckmate()) {
          lines.push(`${opp} is checkmated after this sequence.`);
        }
      }
    } catch {}
  }

  if (evBefore && evAfter) {
    const cpB = evBefore.eval_cp;
    const cpA = evAfter.eval_cp !== null ? -evAfter.eval_cp : null;

    if (evAfter.eval_mate !== null && evBefore.eval_mate === null) {
      lines.push("This forces a checkmate sequence that can't be stopped.");
    } else if (cpB !== null && cpA !== null) {
      const swing = cpA - cpB;
      if (swing > 500) lines.push(`The eval jumps by +${(swing / 100).toFixed(1)}. ${opp} can't recover from this.`);
      else if (swing > 300) lines.push(`+${(swing / 100).toFixed(1)} swing. ${opp} is losing too much material to hold.`);
      else if (swing > 150) lines.push(`Gains about ${(swing / 100).toFixed(1)} points. That's enough to convert.`);
      else if (swing > 50) lines.push("Small but clear gain. Adds up with good technique.");
    }
  }

  if (evBefore) {
    if (evBefore.eval_mate !== null) {
      const m = evBefore.eval_mate;
      if (m > 0) lines.push(`${side} has forced mate in ${m}.`);
      else lines.push(`${opp} has mate in ${Math.abs(m)}, so the defense needs to be exact.`);
    } else if (evBefore.eval_cp !== null) {
      const cp = evBefore.eval_cp;
      const p = Math.abs(cp / 100).toFixed(1);
      if (Math.abs(cp) < 25) lines.push("Before this move, position was dead equal.");
      else if (Math.abs(cp) < 100) lines.push(`${cp > 0 ? side : opp} was slightly better (${p} points) before the key move.`);
      else lines.push(`${cp > 0 ? side : opp} was already up ${p} points before this move.`);
    }
  }

  if (evBefore && evBefore.pv && evBefore.pv.length > 1) {
    const pvSan = [];
    const pvG = new Chess(pos);
    for (let i = 0; i < Math.min(5, evBefore.pv.length); i++) {
      try {
        const m = pvG.move({ from: evBefore.pv[i].slice(0, 2), to: evBefore.pv[i].slice(2, 4), promotion: evBefore.pv[i].length > 4 ? evBefore.pv[i][4] : undefined });
        if (m) pvSan.push(m.san); else break;
      } catch { break; }
    }
    if (pvSan.length > 1) lines.push(`Best line: ${pvSan.join(" ")}`);
  }

  const TL = {
    fork: "One piece attacks two things at once. The opponent can only save one.",
    pin: "Something is pinned and can't move without losing more.",
    skewer: "The valuable piece has to move and you pick up what's behind it.",
    sacrifice: "You give up material now but win it back with interest.",
    mateIn1: "One-move checkmate.",
    mateIn2: "Forced mate in two moves.",
    discoveredAttack: "Moving one piece reveals a hidden attack from another piece behind it.",
    backRankMate: "The king is trapped on the back rank. No escape squares.",
    deflection: "The defender gets pulled away from what it was protecting.",
    hangingPiece: "That piece was unprotected. Free material.",
    endgame: "This is an endgame position. Precision matters more than tactics here.",
    crushing: "Position is completely won after this. No way back.",
    attraction: "A piece gets lured to a square where it can be exploited.",
    middlegame: "Middlegame combination.",
  };
  for (const t of themes) {
    if (TL[t]) { lines.push(TL[t]); break; }
  }

  const totalMoves = Math.ceil((solutionSAN.length - 1) / 2);
  if (totalMoves > 2) lines.push(`${totalMoves}-move sequence.`);

  const text = lines.length > 0 ? lines.join(" ") : "Tricky position. Study the solution to build the pattern.";

  let evalDisplay = null;
  if (evBefore) {
    if (evBefore.eval_mate !== null) evalDisplay = `M${evBefore.eval_mate > 0 ? "" : ""}${evBefore.eval_mate}`;
    else if (evBefore.eval_cp !== null) evalDisplay = (evBefore.eval_cp >= 0 ? "+" : "") + (evBefore.eval_cp / 100).toFixed(1);
  }

  let evalAfterDisplay = null;
  if (evAfter) {
    const flipped = evAfter.eval_cp !== null ? -evAfter.eval_cp : null;
    const flippedMate = evAfter.eval_mate !== null ? -evAfter.eval_mate : null;
    if (flippedMate !== null) evalAfterDisplay = `M${flippedMate}`;
    else if (flipped !== null) evalAfterDisplay = (flipped >= 0 ? "+" : "") + (flipped / 100).toFixed(1);
  }

  const whiteAdvBefore = evBefore?.eval_cp != null ? evBefore.eval_cp / 100 : (evBefore?.eval_mate != null ? (evBefore.eval_mate > 0 ? 99 : -99) : 0);
  const barPct = Math.max(5, Math.min(95, 50 + whiteAdvBefore * 3));

  return { text, evalBefore: evalDisplay, evalAfter: evalAfterDisplay, barPct };
}

async function explainMove(fen, moveSan) {
  const lines = [];
  const g = new Chess(fen);
  try {
    const m = g.move(moveSan);
    if (m) {
      if (m.san.includes("#")) lines.push("Checkmate.");
      else if (m.san.includes("+")) lines.push(`${moveSan} gives check.`);
      if (m.captured) lines.push(`Takes the ${PN[m.captured]}.`);
    }
  } catch {}

  let ev = null;
  try { await initEngine(); ev = await evaluate(fen, 12); } catch {}
  if (ev) {
    if (ev.eval_mate !== null) lines.push(ev.eval_mate > 0 ? `Mate in ${ev.eval_mate}.` : `Getting mated in ${Math.abs(ev.eval_mate)}.`);
    else if (ev.eval_cp !== null) {
      const p = (ev.eval_cp / 100).toFixed(1);
      if (Math.abs(ev.eval_cp) < 25) lines.push("Even position.");
      else lines.push(`Eval: ${p > 0 ? "+" : ""}${p}`);
    }
  }
  return lines.join(" ") || "Interesting move.";
}

async function evaluatePosition(fen, depth = 14) {
  try {
    await initEngine();
    const result = await evaluate(fen, depth);
    if (!result) return null;
    return {
      cp: result.eval_cp,
      mate: result.eval_mate,
      bestMove: result.bestMove,
      pv: result.pv,
      depth: result.depth,
    };
  } catch {
    return null;
  }
}

export { explainPuzzle, explainMove, evaluatePosition };
