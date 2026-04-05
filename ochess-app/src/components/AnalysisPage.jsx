import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import InteractiveBoard from "./InteractiveBoard";
import SocialPanel from "./SocialPanel";
import { evaluate, formatEval, init as initEngine } from "../lib/engine";
import { getOpeningName, resetOpeningCache } from "../lib/openings";
import { playMoveSound } from "../lib/sounds";
import { load as loadPrefs, getTheme } from "../lib/board-prefs";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const EMPTY_FEN = "8/8/8/8/8/8/8/8 w - - 0 1";
const PIECE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const SAVED_KEY = "ochess_saved_analysis";
const MAX_SAVED = 5;

function loadSavedBoards() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]"); } catch { return []; }
}
function writeSavedBoards(boards) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(boards)); } catch {}
}

function materialCount(fen) {
  const board = fen.split(" ")[0];
  let w = 0, b = 0;
  const wPieces = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  const bPieces = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  for (const ch of board) {
    const l = ch.toLowerCase();
    if (PIECE_VAL[l]) {
      if (ch === ch.toUpperCase()) { w += PIECE_VAL[l]; wPieces[l]++; }
      else { b += PIECE_VAL[l]; bPieces[l]++; }
    }
  }
  return { white: w, black: b, diff: w - b, wPieces, bPieces };
}

function fenToPosition(fen) {
  const pos = {};
  const rows = fen.split(" ")[0].split("/");
  const files = "abcdefgh";
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (ch >= "1" && ch <= "8") { f += parseInt(ch); }
      else {
        const color = ch === ch.toUpperCase() ? "w" : "b";
        const sq = files[f] + (8 - r);
        pos[sq] = color + ch.toUpperCase();
        f++;
      }
    }
  }
  return pos;
}

function positionToFen(pos, turn = "w", castling = "-", ep = "-") {
  const files = "abcdefgh";
  const rows = [];
  for (let r = 8; r >= 1; r--) {
    let row = "";
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const sq = files[f] + r;
      const p = pos[sq];
      if (p) {
        if (empty > 0) { row += empty; empty = 0; }
        row += p[0] === "w" ? p[1].toUpperCase() : p[1].toLowerCase();
      } else {
        empty++;
      }
    }
    if (empty > 0) row += empty;
    rows.push(row);
  }
  return `${rows.join("/")} ${turn} ${castling} ${ep} 0 1`;
}

const EDITOR_PIECES = [
  { id: "wK", label: "K" }, { id: "wQ", label: "Q" }, { id: "wR", label: "R" },
  { id: "wB", label: "B" }, { id: "wN", label: "N" }, { id: "wP", label: "P" },
  { id: "bK", label: "k" }, { id: "bQ", label: "q" }, { id: "bR", label: "r" },
  { id: "bB", label: "b" }, { id: "bN", label: "n" }, { id: "bP", label: "p" },
];

export default function AnalysisPage() {
  const location = useLocation();
  const initialPgn = location.state?.pgn || "";
  const initialFen = location.state?.fen || "";

  const [mode, setMode] = useState(initialPgn || initialFen ? "analysis" : "analysis");
  const [pgnInput, setPgnInput] = useState("");
  const [fenInput, setFenInput] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [savedBoards, setSavedBoards] = useState(loadSavedBoards);
  const [history, setHistory] = useState([]);
  const [currentPly, setCurrentPly] = useState(0);
  const [fen, setFen] = useState(START_FEN);
  const [startFen, setStartFen] = useState(START_FEN);
  const [orientation, setOrientation] = useState("white");

  const [engineOn, setEngineOn] = useState(true);
  const [engineDepth, setEngineDepth] = useState(18);
  const [posEval, setPosEval] = useState(null);
  const [evalLoading, setEvalLoading] = useState(false);
  const [pvSan, setPvSan] = useState([]);
  const [bestMoveArrow, setBestMoveArrow] = useState(null);
  const [showBestMove, setShowBestMove] = useState(true);

  const [openingName, setOpeningName] = useState(null);
  const [fenCopied, setFenCopied] = useState(false);
  const [pgnCopied, setPgnCopied] = useState(false);

  const [editorPos, setEditorPos] = useState({});
  const [editorPiece, setEditorPiece] = useState("wQ");
  const [editorTurn, setEditorTurn] = useState("w");

  const baseRef = useRef(new Chess());
  const moveListRef = useRef(null);
  const evalAbort = useRef(0);

  useEffect(() => {
    if (!fen || !engineOn) { setPosEval(null); setEvalLoading(false); setPvSan([]); setBestMoveArrow(null); return; }
    const id = ++evalAbort.current;
    setEvalLoading(true);
    setPosEval(null);
    setPvSan([]);
    setBestMoveArrow(null);
    (async () => {
      try {
        await initEngine();
        const result = await evaluate(fen, engineDepth);
        if (evalAbort.current !== id) return;
        setPosEval(result);
        setEvalLoading(false);
        if (result?.bestMove) {
          const from = result.bestMove.slice(0, 2);
          const to = result.bestMove.slice(2, 4);
          setBestMoveArrow({ from, to });
        }
        if (result?.pv) {
          try {
            const g = new Chess(fen);
            const sans = [];
            for (let i = 0; i < Math.min(8, result.pv.length); i++) {
              const uci = result.pv[i];
              const m = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
              if (m) sans.push(m.san); else break;
            }
            if (evalAbort.current === id) setPvSan(sans);
          } catch {}
        }
      } catch { if (evalAbort.current === id) setEvalLoading(false); }
    })();
  }, [fen, engineOn, engineDepth]);

  useEffect(() => {
    resetOpeningCache();
    if (history.length > 0 && history.length <= 30) {
      getOpeningName(history).then((name) => { if (name) setOpeningName(name); });
    } else if (history.length === 0) {
      setOpeningName(null);
    }
  }, [history.length]);

  const loadGame = useCallback((pgn, customStartFen) => {
    const g = new Chess();
    if (customStartFen) {
      try { g.load(customStartFen); } catch { return false; }
      setStartFen(customStartFen);
    } else {
      setStartFen(START_FEN);
    }
    if (pgn && pgn.trim()) {
      try { g.loadPgn(pgn); } catch { return false; }
    }
    const hist = g.history({ verbose: true });
    baseRef.current = g;
    setHistory(hist);
    setCurrentPly(hist.length);
    setFen(g.fen());
    setMode("analysis");
    setShowImport(false);
    return true;
  }, []);

  useEffect(() => {
    if (initialPgn) loadGame(initialPgn);
    else if (initialFen) loadGame("", initialFen);
  }, [initialPgn, initialFen, loadGame]);

  const goToPly = useCallback((ply) => {
    const clamped = Math.max(0, Math.min(ply, history.length));
    const temp = new Chess(startFen);
    for (let i = 0; i < clamped; i++) temp.move(history[i].san);
    setFen(temp.fen());
    setCurrentPly(clamped);
  }, [history, startFen]);

  const handleFreeMove = useCallback((move) => {
    const temp = new Chess(fen);
    try {
      const result = temp.move(move);
      if (!result) return false;
      playMoveSound(result);
      const newHist = history.slice(0, currentPly);
      newHist.push(result);
      setHistory(newHist);
      setCurrentPly(newHist.length);
      setFen(temp.fen());
      return true;
    } catch { return false; }
  }, [fen, history, currentPly]);

  const deleteMove = useCallback(() => {
    if (currentPly === 0) return;
    const newHist = history.slice(0, currentPly - 1);
    setHistory(newHist);
    const temp = new Chess(startFen);
    for (let i = 0; i < newHist.length; i++) temp.move(newHist[i].san);
    setFen(temp.fen());
    setCurrentPly(newHist.length);
  }, [currentPly, history, startFen]);

  useEffect(() => {
    if (moveListRef.current) {
      const active = moveListRef.current.querySelector("[data-active]");
      if (active) active.scrollIntoView({ block: "nearest" });
    }
  }, [currentPly]);

  useEffect(() => {
    if (mode !== "analysis") return;
    const handler = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "ArrowLeft") { e.preventDefault(); goToPly(currentPly - 1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); goToPly(currentPly + 1); }
      else if (e.key === "Home") { e.preventDefault(); goToPly(0); }
      else if (e.key === "End") { e.preventDefault(); goToPly(history.length); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteMove(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mode, goToPly, currentPly, history.length, deleteMove]);

  const movePairs = useMemo(() => {
    const pairs = [];
    for (let i = 0; i < history.length; i += 2) {
      pairs.push({ num: Math.floor(i / 2) + 1, white: history[i], black: history[i + 1] || null, wPly: i + 1, bPly: i + 2 });
    }
    return pairs;
  }, [history]);

  const mat = useMemo(() => materialCount(fen), [fen]);

  const evalLabel = useMemo(() => {
    if (!posEval) return evalLoading ? "..." : "?";
    if (posEval.eval_mate !== null) {
      const sign = posEval.eval_mate > 0 ? "+" : "-";
      return `${sign}M${Math.abs(posEval.eval_mate)}`;
    }
    if (posEval.eval_cp !== null) {
      const p = posEval.eval_cp / 100;
      if (Math.abs(p) < 0.15) return "0.0";
      return (p > 0 ? "+" : "") + p.toFixed(1);
    }
    return "?";
  }, [posEval, evalLoading]);

  const evalBarPct = useMemo(() => {
    if (!posEval) return 50;
    if (posEval.eval_mate !== null) return posEval.eval_mate > 0 ? 96 : 4;
    if (posEval.eval_cp !== null) {
      const clamped = Math.max(-600, Math.min(600, posEval.eval_cp));
      return 50 + (clamped / 600) * 46;
    }
    return 50;
  }, [posEval]);

  const highlightSquares = useMemo(() => {
    const sq = {};
    if (currentPly > 0 && currentPly <= history.length) {
      const m = history[currentPly - 1];
      sq[m.from] = { backgroundColor: "rgba(59,130,246,0.18)" };
      sq[m.to] = { backgroundColor: "rgba(59,130,246,0.28)" };
    }
    if (showBestMove && bestMoveArrow && engineOn) {
      sq[bestMoveArrow.from] = { ...(sq[bestMoveArrow.from] || {}), backgroundColor: "rgba(76,175,80,0.25)", boxShadow: "inset 0 0 0 2px rgba(76,175,80,0.5)" };
      sq[bestMoveArrow.to] = { ...(sq[bestMoveArrow.to] || {}), backgroundColor: "rgba(76,175,80,0.35)", boxShadow: "inset 0 0 0 2px rgba(76,175,80,0.6)" };
    }
    return sq;
  }, [currentPly, history, showBestMove, bestMoveArrow, engineOn]);

  const currentPgn = useMemo(() => {
    if (history.length === 0) return "";
    const g = new Chess(startFen);
    for (const m of history) g.move(m.san);
    return g.pgn();
  }, [history, startFen]);

  const handleEditorClick = useCallback((sq) => {
    if (!editorPiece) {
      const newPos = { ...editorPos };
      delete newPos[sq];
      setEditorPos(newPos);
    } else {
      setEditorPos({ ...editorPos, [sq]: editorPiece });
    }
  }, [editorPos, editorPiece]);

  const applyEditorPosition = useCallback(() => {
    const newFen = positionToFen(editorPos, editorTurn);
    try {
      const g = new Chess(newFen);
      setStartFen(newFen);
      setFen(newFen);
      setHistory([]);
      setCurrentPly(0);
      setMode("analysis");
      baseRef.current = g;
    } catch {}
  }, [editorPos, editorTurn]);

  const enterEditor = useCallback(() => {
    setEditorPos(fenToPosition(fen));
    setEditorTurn(fen.split(" ")[1] || "w");
    setMode("editor");
  }, [fen]);

  const saveCurrentBoard = useCallback(() => {
    const boards = loadSavedBoards();
    if (boards.length >= MAX_SAVED) return false;
    const g = new Chess(startFen);
    for (const m of history) g.move(m.san);
    const opening = openingName || null;
    const moveCount = history.length;
    const entry = {
      id: Date.now(),
      name: opening ? opening.replace(/:.*/, "").trim() : (moveCount > 0 ? `${moveCount} moves` : "Empty board"),
      pgn: g.pgn(),
      startFen: startFen !== START_FEN ? startFen : null,
      ply: currentPly,
      savedAt: Date.now(),
    };
    boards.unshift(entry);
    writeSavedBoards(boards);
    setSavedBoards([...boards]);
    return true;
  }, [history, startFen, currentPly, openingName]);

  const loadSavedBoard = useCallback((entry) => {
    if (entry.startFen) loadGame(entry.pgn, entry.startFen);
    else loadGame(entry.pgn);
    setTimeout(() => goToPly(entry.ply || 0), 50);
  }, [loadGame, goToPly]);

  const deleteSavedBoard = useCallback((id) => {
    const boards = loadSavedBoards().filter((b) => b.id !== id);
    writeSavedBoards(boards);
    setSavedBoards([...boards]);
  }, []);

  // ── Board Editor mode ──
  if (mode === "editor") {
    const editorFen = positionToFen(editorPos, editorTurn);
    const prefs = loadPrefs();
    return (
      <div className="flex min-h-[calc(100vh-4rem)]">
        <div className="flex-1 min-w-0 px-4 sm:px-6 xl:pl-16 xl:pr-6 py-3 sm:py-4">
          <div className="flex flex-col xl:flex-row gap-4 xl:gap-6">
            {/* Board */}
            <div className="flex-1 flex flex-col items-center xl:items-start max-w-[640px]">
              <div className="w-full flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <h1 className="font-headline text-xl font-extrabold tracking-tighter text-primary">Board Editor</h1>
                  {editorPiece ? (
                    <div className="flex items-center gap-1.5 px-2 py-1 bg-surface-low border border-white/[0.06] rounded">
                      <img src={`/piece/${prefs.pieceSet}/${editorPiece}.svg`} alt={editorPiece} className="w-5 h-5" draggable={false} />
                      <span className="text-[10px] font-label uppercase tracking-wide text-on-surface-variant/50">selected</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 px-2 py-1 bg-error/5 border border-error/15 rounded">
                      <span className="text-[10px] font-label uppercase tracking-wide text-error/60">eraser</span>
                    </div>
                  )}
                </div>
                <div className="flex gap-1.5">
                  <button onClick={() => setOrientation(orientation === "white" ? "black" : "white")}
                    className="px-3 py-1.5 bg-surface-low border border-white/[0.04] text-[10px] font-headline font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary transition-colors active:scale-[0.96]">
                    Flip
                  </button>
                  <button onClick={() => setMode("analysis")}
                    className="px-3 py-1.5 bg-surface-low border border-white/[0.04] text-[10px] font-headline font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary transition-colors active:scale-[0.96]">
                    Cancel
                  </button>
                </div>
              </div>

              <EditorBoard
                position={editorPos}
                orientation={orientation}
                onSquareClick={handleEditorClick}
                pieceSet={prefs.pieceSet}
              />
            </div>

            {/* Editor sidebar */}
            <div className="w-full xl:w-[300px] shrink-0 space-y-3">
              {/* Piece palette */}
              <div className="bg-surface-container border border-white/[0.04] p-3">
                <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/40 block mb-2">Piece to place</span>
                <div className="grid grid-cols-6 gap-1">
                  {EDITOR_PIECES.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setEditorPiece(editorPiece === p.id ? null : p.id)}
                      className={`aspect-square flex items-center justify-center border transition-colors ${
                        editorPiece === p.id ? "border-primary bg-primary/15" : "border-white/[0.04] bg-surface-low hover:border-primary/30"
                      }`}
                    >
                      <img src={`/piece/${prefs.pieceSet}/${p.id}.svg`} alt={p.id} className="w-8 h-8" draggable={false} />
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setEditorPiece(null)}
                  className={`w-full mt-1.5 py-1.5 text-[10px] font-headline font-bold uppercase tracking-wide transition-colors border ${
                    editorPiece === null ? "border-error/30 bg-error/10 text-error" : "border-white/[0.04] bg-surface-low text-on-surface-variant/40 hover:text-error"
                  }`}
                >
                  Eraser (click to remove)
                </button>
              </div>

              {/* Turn selector */}
              <div className="bg-surface-container border border-white/[0.04] p-3">
                <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/40 block mb-2">Side to move</span>
                <div className="flex gap-2">
                  <button onClick={() => setEditorTurn("w")}
                    className={`flex-1 py-2 text-[10px] font-headline font-bold uppercase tracking-wide border transition-colors ${
                      editorTurn === "w" ? "border-primary bg-primary/15 text-primary" : "border-white/[0.04] bg-surface-low text-on-surface-variant/40 hover:text-primary"
                    }`}>White</button>
                  <button onClick={() => setEditorTurn("b")}
                    className={`flex-1 py-2 text-[10px] font-headline font-bold uppercase tracking-wide border transition-colors ${
                      editorTurn === "b" ? "border-primary bg-primary/15 text-primary" : "border-white/[0.04] bg-surface-low text-on-surface-variant/40 hover:text-primary"
                    }`}>Black</button>
                </div>
              </div>

              {/* Quick actions */}
              <div className="bg-surface-container border border-white/[0.04] p-3 space-y-1.5">
                <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/40 block mb-1">Quick setup</span>
                <div className="flex gap-1.5">
                  <button onClick={() => setEditorPos(fenToPosition(START_FEN))}
                    className="flex-1 py-2 bg-surface-low border border-white/[0.04] text-[10px] font-headline font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-primary transition-colors">
                    Start
                  </button>
                  <button onClick={() => setEditorPos({})}
                    className="flex-1 py-2 bg-surface-low border border-white/[0.04] text-[10px] font-headline font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-error transition-colors">
                    Clear
                  </button>
                </div>
              </div>

              {/* FEN */}
              <div className="bg-surface-container border border-white/[0.04] p-3">
                <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/40 block mb-1.5">FEN</span>
                <input
                  value={editorFen}
                  onChange={(e) => {
                    const f = e.target.value.trim();
                    try { setEditorPos(fenToPosition(f)); setEditorTurn(f.split(" ")[1] || "w"); } catch {}
                  }}
                  className="w-full bg-surface-low border border-white/[0.06] px-2 py-1.5 text-[10px] font-mono text-on-surface/70 outline-none focus:border-primary/40 transition-colors"
                />
              </div>

              {/* Apply */}
              <button
                onClick={applyEditorPosition}
                className="w-full py-3 bg-primary text-on-primary font-headline text-xs font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.96]"
              >
                Analyze this position
              </button>
            </div>
          </div>
        </div>
        <SocialPanel />
      </div>
    );
  }

  // ── Analysis mode ──
  const sideToMove = fen.split(" ")[1];
  const topIsBlack = orientation === "white";
  const whitePct = evalBarPct;
  const blackPct = 100 - whitePct;
  const topPct = topIsBlack ? blackPct : whitePct;

  return (
    <div className="flex min-h-[calc(100vh-4rem)]">
      <div className="flex-1 min-w-0 px-4 sm:px-6 xl:pl-16 xl:pr-6 py-3 sm:py-4">
        <div className="flex flex-col xl:flex-row gap-4 xl:gap-6">
          {/* ── Board column ── */}
          <div className="flex-1 flex flex-col items-center xl:items-start max-w-[700px]">
            {/* Top bar */}
            <div className="w-full flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <h1 className="font-headline text-xl font-extrabold tracking-tighter text-primary">Analysis</h1>
                {openingName && (
                  <span className="text-[11px] font-headline font-semibold text-on-surface-variant/50 truncate max-w-[260px]">{openingName}</span>
                )}
              </div>
              <div className="flex gap-1.5">
                <button onClick={() => setOrientation(orientation === "white" ? "black" : "white")}
                  className="px-2.5 py-1.5 bg-surface-low border border-white/[0.04] text-[10px] font-headline font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary transition-colors active:scale-[0.96]">
                  Flip
                </button>
                <button onClick={enterEditor}
                  className="px-2.5 py-1.5 bg-surface-low border border-white/[0.04] text-[10px] font-headline font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-primary transition-colors active:scale-[0.96]">
                  Editor
                </button>
                <button onClick={() => setShowImport(!showImport)}
                  className={`px-2.5 py-1.5 border text-[10px] font-headline font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${
                    showImport ? "border-primary/20 bg-primary/10 text-primary" : "border-white/[0.04] bg-surface-low text-on-surface-variant/50 hover:text-primary"
                  }`}>
                  Import
                </button>
              </div>
            </div>

            {/* Material bar (top — opponent) */}
            <MaterialBar pieces={topIsBlack ? mat.bPieces : mat.wPieces} adv={topIsBlack ? (mat.diff < 0 ? Math.abs(mat.diff) : 0) : (mat.diff > 0 ? mat.diff : 0)} color={topIsBlack ? "b" : "w"} />

            {/* Board + eval bar */}
            <div className="w-full flex gap-0">
              {/* Eval bar */}
              {engineOn && (
                <div className="w-7 shrink-0 flex flex-col relative select-none" style={{ minHeight: "100%" }}>
                  <div
                    className="flex items-start justify-center transition-all duration-300 ease-out"
                    style={{ height: `${topPct}%`, backgroundColor: topIsBlack ? "#1a1a1a" : "#e8e8e8", minHeight: "14px" }}
                  >
                    {topPct >= 50 && (
                      <span className="text-[9px] font-mono font-bold leading-none pt-1 tabular-nums"
                        style={{ color: topIsBlack ? "#bbb" : "#222" }}>
                        {evalLabel}
                      </span>
                    )}
                  </div>
                  <div
                    className="flex-1 flex items-end justify-center transition-all duration-300 ease-out"
                    style={{ backgroundColor: topIsBlack ? "#e8e8e8" : "#1a1a1a", minHeight: "14px" }}
                  >
                    {topPct < 50 && (
                      <span className="text-[9px] font-mono font-bold leading-none pb-1 tabular-nums"
                        style={{ color: topIsBlack ? "#222" : "#bbb" }}>
                        {evalLabel}
                      </span>
                    )}
                  </div>
                  {evalLoading && !posEval && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="w-2.5 h-2.5 border border-on-surface-variant/20 border-t-on-surface-variant/50 rounded-full animate-spin" />
                    </div>
                  )}
                </div>
              )}

              <div className="flex-1 min-w-0">
                <InteractiveBoard
                  fen={fen}
                  onMove={handleFreeMove}
                  orientation={orientation}
                  interactive={true}
                  highlightSquares={highlightSquares}
                  playerColor={sideToMove}
                />
              </div>
            </div>

            {/* Material bar (bottom — player side) */}
            <MaterialBar pieces={topIsBlack ? mat.wPieces : mat.bPieces} adv={topIsBlack ? (mat.diff > 0 ? mat.diff : 0) : (mat.diff < 0 ? Math.abs(mat.diff) : 0)} color={topIsBlack ? "w" : "b"} />

            {/* Navigation */}
            <div className="flex gap-1 mt-2 w-full">
              {[
                { label: "\u23EE", tip: "Start", action: () => goToPly(0) },
                { label: "\u25C0", tip: "Back", action: () => goToPly(currentPly - 1) },
                { label: "\u25B6", tip: "Forward", action: () => goToPly(currentPly + 1) },
                { label: "\u23ED", tip: "End", action: () => goToPly(history.length) },
              ].map((btn, i) => (
                <button key={i} onClick={btn.action} title={btn.tip}
                  className="flex-1 py-2.5 bg-surface-low border border-white/[0.03] flex items-center justify-center text-on-surface-variant/40 hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.96] font-headline text-sm">
                  {btn.label}
                </button>
              ))}
              <button onClick={deleteMove} title="Delete last move"
                className="px-3 py-2.5 bg-surface-low border border-white/[0.03] text-on-surface-variant/30 hover:text-error hover:bg-surface-high transition-colors active:scale-[0.96]">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>

            {/* FEN display + copy */}
            <div className="w-full mt-2 flex items-center gap-2">
              <span className="text-[10px] text-on-surface-variant/20 font-mono truncate flex-1 select-all">{fen}</span>
              <button onClick={() => { navigator.clipboard.writeText(fen); setFenCopied(true); setTimeout(() => setFenCopied(false), 1500); }}
                className={`shrink-0 px-2 py-1 text-[9px] font-headline font-bold uppercase tracking-wide border transition-colors ${
                  fenCopied ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-white/[0.04] bg-surface-low text-on-surface-variant/30 hover:text-primary"
                }`}>
                {fenCopied ? "Copied" : "FEN"}
              </button>
              <button onClick={() => { navigator.clipboard.writeText(currentPgn); setPgnCopied(true); setTimeout(() => setPgnCopied(false), 1500); }}
                className={`shrink-0 px-2 py-1 text-[9px] font-headline font-bold uppercase tracking-wide border transition-colors ${
                  pgnCopied ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-white/[0.04] bg-surface-low text-on-surface-variant/30 hover:text-primary"
                }`}>
                {pgnCopied ? "Copied" : "PGN"}
              </button>
            </div>
          </div>

          {/* ── Sidebar ── */}
          <div className="w-full xl:w-[320px] shrink-0 flex flex-col gap-3">
            {/* Engine panel */}
            <div className="bg-surface-container border border-white/[0.04] p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40">Stockfish</span>
                  {engineOn && posEval && (
                    <span className="text-[11px] font-mono font-bold text-primary tabular-nums">{evalLabel}</span>
                  )}
                  {engineOn && evalLoading && (
                    <div className="w-2.5 h-2.5 border border-primary/30 border-t-primary rounded-full animate-spin" />
                  )}
                </div>
                <button onClick={() => setEngineOn(!engineOn)}
                  className={`px-2 py-1 text-[9px] font-headline font-bold uppercase tracking-wide border transition-colors ${
                    engineOn ? "border-primary/20 bg-primary/10 text-primary" : "border-white/[0.04] bg-surface-low text-on-surface-variant/30"
                  }`}>
                  {engineOn ? "On" : "Off"}
                </button>
              </div>

              {engineOn && (
                <>
                  {/* Depth selector */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-on-surface-variant/40 shrink-0">Depth</span>
                    <div className="flex gap-1 flex-wrap">
                      {[10, 14, 18, 22, 26, 30].map((d) => (
                        <button key={d} onClick={() => setEngineDepth(d)}
                          className={`px-1.5 py-0.5 text-[10px] font-mono font-bold transition-colors ${
                            engineDepth === d ? "bg-primary text-on-primary" : "bg-surface-low text-on-surface-variant/40 hover:text-primary"
                          }`}>{d}</button>
                      ))}
                    </div>
                  </div>

                  {/* Best move toggle */}
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-on-surface-variant/40">Show best move</span>
                    <button onClick={() => setShowBestMove(!showBestMove)}
                      className={`px-2 py-0.5 text-[9px] font-mono font-bold transition-colors ${
                        showBestMove ? "bg-emerald-500/15 text-emerald-400" : "bg-surface-low text-on-surface-variant/30"
                      }`}>{showBestMove ? "Yes" : "No"}</button>
                  </div>

                  {/* PV line */}
                  {pvSan.length > 0 && (
                    <div className="bg-surface-lowest/50 p-2">
                      <span className="text-[9px] text-on-surface-variant/30 block mb-1">Best line{posEval?.depth ? ` (d${posEval.depth})` : ""}</span>
                      <span className="text-[11px] font-mono text-on-surface-variant/60 leading-relaxed break-words">
                        {pvSan.join(" ")}
                      </span>
                    </div>
                  )}

                  <p className="text-[9px] text-on-surface-variant/20 leading-relaxed">
                    Local engine — nothing sent to a server.
                    {engineDepth >= 22 && " Higher depth may be slow."}
                  </p>
                </>
              )}
            </div>

            {/* Import panel (collapsible) */}
            {showImport && (
              <div className="bg-surface-container border border-white/[0.04] p-3 space-y-2.5 anim-fade-up" style={{ "--delay": "0s" }}>
                <span className="text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40 block">Import</span>
                <div>
                  <label className="text-[9px] text-on-surface-variant/30 block mb-1">PGN</label>
                  <textarea
                    value={pgnInput}
                    onChange={(e) => setPgnInput(e.target.value)}
                    placeholder="Paste PGN..."
                    rows={4}
                    className="w-full bg-surface-low border border-white/[0.06] p-2 text-[11px] font-mono text-on-surface placeholder:text-on-surface-variant/20 outline-none focus:border-primary/40 transition-colors resize-none"
                  />
                </div>
                <div>
                  <label className="text-[9px] text-on-surface-variant/30 block mb-1">FEN</label>
                  <input
                    value={fenInput}
                    onChange={(e) => setFenInput(e.target.value)}
                    placeholder="Paste FEN..."
                    className="w-full bg-surface-low border border-white/[0.06] px-2 py-1.5 text-[11px] font-mono text-on-surface placeholder:text-on-surface-variant/20 outline-none focus:border-primary/40 transition-colors"
                  />
                </div>
                <button
                  onClick={() => { if (fenInput.trim()) loadGame("", fenInput.trim()); else if (pgnInput.trim()) loadGame(pgnInput); }}
                  className="w-full py-2 bg-primary text-on-primary font-headline text-[10px] font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.96]"
                >
                  Load
                </button>
              </div>
            )}

            {/* Move list */}
            <div className="bg-surface-low flex flex-col flex-1 min-h-0">
              <div className="p-3 flex justify-between items-center border-b border-white/[0.03] shrink-0">
                <h2 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">Moves</h2>
                <span className="text-[10px] text-on-surface-variant/20 tabular-nums">{currentPly}/{history.length}</span>
              </div>
              <div ref={moveListRef} className="flex-1 overflow-y-auto" style={{ maxHeight: "min(50vh, 420px)" }}>
                {movePairs.length === 0 && (
                  <div className="p-4 text-center text-[11px] text-on-surface-variant/20">
                    Play moves on the board
                  </div>
                )}
                {movePairs.map((m, i) => (
                  <div key={m.num} className={`grid text-[12px] ${i % 2 === 0 ? "bg-surface-lowest/40" : ""}`} style={{ gridTemplateColumns: "1.8rem 1fr 1fr" }}>
                    <span className="text-[10px] text-on-surface-variant/20 self-center px-1 py-1.5">{m.num}.</span>
                    <button
                      onClick={() => goToPly(m.wPly)}
                      data-active={currentPly === m.wPly ? "" : undefined}
                      className={`text-left font-mono py-1.5 px-1 transition-colors hover:bg-primary/10 ${
                        currentPly === m.wPly ? "bg-primary/15 text-primary font-bold" : "text-on-surface-variant/70"
                      }`}>{m.white?.san}</button>
                    {m.black ? (
                      <button
                        onClick={() => goToPly(m.bPly)}
                        data-active={currentPly === m.bPly ? "" : undefined}
                        className={`text-left font-mono py-1.5 px-1 transition-colors hover:bg-primary/10 ${
                          currentPly === m.bPly ? "bg-primary/15 text-primary font-bold" : "text-on-surface-variant/50"
                        }`}>{m.black.san}</button>
                    ) : <span />}
                  </div>
                ))}
              </div>
            </div>

            {/* Opening wiki */}
            {openingName && (
              <div className="bg-surface-container border border-white/[0.04] px-3 py-2.5 space-y-1.5">
                <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/30 block">Opening</span>
                <span className="text-[12px] font-headline font-semibold text-on-surface-variant/70 block leading-snug">{openingName}</span>
                <div className="flex gap-3 pt-1 border-t border-white/[0.04]">
                  <a href={`https://en.wikipedia.org/wiki/${encodeURIComponent(openingName.replace(/:.*/, "").trim().replace(/\s+/g, "_"))}_(chess)`}
                    target="_blank" rel="noopener noreferrer" className="text-[9px] text-on-surface-variant/35 hover:text-primary transition-colors">Wikipedia</a>
                  <a href={`https://lichess.org/opening/${encodeURIComponent(openingName.replace(/:.*/, "").trim().replace(/\s+/g, "_"))}`}
                    target="_blank" rel="noopener noreferrer" className="text-[9px] text-on-surface-variant/35 hover:text-primary transition-colors">Lichess</a>
                  <a href={`https://lichess.org/analysis/${encodeURIComponent(fen)}`}
                    target="_blank" rel="noopener noreferrer" className="text-[9px] text-on-surface-variant/35 hover:text-primary transition-colors">Explorer</a>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-1.5">
              <button onClick={() => { loadGame(""); }}
                className="flex-1 py-2.5 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-primary transition-colors active:scale-[0.96]">
                New
              </button>
              <button onClick={() => {
                  const ok = saveCurrentBoard();
                  if (!ok) alert("Maximum 5 saved boards reached. Delete one first.");
                }}
                disabled={savedBoards.length >= MAX_SAVED && history.length === 0}
                className="flex-1 py-2.5 bg-surface-low border border-primary/15 font-headline text-[10px] font-bold uppercase tracking-wide text-primary/60 hover:text-primary hover:border-primary/25 transition-colors active:scale-[0.96]">
                Save Board
              </button>
              {currentPly > 0 && (
                <button
                  onClick={() => {
                    try {
                      const cards = JSON.parse(localStorage.getItem("ochess_review_cards") || "[]");
                      cards.push({ fen, type: "analysis", ply: currentPly, ts: Date.now() });
                      localStorage.setItem("ochess_review_cards", JSON.stringify(cards));
                    } catch {}
                  }}
                  className="flex-1 py-2.5 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-primary transition-colors active:scale-[0.96]">
                  + Review
                </button>
              )}
            </div>

            {/* Saved boards */}
            {savedBoards.length > 0 && (
              <div className="bg-surface-container border border-white/[0.04]">
                <div className="p-2.5 border-b border-white/[0.03] flex items-center justify-between">
                  <span className="text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40">
                    Saved ({savedBoards.length}/{MAX_SAVED})
                  </span>
                </div>
                <div className="max-h-[180px] overflow-y-auto">
                  {savedBoards.map((b) => (
                    <div key={b.id} className="flex items-center gap-2 px-2.5 py-2 border-b border-white/[0.02] last:border-0 hover:bg-surface-low/50 transition-colors group">
                      <button
                        onClick={() => loadSavedBoard(b)}
                        className="flex-1 min-w-0 text-left"
                      >
                        <span className="text-[11px] font-headline font-semibold text-on-surface-variant/60 group-hover:text-primary transition-colors block truncate">
                          {b.name}
                        </span>
                        <span className="text-[9px] text-on-surface-variant/25">
                          {new Date(b.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </span>
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteSavedBoard(b.id); }}
                        className="shrink-0 p-1 text-on-surface-variant/20 hover:text-error transition-colors opacity-0 group-hover:opacity-100"
                        title="Delete"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Info */}
            <div className="p-3 bg-surface-container border border-white/[0.04]">
              <p className="text-[10px] text-on-surface-variant/25 leading-relaxed">
                Arrow keys navigate. Delete/Backspace removes last move. Both sides move freely. Save up to {MAX_SAVED} boards to come back to later.
              </p>
            </div>
          </div>
        </div>
      </div>
      <SocialPanel />
    </div>
  );
}

function MaterialBar({ pieces, adv, color }) {
  const prefs = loadPrefs();
  const order = ["q", "r", "b", "n", "p"];
  const captured = [];
  const starting = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  for (const p of order) {
    const missing = Math.max(0, starting[p] - (pieces[p] || 0));
    for (let i = 0; i < missing; i++) captured.push(p);
  }
  const capturedColor = color === "w" ? "b" : "w";

  return (
    <div className="w-full flex items-center gap-1.5 py-1 px-1 min-h-[24px]">
      {captured.length > 0 && (
        <div className="flex items-center gap-px">
          {captured.map((p, i) => {
            const needsBrighten = capturedColor === "b";
            return (
              <img key={i} src={`/piece/${prefs.pieceSet}/${capturedColor}${p.toUpperCase()}.svg`} alt={p}
                className="w-4 h-4" style={needsBrighten ? { filter: "brightness(2.5) grayscale(0.6)", opacity: 0.7 } : { opacity: 0.6 }} draggable={false} />
            );
          })}
        </div>
      )}
      {adv > 0 && <span className="text-[10px] font-bold text-on-surface-variant/30 tabular-nums">+{adv}</span>}
    </div>
  );
}

function EditorBoard({ position, orientation, onSquareClick, pieceSet }) {
  const boardTheme = useMemo(() => {
    const prefs = loadPrefs();
    return getTheme(prefs.boardTheme);
  }, []);

  const pieces = useMemo(() => {
    const p = {};
    const names = ["wP", "wN", "wB", "wR", "wQ", "wK", "bP", "bN", "bB", "bR", "bQ", "bK"];
    for (const name of names) {
      p[name] = () => (
        <img src={`/piece/${pieceSet}/${name}.svg`} alt={name}
          style={{ width: "100%", height: "100%", position: "relative", zIndex: 2 }} draggable={false} />
      );
    }
    return p;
  }, [pieceSet]);

  const fen = useMemo(() => positionToFen(position, "w"), [position]);

  const notationStyle = { fontSize: "clamp(7px, 1.4vw, 11px)", fontWeight: 600, color: "#666666", opacity: 1 };
  const isImageBoard = boardTheme.type === "image";

  const options = useMemo(() => ({
    position: fen,
    boardOrientation: orientation,
    pieces,
    boardStyle: isImageBoard
      ? { borderRadius: "0px", backgroundImage: `url(${boardTheme.src})`, backgroundSize: "100% 100%" }
      : { borderRadius: "0px" },
    darkSquareStyle: isImageBoard ? { backgroundColor: "transparent" } : { backgroundColor: boardTheme.dark },
    lightSquareStyle: isImageBoard ? { backgroundColor: "transparent" } : { backgroundColor: boardTheme.light },
    dropSquareStyle: { boxShadow: "inset 0 0 0 2px rgba(255,255,255,0.15)" },
    animationDurationInMs: 0,
    allowDragging: false,
    showNotation: true,
    alphaNotationStyle: notationStyle,
    numericNotationStyle: notationStyle,
    onSquareClick: ({ square }) => onSquareClick(square),
  }), [fen, orientation, pieces, boardTheme, isImageBoard, onSquareClick]);

  return (
    <div className="w-full">
      <Chessboard options={options} />
    </div>
  );
}

