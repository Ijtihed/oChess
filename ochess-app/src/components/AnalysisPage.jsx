import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import InteractiveBoard from "./InteractiveBoard";
import SocialPanel from "./SocialPanel";
import { evaluate, init as initEngine, destroy as destroyEngine } from "../lib/engine";
import { getOpeningName, resetOpeningCache, isBookMove } from "../lib/openings";
import { classifyMove } from "../lib/move-classify";
import { playMoveSound } from "../lib/sounds";
import { load as loadPrefs, getTheme } from "../lib/board-prefs";
import { fetchLichessGames, fetchChesscomGames, parsePgnFile, MAX_IMPORT_GAMES } from "../lib/game-import";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

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
  const initialOrientation = location.state?.orientation || "white";

  const [mode, setMode] = useState("analysis");
  const [pgnInput, setPgnInput] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [urlLoading, setUrlLoading] = useState(false);
  const [urlError, setUrlError] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [importUsername, setImportUsername] = useState("");
  const [importPlatform, setImportPlatform] = useState("lichess");
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState(null);
  const [importedGames, setImportedGames] = useState([]);
  const [importTruncated, setImportTruncated] = useState(false);
  const [importProgress, setImportProgress] = useState("");
  const importAbortRef = useRef(null);
  const fileInputRef = useRef(null);
  const [savedBoards, setSavedBoards] = useState(loadSavedBoards);
  const [history, setHistory] = useState([]);
  const [currentPly, setCurrentPly] = useState(0);
  const [fen, setFen] = useState(START_FEN);
  const [startFen, setStartFen] = useState(START_FEN);
  const [orientation, setOrientation] = useState(initialOrientation);

  const [engineOn, setEngineOn] = useState(true);
  const [engineDepth, setEngineDepth] = useState(18);
  const [numPV, setNumPV] = useState(2);
  const [posEval, setPosEval] = useState(null);
  const [evalLoading, setEvalLoading] = useState(false);
  const [pvSan, setPvSan] = useState([]);
  const [pvLines, setPvLines] = useState([]);
  const [showBestMove, setShowBestMove] = useState(true);
  // Precomputed evaluations keyed by ply for the currently loaded
  // mainline. Each entry stores enough state to render the eval bar,
  // multi-PV panel, arrows, and move-list annotations without making
  // a fresh Stockfish call when the user navigates ply-by-ply.
  // Shape: {
  //   signature: string,                // invalidates on depth/numPV/startFen/history change
  //   byPly: { [ply]: {
  //     fen,
  //     posEval: { eval_cp, eval_mate, bestMove, pv, depth },
  //     pvLines: [{ eval_cp, eval_mate, depth, bestMove, pv }],
  //     whiteRel: { cp, mate, bestMove },
  //   } }
  // }
  const analysisCacheRef = useRef({ signature: "", byPly: {} });
  const [precomputeProgress, setPrecomputeProgress] = useState(0);
  const [precomputeTotal, setPrecomputeTotal] = useState(0);
  const [precomputeRunning, setPrecomputeRunning] = useState(false);
  // Bumped to cancel any in-flight precomputation pass.
  const precomputeIdRef = useRef(0);
  // Closure-friendly mirror of precomputeRunning so the per-FEN
  // effect can decide whether to wait on precompute or fall through
  // to a direct engine call without re-running.
  const precomputeRunningRef = useRef(false);
  const [boardAnnotation, setBoardAnnotation] = useState(null);

  const [openingName, setOpeningName] = useState(null);
  const [fenCopied, setFenCopied] = useState(false);
  const [pgnCopied, setPgnCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);

  const [editorPos, setEditorPos] = useState({});
  const [editorPiece, setEditorPiece] = useState("wQ");
  const [editorTurn, setEditorTurn] = useState("w");
  const [gameHeaders, setGameHeaders] = useState(null);

  const baseRef = useRef(new Chess());
  const moveListRef = useRef(null);
  const evalAbort = useRef(0);
  const currentPlyRef = useRef(currentPly);
  const historyRef = useRef(history);
  currentPlyRef.current = currentPly;
  historyRef.current = history;

  const uciToSanList = useCallback((uciArr, startFenStr) => {
    try {
      const g = new Chess(startFenStr);
      const sans = [];
      for (let i = 0; i < Math.min(10, uciArr.length); i++) {
        const uci = uciArr[i];
        const m = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
        if (m) sans.push(m.san); else break;
      }
      return sans;
    } catch { return []; }
  }, []);

  // Build a white-relative summary used by the eval bar and move
  // classification, regardless of whose turn it is in `posFen`.
  const toWhiteRel = useCallback((top, posFen) => {
    if (!top) return null;
    const sideToMove = (posFen.split(" ")[1] || "w");
    const sign = sideToMove === "w" ? 1 : -1;
    return {
      cp: top.eval_cp !== null ? sign * top.eval_cp : null,
      mate: top.eval_mate !== null ? sign * top.eval_mate : null,
      bestMove: top.bestMove || null,
    };
  }, []);

  // Translate a multi-PV / single-PV engine response into the cached
  // shape we re-render from when navigating ply-by-ply.
  const buildCacheEntry = useCallback((result, posFen) => {
    let top = null;
    let lines = [];
    if (Array.isArray(result)) {
      top = result[0] || null;
      lines = result.map((line) => ({
        eval_cp: line.eval_cp,
        eval_mate: line.eval_mate,
        depth: line.depth,
        bestMove: line.bestMove,
        pv: line.pv || [],
      }));
    } else if (result) {
      top = result;
      lines = [{
        eval_cp: result.eval_cp,
        eval_mate: result.eval_mate,
        depth: result.depth,
        bestMove: result.bestMove,
        pv: result.pv || [],
      }];
    }
    return {
      fen: posFen,
      posEval: top,
      pvLines: lines,
      whiteRel: toWhiteRel(top, posFen),
    };
  }, [toWhiteRel]);

  // Render a precomputed entry into the visible engine state.
  const applyCacheEntry = useCallback((entry) => {
    if (!entry) return;
    setPosEval(entry.posEval);
    setEvalLoading(false);
    setPvLines(entry.pvLines.map((line) => ({
      eval_cp: line.eval_cp,
      eval_mate: line.eval_mate,
      depth: line.depth,
      bestMove: line.bestMove,
      san: uciToSanList(line.pv || [], entry.fen),
    })));
    setPvSan(entry.posEval?.pv ? uciToSanList(entry.posEval.pv, entry.fen) : []);
  }, [uciToSanList]);

  useEffect(() => {
    if (!fen || !engineOn) { setPosEval(null); setEvalLoading(false); setPvSan([]); setPvLines([]); setBoardAnnotation(null); return; }

    const id = ++evalAbort.current;
    const snapPly = currentPlyRef.current;
    const snapHist = historyRef.current;
    const cache = analysisCacheRef.current;

    // Cache hit: serve from the precomputed table without touching
    // the worker. The byPly entry is keyed by ply but we still verify
    // the FEN matches because the user might be viewing an off-line
    // position that happens to share a ply index.
    const cached = cache.byPly[snapPly];
    const hit = cached && cached.fen === fen && cached.posEval;
    if (hit) {
      applyCacheEntry(cached);
    } else {
      setEvalLoading(true);
      setPosEval(null);
      setPvSan([]);
      setPvLines([]);
    }

    (async () => {
      let entry = hit ? cached : null;

      // When there is a loaded mainline, the precompute pass owns
      // the engine — wait for it to fill this ply rather than racing
      // it with our own search (which would just preempt itself).
      // We bail out of the wait when (a) the user navigated away
      // (`evalAbort` bumped), or (b) precompute finished without
      // populating this ply (e.g. it gave up after retry exhaustion),
      // in which case we fall through and evaluate directly.
      const hasMainline = snapHist.length > 0;
      if (!entry && hasMainline) {
        while (evalAbort.current === id) {
          const updated = cache.byPly[snapPly];
          if (updated?.fen === fen && updated.posEval) {
            entry = updated;
            applyCacheEntry(entry);
            break;
          }
          if (!precomputeRunningRef.current) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (evalAbort.current !== id) return;
      }

      if (!entry) {
        try {
          await initEngine();
          const result = await evaluate(fen, engineDepth, numPV);
          if (evalAbort.current !== id) return;
          if (!result) { setEvalLoading(false); return; }
          entry = buildCacheEntry(result, fen);
          cache.byPly[snapPly] = entry;
          applyCacheEntry(entry);
        } catch {
          if (evalAbort.current === id) setEvalLoading(false);
          return;
        }
      }

      if (!entry?.whiteRel) { setBoardAnnotation(null); return; }

      if (snapPly > 0) {
        const move = snapHist[snapPly - 1];
        const movingColor = snapPly % 2 === 1 ? "w" : "b";
        const prevEntry = cache.byPly[snapPly - 1];
        const prevEval = prevEntry?.whiteRel || null;
        const curEval = entry.whiteRel;
        const book = await isBookMove(snapHist, snapPly);
        if (evalAbort.current !== id) return;
        const isBest = prevEval?.bestMove && move && (prevEval.bestMove.slice(0, 2) === move.from && prevEval.bestMove.slice(2, 4) === move.to);
        const annot = classifyMove(prevEval, curEval, movingColor, { isBook: book, isBestMove: isBest });
        setBoardAnnotation(move && annot && annot.glyph !== "Book" ? { square: move.to, ...annot } : null);
      } else {
        setBoardAnnotation(null);
      }
    })();
  }, [fen, engineOn, engineDepth, numPV, applyCacheEntry, buildCacheEntry]);

  // Precompute Stockfish evaluations for every ply of the loaded
  // mainline. Replaces the previous "evaluate only the FEN you're
  // looking at, on demand" behavior so navigating back and forth
  // through a reviewed game doesn't repeatedly burn the engine.
  //
  // Runs sequentially through the shared engine worker, starting at
  // the user's current ply and expanding outward. The per-FEN effect
  // above defers to us while we're running; if anything else
  // preempts our search the loop retries a few times before moving
  // on so the cache stays dense.
  useEffect(() => {
    if (!engineOn) {
      setPrecomputeRunning(false);
      precomputeRunningRef.current = false;
      setPrecomputeProgress(0);
      setPrecomputeTotal(0);
      return;
    }
    const moveSig = history.map((m) => m.san).join(" ");
    const settingsSig = `${startFen}|${engineDepth}|${numPV}`;
    const signature = `${settingsSig}|${moveSig}`;
    const cache = analysisCacheRef.current;
    if (cache.signature !== signature) {
      // The signature changed. If only the move list changed (same
      // settings + start FEN), we can carry forward any cached plies
      // whose FENs still match the new mainline — that lets a
      // user's mid-line edit reuse evals up to the divergence point.
      // If depth or multi-PV changed, throw the whole cache away
      // because the stored evals are at the wrong setting.
      const prevSettingsSig = (cache.signature || "").split("|").slice(0, 3).join("|");
      const survived = {};
      if (prevSettingsSig === settingsSig) {
        const g = new Chess(startFen);
        const root = cache.byPly[0];
        if (root?.fen === g.fen()) survived[0] = root;
        for (let i = 0; i < history.length; i++) {
          try { g.move(history[i].san); } catch { break; }
          const ply = i + 1;
          const prev = cache.byPly[ply];
          if (prev?.fen === g.fen()) survived[ply] = prev;
        }
      }
      analysisCacheRef.current = { signature, byPly: survived };
    }
    if (history.length === 0) {
      setPrecomputeRunning(false);
      precomputeRunningRef.current = false;
      setPrecomputeProgress(0);
      setPrecomputeTotal(0);
      return;
    }

    const myId = ++precomputeIdRef.current;
    const positions = [];
    {
      const g = new Chess(startFen);
      positions.push({ ply: 0, fen: g.fen() });
      for (let i = 0; i < history.length; i++) {
        try { g.move(history[i].san); } catch { break; }
        positions.push({ ply: i + 1, fen: g.fen() });
      }
    }
    // Walk outward from the current ply so the position the user is
    // actually looking at gets evaluated first, then neighbors fill
    // in. Without this, jumping to the end of a long game would show
    // a blank eval until the engine slogged through every prior ply.
    {
      const start = Math.max(0, Math.min(currentPlyRef.current, positions.length - 1));
      const ordered = [];
      for (let off = 0; off < positions.length; off++) {
        const fwd = start + off;
        const back = start - off;
        if (off === 0) ordered.push(positions[start]);
        else {
          if (fwd < positions.length) ordered.push(positions[fwd]);
          if (back >= 0) ordered.push(positions[back]);
        }
      }
      positions.length = 0;
      positions.push(...ordered);
    }
    setPrecomputeTotal(positions.length);
    // Mark as running synchronously so the per-FEN effect (which
    // mounts in the same render) sees us as active and waits on the
    // cache instead of issuing a redundant direct evaluation.
    precomputeRunningRef.current = true;

    (async () => {
      try { await initEngine(); } catch {
        precomputeRunningRef.current = false;
        return;
      }
      if (precomputeIdRef.current !== myId) {
        precomputeRunningRef.current = false;
        return;
      }

      setPrecomputeRunning(true);
      const c = analysisCacheRef.current;
      let done = 0;
      const MAX_RETRIES_PER_PLY = 3;
      const cancelled = () => precomputeIdRef.current !== myId;
      for (const entry of positions) {
        if (cancelled()) { precomputeRunningRef.current = false; return; }
        if (c.byPly[entry.ply]?.posEval) {
          done++;
          setPrecomputeProgress(done);
          continue;
        }

        // The on-demand effect can preempt our search by issuing a
        // fresh `position fen ...` to the same worker, in which case
        // `evaluate` resolves with `null`. Retry a few times before
        // giving up so the timeline of cached evals stays dense.
        for (let attempt = 0; attempt < MAX_RETRIES_PER_PLY; attempt++) {
          if (cancelled()) { precomputeRunningRef.current = false; return; }
          if (c.byPly[entry.ply]?.posEval) break;
          let result = null;
          try {
            result = await evaluate(entry.fen, engineDepth, numPV);
          } catch { result = null; }
          if (cancelled()) { precomputeRunningRef.current = false; return; }
          if (result) {
            c.byPly[entry.ply] = buildCacheEntry(result, entry.fen);
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }

        done++;
        setPrecomputeProgress(done);
      }
      if (cancelled()) { precomputeRunningRef.current = false; return; }
      setPrecomputeRunning(false);
      precomputeRunningRef.current = false;
    })();

    return () => {
      // Bumping the id stops the loop on its next iteration.
      precomputeIdRef.current++;
      precomputeRunningRef.current = false;
    };
  }, [history, startFen, engineOn, engineDepth, numPV, buildCacheEntry]);

  useEffect(() => {
    resetOpeningCache();
    if (history.length > 0 && history.length <= 30) {
      getOpeningName(history).then((name) => { if (name) setOpeningName(name); });
    } else if (history.length === 0) {
      setOpeningName(null);
    }
  }, [history.length]);

  // Tear down the Stockfish worker when the page unmounts. Without
  // this the worker keeps running across route changes and racks up
  // memory and CPU on long sessions.
  useEffect(() => () => {
    try { destroyEngine(); } catch {}
  }, []);

  const loadGame = useCallback((pgn, customStartFen) => {
    const g = new Chess();
    if (customStartFen) {
      try { g.load(customStartFen); } catch { return false; }
      setStartFen(customStartFen);
    } else {
      setStartFen(START_FEN);
    }
    if (pgn && pgn.trim()) {
      try {
        g.loadPgn(pgn);
      } catch (err) {
        console.warn("loadPgn failed, trying move-by-move:", err);
        try {
          const movesOnly = pgn.replace(/\[.*?\]\s*/g, "").replace(/1-0|0-1|1\/2-1\/2|\*/g, "").trim();
          for (const tok of movesOnly.split(/\s+/)) {
            if (/^\d+\./.test(tok) || !tok) continue;
            g.move(tok);
          }
        } catch {
          return false;
        }
      }
    }
    const hist = g.history({ verbose: true });
    baseRef.current = g;
    // New game → drop any precomputed evaluations from the previous
    // game so we don't index into stale plies. The signature-based
    // useEffect would clear this on its next run too, but doing it
    // synchronously avoids a flash of wrong annotations.
    analysisCacheRef.current = { signature: "", byPly: {} };
    setPrecomputeProgress(0);
    setPrecomputeTotal(0);
    setPrecomputeRunning(false);
    analysisIdRef.current = Date.now().toString(36);
    setHistory(hist);
    setCurrentPly(hist.length);
    setFen(g.fen());
    setMode("analysis");
    setShowImport(false);

    try {
      const hdrs = g.header();
      if (hdrs && (hdrs.White || hdrs.Black || hdrs.Result || hdrs.Event)) {
        setGameHeaders(hdrs);
      } else {
        setGameHeaders(null);
      }
    } catch { setGameHeaders(null); }

    return true;
  }, []);

  const urlImportAbortRef = useRef(null);

  const cancelUrlImport = useCallback(() => {
    urlImportAbortRef.current?.abort();
    urlImportAbortRef.current = null;
    setUrlLoading(false);
  }, []);

  const importFromUrl = useCallback(async (url) => {
    cancelUrlImport();
    const ac = new AbortController();
    urlImportAbortRef.current = ac;
    setUrlLoading(true);
    setUrlError(null);
    try {
      const u = url.trim();
      let pgn = null;

      const lichessMatch = u.match(/lichess\.org\/(?:game\/export\/)?([a-zA-Z0-9]{8,12})/);
      if (lichessMatch) {
        const id = lichessMatch[1].slice(0, 8);
        const res = await fetch(`https://lichess.org/game/export/${id}`, {
          headers: { Accept: "application/x-chess-pgn" },
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`Lichess returned ${res.status}`);
        pgn = await res.text();
      }

      if (!pgn) {
        const chesscomMatch = u.match(/chess\.com\/(?:game\/)?(?:live|daily|computer)\/(\d+)/);
        if (chesscomMatch) {
          const id = chesscomMatch[1];
          const res = await fetch(`https://api.chess.com/pub/game/${id}`, { signal: ac.signal });
          if (res.ok) {
            const data = await res.json();
            pgn = data.pgn;
          }
          if (!pgn) {
            const cbRes = await fetch(`https://www.chess.com/callback/live/game/${id}`, { signal: ac.signal });
            if (cbRes.ok) {
              const cbData = await cbRes.json();
              pgn = cbData.pgn || cbData.game?.pgn;
            }
          }
          if (!pgn) throw new Error("Could not fetch game from Chess.com");
        }
      }

      if (!pgn) throw new Error("Unrecognized URL. Paste a Lichess or Chess.com game link.");
      const ok = loadGame(pgn);
      if (!ok) throw new Error("Failed to parse the PGN from this game.");
      setUrlInput("");
    } catch (err) {
      if (err.name === "AbortError") {
        setUrlError(null);
      } else {
        setUrlError(err.message || "Import failed");
      }
    } finally {
      setUrlLoading(false);
      urlImportAbortRef.current = null;
    }
  }, [loadGame, cancelUrlImport]);

  const cancelImport = useCallback(() => {
    importAbortRef.current?.abort();
    importAbortRef.current = null;
    setImportLoading(false);
    setImportProgress("");
  }, []);

  const importByUsername = useCallback(async () => {
    if (!importUsername.trim()) return;
    cancelImport();
    const ac = new AbortController();
    importAbortRef.current = ac;
    setImportLoading(true);
    setImportError(null);
    setImportedGames([]);
    setImportProgress("Connecting...");
    try {
      const onProgress = importPlatform === "lichess"
        ? (count) => setImportProgress(`${count} games fetched...`)
        : (count, done, total) => setImportProgress(`${count} games (archive ${done}/${total})...`);
      const games = importPlatform === "lichess"
        ? await fetchLichessGames(importUsername.trim(), { signal: ac.signal, onProgress })
        : await fetchChesscomGames(importUsername.trim(), { signal: ac.signal, onProgress });
      if (games.length === 0) throw new Error("No games found.");
      setImportedGames(games);
      setImportTruncated(games.truncated === true);
      setImportProgress("");
    } catch (err) {
      if (err.name === "AbortError") {
        setImportProgress("");
      } else {
        setImportError(err.message || "Import failed");
        setImportProgress("");
      }
    } finally {
      setImportLoading(false);
      importAbortRef.current = null;
    }
  }, [importUsername, importPlatform, cancelImport]);

  const handleFileUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (!text) return;
      const games = parsePgnFile(text);
      if (games.length === 0) {
        loadGame(text);
      } else if (games.length === 1) {
        loadGame(games[0].pgn);
      } else {
        setImportedGames(games);
        setShowImport(true);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }, [loadGame]);

  const initialLoadRef = useRef(false);

  useEffect(() => {
    if (!initialLoadRef.current) {
      initialLoadRef.current = true;
      const params = new URLSearchParams(window.location.search);
      const sharedMoves = params.get("moves");
      const sharedFen = params.get("fen");
      const sharedPly = params.get("ply");

      if (sharedMoves || sharedFen) {
        const startF = sharedFen || START_FEN;
        const g = new Chess(startF);
        if (sharedMoves) {
          for (const uci of sharedMoves.split(",")) {
            try {
              g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
            } catch { break; }
          }
        }
        setStartFen(startF);
        const hist = g.history({ verbose: true });
        baseRef.current = g;
        setHistory(hist);
        const parsedPly = parseInt(sharedPly);
        const ply = sharedPly ? Math.max(0, Math.min(Number.isFinite(parsedPly) ? parsedPly : hist.length, hist.length)) : hist.length;
        setCurrentPly(ply);
        const temp = new Chess(startF);
        for (let i = 0; i < ply; i++) temp.move(hist[i].san);
        setFen(temp.fen());
        const sharedId = params.get("id");
        const sharedW = params.get("w");
        const sharedB = params.get("b");
        if (sharedId) analysisIdRef.current = sharedId;
        if (sharedW || sharedB) {
          setGameHeaders({ White: sharedW || "?", Black: sharedB || "?" });
        }
        return;
      }
    }

    if (initialPgn) {
      loadGame(initialPgn);
      if (initialOrientation) setOrientation(initialOrientation);
    } else if (initialFen) {
      loadGame("", initialFen);
    }
  }, [initialPgn, initialFen, initialOrientation]);

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
      // Analysis is a contemplative mode - there's no follow-up
      // Victory/Defeat sound when the user steps through a mate, so
      // play the dramatic Checkmate cue here.
      playMoveSound(result, { allowMateSound: true });
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
    // The new history changes the precomputation signature so the
    // background pass would rebuild from scratch anyway. Trim our
    // existing cache eagerly so move-list annotations past the cut
    // don't render stale glyphs in the meantime.
    const cache = analysisCacheRef.current;
    if (cache?.byPly) {
      for (const key of Object.keys(cache.byPly)) {
        if (Number(key) >= currentPly) delete cache.byPly[key];
      }
    }
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
      else if (e.key === "f" || e.key === "F") { setOrientation((o) => o === "white" ? "black" : "white"); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mode, goToPly, currentPly, history.length, deleteMove]);

  const analysisIdRef = useRef(null);

  useEffect(() => {
    if (mode !== "analysis") return;
    if (!analysisIdRef.current) analysisIdRef.current = Date.now().toString(36);
    const params = new URLSearchParams();
    params.set("id", analysisIdRef.current);
    if (gameHeaders?.White) params.set("w", gameHeaders.White);
    if (gameHeaders?.Black) params.set("b", gameHeaders.Black);
    if (startFen !== START_FEN) params.set("fen", startFen);
    if (history.length > 0) {
      params.set("moves", history.map((m) => m.from + m.to + (m.promotion || "")).join(","));
    }
    if (currentPly !== history.length) params.set("ply", String(currentPly));
    const qs = params.toString();
    const url = `/analysis${qs ? "?" + qs : ""}`;
    window.history.replaceState(null, "", url);
  }, [mode, history, currentPly, startFen, gameHeaders]);

  const movePairs = useMemo(() => {
    const pairs = [];
    for (let i = 0; i < history.length; i += 2) {
      pairs.push({ num: Math.floor(i / 2) + 1, white: history[i], black: history[i + 1] || null, wPly: i + 1, bPly: i + 2 });
    }
    return pairs;
  }, [history]);

  const mat = useMemo(() => materialCount(fen), [fen]);

  // Stockfish UCI scores are reported from the side-to-move's POV.
  // Convert to white-relative so the eval bar / label always reads
  // "positive = white winning, negative = black winning" regardless
  // of whose turn it is.
  const whiteRelEval = useMemo(() => {
    if (!posEval) return null;
    const sideToMove = (fen.split(" ")[1] || "w");
    const sign = sideToMove === "w" ? 1 : -1;
    return {
      cp: posEval.eval_cp !== null ? sign * posEval.eval_cp : null,
      mate: posEval.eval_mate !== null ? sign * posEval.eval_mate : null,
    };
  }, [posEval, fen]);

  const evalLabel = useMemo(() => {
    if (!whiteRelEval) return evalLoading ? "..." : "?";
    if (whiteRelEval.mate !== null) {
      const sign = whiteRelEval.mate > 0 ? "+" : "-";
      return `${sign}M${Math.abs(whiteRelEval.mate)}`;
    }
    if (whiteRelEval.cp !== null) {
      const p = whiteRelEval.cp / 100;
      if (Math.abs(p) < 0.15) return "0.0";
      return (p > 0 ? "+" : "") + p.toFixed(1);
    }
    return "?";
  }, [whiteRelEval, evalLoading]);

  const evalBarPct = useMemo(() => {
    if (!whiteRelEval) return 50;
    if (whiteRelEval.mate !== null) return whiteRelEval.mate > 0 ? 96 : 4;
    if (whiteRelEval.cp !== null) {
      const clamped = Math.max(-600, Math.min(600, whiteRelEval.cp));
      return 50 + (clamped / 600) * 46;
    }
    return 50;
  }, [whiteRelEval]);

  const highlightSquares = useMemo(() => {
    const sq = {};
    if (currentPly > 0 && currentPly <= history.length) {
      const m = history[currentPly - 1];
      sq[m.from] = { backgroundColor: "rgba(59,130,246,0.18)" };
      sq[m.to] = { backgroundColor: "rgba(59,130,246,0.28)" };
    }
    return sq;
  }, [currentPly, history]);

  const PV_COLORS = useMemo(() => [
    "rgba(76,175,80,0.75)",
    "rgba(66,165,245,0.65)",
    "rgba(255,183,77,0.6)",
    "rgba(186,104,200,0.55)",
  ], []);

  const engineArrows = useMemo(() => {
    if (!showBestMove || !engineOn) return [];
    const validSq = /^[a-h][1-8]$/;
    const arrows = [];
    for (let i = 0; i < pvLines.length; i++) {
      const line = pvLines[i];
      if (!line?.bestMove || line.bestMove.length < 4) continue;
      const from = line.bestMove.slice(0, 2);
      const to = line.bestMove.slice(2, 4);
      if (!validSq.test(from) || !validSq.test(to)) continue;
      arrows.push({ startSquare: from, endSquare: to, color: PV_COLORS[i] || PV_COLORS[PV_COLORS.length - 1] });
    }
    return arrows;
  }, [showBestMove, engineOn, pvLines, PV_COLORS]);

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
      <div className="flex min-h-[calc(100dvh-4rem)]">
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
    <div className="flex min-h-[calc(100dvh-4rem)]">
      <div className="flex-1 min-w-0 px-4 sm:px-6 md:px-10 xl:px-6 py-3 sm:py-4 w-full mx-auto max-w-[1400px] xl:max-w-[1500px] 2xl:max-w-[1600px]">
        <div className="flex flex-col xl:flex-row gap-4 xl:gap-6">
          {/* ── Board column - scales up at xl/2xl. ── */}
          <div className="flex-1 flex flex-col items-center xl:items-start max-w-[760px] xl:max-w-[920px] 2xl:max-w-[1040px]">
            {/* Top bar */}
            <div className="w-full flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <h1 className="font-headline text-xl font-extrabold tracking-tighter text-primary">Analysis</h1>
                {gameHeaders?.White && gameHeaders?.Black && (
                  <span className="text-[11px] font-mono text-on-surface-variant/40 truncate max-w-[200px]">{gameHeaders.White} vs {gameHeaders.Black}</span>
                )}
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

            {/* Game info bar (when loaded from PGN with headers) */}
            {gameHeaders && (
              <div className="w-full mb-2 flex items-center gap-3 text-[11px] text-on-surface-variant/50">
                {gameHeaders.White && gameHeaders.Black && (
                  <span className="font-mono">
                    <span className="text-on-surface-variant/70">{gameHeaders.White}</span>
                    <span className="mx-1.5 text-on-surface-variant/25">vs</span>
                    <span className="text-on-surface-variant/70">{gameHeaders.Black}</span>
                  </span>
                )}
                {gameHeaders.Result && gameHeaders.Result !== "*" && (
                  <span className="px-1.5 py-0.5 bg-surface-low border border-white/[0.04] text-[10px] font-mono font-bold">{gameHeaders.Result}</span>
                )}
                {gameHeaders.Event && gameHeaders.Event !== "?" && (
                  <span className="text-on-surface-variant/30">{gameHeaders.Event}</span>
                )}
                {gameHeaders.Date && gameHeaders.Date !== "????.??.??" && (
                  <span className="text-on-surface-variant/25">{gameHeaders.Date}</span>
                )}
              </div>
            )}

            {/* Material bar (top - opponent) */}
            <MaterialBar pieces={topIsBlack ? mat.bPieces : mat.wPieces} adv={topIsBlack ? (mat.diff < 0 ? Math.abs(mat.diff) : 0) : (mat.diff > 0 ? mat.diff : 0)} color={topIsBlack ? "b" : "w"} />

            {/* Board + eval bar - clamp by viewport height so the
                board doesn't overflow on short widescreens. */}
            <div
              className="w-full flex gap-0 mx-auto"
              style={{ maxWidth: "min(100%, calc(100dvh - 11rem))" }}
            >
              {/* Eval bar */}
              {engineOn && (
                <div className="w-9 shrink-0 flex flex-col relative select-none" style={{ minHeight: "100%" }}>
                  <div
                    className="flex items-start justify-center transition-all duration-300 ease-out"
                    style={{ height: `${topPct}%`, backgroundColor: topIsBlack ? "#1a1a1a" : "#e8e8e8", minHeight: "16px" }}
                  >
                    {topPct >= 50 && (
                      <span className="text-[11px] font-mono font-bold leading-none pt-1 tabular-nums"
                        style={{ color: topIsBlack ? "#bbb" : "#222" }}>
                        {evalLabel}
                      </span>
                    )}
                  </div>
                  <div
                    className="flex-1 flex items-end justify-center transition-all duration-300 ease-out"
                    style={{ backgroundColor: topIsBlack ? "#e8e8e8" : "#1a1a1a", minHeight: "16px" }}
                  >
                    {topPct < 50 && (
                      <span className="text-[11px] font-mono font-bold leading-none pb-1 tabular-nums"
                        style={{ color: topIsBlack ? "#222" : "#bbb" }}>
                        {evalLabel}
                      </span>
                    )}
                  </div>
                  {evalLoading && !posEval && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="w-3 h-3 border border-on-surface-variant/20 border-t-on-surface-variant/50 rounded-full animate-spin" aria-label="Loading evaluation" />
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
                  arrows={engineArrows}
                  squareAnnotation={boardAnnotation}
                />
              </div>
            </div>

            {/* Material bar (bottom - player side) */}
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
              <button onClick={() => {
                  const blob = new Blob([currentPgn], { type: "application/x-chess-pgn" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a"); a.href = url; a.download = "analysis.pgn"; a.click();
                  URL.revokeObjectURL(url);
                }}
                className="shrink-0 px-2 py-1 text-[9px] font-headline font-bold uppercase tracking-wide border border-white/[0.04] bg-surface-low text-on-surface-variant/30 hover:text-primary transition-colors">
                DL
              </button>
            </div>
          </div>

          {/* ── Sidebar ── */}
          <div className="w-full xl:w-[320px] shrink-0 flex flex-col gap-3">
            {/* Engine panel */}
            <div className="bg-surface-container border border-white/[0.04] p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40">Stockfish</span>
                  {engineOn && posEval && (
                    <span className="text-[13px] font-mono font-bold text-primary tabular-nums">{evalLabel}</span>
                  )}
                  {engineOn && evalLoading && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 border border-primary/30 border-t-primary rounded-full animate-spin" />
                      <span className="text-[10px] text-on-surface-variant/40">Loading&hellip;</span>
                    </div>
                  )}
                </div>
                <button onClick={() => setEngineOn(!engineOn)}
                  className={`px-2.5 py-1 text-[11px] font-headline font-bold uppercase tracking-wide border transition-colors ${
                    engineOn ? "border-primary/20 bg-primary/10 text-primary" : "border-white/[0.04] bg-surface-low text-on-surface-variant/30"
                  }`}>
                  {engineOn ? "On" : "Off"}
                </button>
              </div>

              {engineOn && precomputeRunning && precomputeTotal > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-on-surface-variant/55">
                    <span className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 border border-primary/30 border-t-primary rounded-full animate-spin shrink-0" />
                      Analyzing {precomputeProgress}/{precomputeTotal}
                    </span>
                    <span className="tabular-nums">{Math.round((precomputeProgress / precomputeTotal) * 100)}%</span>
                  </div>
                  <div className="h-0.5 bg-surface-low overflow-hidden">
                    <div
                      className="h-full bg-primary/40 transition-all duration-300"
                      style={{ width: `${(precomputeProgress / precomputeTotal) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              {engineOn && (
                <>
                  {/* Depth selector */}
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-on-surface-variant/40 shrink-0">Depth</span>
                    <div className="flex gap-1 flex-wrap">
                      {[10, 14, 18, 22, 26, 30].map((d) => (
                        <button key={d} onClick={() => setEngineDepth(d)}
                          className={`px-2 py-0.5 text-[12px] font-mono font-bold transition-colors ${
                            engineDepth === d ? "bg-primary text-on-primary" : "bg-surface-low text-on-surface-variant/40 hover:text-primary"
                          }`}>{d}</button>
                      ))}
                    </div>
                  </div>

                  {/* Lines + show arrows */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-on-surface-variant/40 shrink-0">Lines</span>
                      <button onClick={() => setNumPV(Math.max(1, numPV - 1))}
                        className="w-6 h-6 flex items-center justify-center text-[13px] font-mono font-bold bg-surface-low text-on-surface-variant/40 hover:text-primary transition-colors">−</button>
                      <span className="text-[13px] font-mono font-bold text-on-surface-variant/70 tabular-nums w-4 text-center">{numPV}</span>
                      <button onClick={() => setNumPV(Math.min(4, numPV + 1))}
                        className="w-6 h-6 flex items-center justify-center text-[13px] font-mono font-bold bg-surface-low text-on-surface-variant/40 hover:text-primary transition-colors">+</button>
                    </div>
                    <button onClick={() => setShowBestMove(!showBestMove)}
                      className={`px-2.5 py-1 text-[11px] font-mono font-bold transition-colors ${
                        showBestMove ? "bg-emerald-500/15 text-emerald-400" : "bg-surface-low text-on-surface-variant/30"
                      }`}>{showBestMove ? "Arrows" : "Off"}</button>
                  </div>

                  {/* Multi-PV lines */}
                  {pvLines.length > 0 && (
                    <div className="space-y-0.5">
                      {pvLines.map((line, i) => (
                        <div key={i} className="bg-surface-lowest/50 px-2.5 py-2 flex gap-2 items-start">
                          <span className="shrink-0 w-2.5 h-2.5 rounded-full mt-[5px]" style={{ backgroundColor: PV_COLORS[i] || PV_COLORS[PV_COLORS.length - 1] }} />
                          <span className="text-[13px] font-mono font-bold shrink-0 tabular-nums" style={{ color: PV_COLORS[i] || PV_COLORS[PV_COLORS.length - 1] }}>
                            {line.eval_mate !== null
                              ? `M${line.eval_mate}`
                              : line.eval_cp !== null
                                ? (line.eval_cp >= 0 ? "+" : "") + (line.eval_cp / 100).toFixed(1)
                                : "?"}
                          </span>
                          <span className="text-[12px] font-mono text-on-surface-variant/55 leading-relaxed break-words">
                            {line.san.join(" ") || "..."}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  <p className="text-[11px] text-on-surface-variant/55 leading-relaxed">
                    Local engine - nothing sent to a server.
                    {engineDepth >= 22 && " Higher depth may be slow."}
                  </p>
                </>
              )}
            </div>

            {/* Import panel (collapsible) */}
            {showImport && (
              <div className="bg-surface-container border border-white/[0.04] p-3 space-y-2 anim-fade-up" style={{ "--delay": "0s" }}>

                {/* Row 1: Platform toggle + username + fetch */}
                <div>
                  <div className="flex gap-1 mb-1">
                    <div className="flex shrink-0">
                      {["lichess", "chesscom"].map((p) => (
                        <button key={p} onClick={() => setImportPlatform(p)}
                          className={`px-2 py-1 text-[10px] font-bold border border-white/[0.06] transition-colors ${importPlatform === p ? "bg-primary/15 text-primary border-primary/20" : "bg-surface-low text-on-surface-variant/40 hover:text-primary"} ${p === "lichess" ? "border-r-0" : ""}`}>
                          {p === "lichess" ? "Lichess" : "Chess.com"}
                        </button>
                      ))}
                    </div>
                    <input
                      value={importUsername}
                      onChange={(e) => { setImportUsername(e.target.value); setImportError(null); }}
                      placeholder="Username..."
                      className="flex-1 min-w-0 bg-surface-low border border-white/[0.06] px-2 py-1 text-[11px] font-mono text-on-surface placeholder:text-on-surface-variant/20 outline-none focus:border-primary/40"
                      onKeyDown={(e) => { if (e.key === "Enter") importByUsername(); }}
                    />
                    {importLoading ? (
                      <button onClick={cancelImport}
                        className="px-2.5 py-1 bg-error/80 text-on-primary font-headline text-[10px] font-bold uppercase hover:bg-error transition-colors shrink-0">
                        Stop
                      </button>
                    ) : (
                      <button onClick={importByUsername}
                        className="px-2.5 py-1 bg-primary text-on-primary font-headline text-[10px] font-bold uppercase hover:bg-primary-dim transition-colors shrink-0">
                        Fetch
                      </button>
                    )}
                  </div>
                  {importProgress && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 border border-primary/30 border-t-primary rounded-full animate-spin shrink-0" />
                      <span className="text-[10px] text-on-surface-variant/40">{importProgress}</span>
                    </div>
                  )}
                  {importError && <p className="text-[10px] text-error">{importError}</p>}
                </div>

                {/* Row 2: Game URL */}
                <div className="flex gap-1">
                  <input
                    value={urlInput}
                    onChange={(e) => { setUrlInput(e.target.value); setUrlError(null); }}
                    placeholder="Game URL (lichess.org/... or chess.com/...)"
                    className="flex-1 min-w-0 bg-surface-low border border-white/[0.06] px-2 py-1 text-[11px] font-mono text-on-surface placeholder:text-on-surface-variant/20 outline-none focus:border-primary/40"
                    onKeyDown={(e) => { if (e.key === "Enter" && urlInput.trim()) importFromUrl(urlInput); }}
                  />
                  <button
                    onClick={() => urlInput.trim() && importFromUrl(urlInput)}
                    disabled={urlLoading}
                    className="px-2.5 py-1 bg-primary text-on-primary font-headline text-[10px] font-bold uppercase hover:bg-primary-dim transition-colors disabled:opacity-40 shrink-0"
                  >
                    {urlLoading ? "..." : "Go"}
                  </button>
                </div>
                {urlError && <p className="text-[10px] text-error">{urlError}</p>}

                {/* Row 3: File upload + PGN/FEN toggle */}
                <div className="flex gap-1">
                  <input type="file" accept=".pgn,.txt" ref={fileInputRef} onChange={handleFileUpload} className="hidden" />
                  <button onClick={() => fileInputRef.current?.click()}
                    className="flex-1 py-1.5 bg-surface-low border border-white/[0.06] font-headline text-[8px] font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-primary hover:border-primary/20 transition-colors">
                    Upload .pgn
                  </button>
                  <textarea
                    value={pgnInput}
                    onChange={(e) => setPgnInput(e.target.value)}
                    placeholder="Paste PGN or FEN..."
                    rows={1}
                    className="flex-[2] min-w-0 bg-surface-low border border-white/[0.06] px-2 py-1 text-[11px] font-mono text-on-surface placeholder:text-on-surface-variant/20 outline-none focus:border-primary/40 resize-none"
                    onFocus={(e) => { e.target.rows = 3; }}
                    onBlur={(e) => { if (!e.target.value) e.target.rows = 1; }}
                  />
                  <button
                    onClick={() => {
                      const v = pgnInput.trim();
                      if (!v) return;
                      if (v.includes("/") && !v.includes("[")) loadGame("", v);
                      else loadGame(v);
                    }}
                    className="px-2.5 py-1 bg-primary text-on-primary font-headline text-[10px] font-bold uppercase hover:bg-primary-dim transition-colors shrink-0"
                  >
                    Load
                  </button>
                </div>

                {/* Imported games list */}
                {importedGames.length > 0 && (
                  <div className="border-t border-white/[0.04] pt-1.5">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/55">
                        {importedGames.length} Games
                      </span>
                      <button onClick={() => { setImportedGames([]); setImportTruncated(false); }}
                        className="text-[10px] text-on-surface-variant/55 hover:text-error transition-colors">Clear</button>
                    </div>
                    {importTruncated && (
                      <p className="mb-1.5 text-[10px] text-amber-400/80 leading-relaxed">
                        Showing the most recent {MAX_IMPORT_GAMES.toLocaleString()} games. Older games were skipped to keep the tab responsive.
                      </p>
                    )}
                    <div className="max-h-[200px] overflow-y-auto space-y-px">
                      {importedGames.map((g, i) => (
                        <button key={g.id || i} onClick={() => { loadGame(g.pgn); setImportedGames([]); }}
                          className="w-full text-left px-2 py-1.5 bg-surface-low/60 border border-white/[0.03] hover:bg-surface-high/40 hover:border-primary/15 transition-colors">
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[11px] font-mono text-on-surface-variant/70 truncate">
                              {g.white} <span className="text-on-surface-variant/25">vs</span> {g.black}
                            </span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {g.opening && <span className="text-[9px] text-on-surface-variant/25 truncate max-w-[100px] hidden sm:inline">{g.opening}</span>}
                              <span className={`text-[10px] font-mono font-bold ${
                                g.result === "1-0" ? "text-on-surface-variant/60" : g.result === "0-1" ? "text-on-surface-variant/40" : "text-on-surface-variant/30"
                              }`}>{g.result}</span>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
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
                {movePairs.map((m, i) => {
                  const byPly = analysisCacheRef.current.byPly;
                  const wPrev = byPly[m.wPly - 1]?.whiteRel || null;
                  const wCur = byPly[m.wPly]?.whiteRel || null;
                  const bPrev = byPly[m.bPly - 1]?.whiteRel || null;
                  const bCur = byPly[m.bPly]?.whiteRel || null;
                  const wAnnot = (wPrev && wCur) ? classifyMove(wPrev, wCur, "w") : null;
                  const bAnnot = (m.black && bPrev && bCur) ? classifyMove(bPrev, bCur, "b") : null;
                  return (
                    <div key={m.num} className={`grid text-[12px] ${i % 2 === 0 ? "bg-surface-lowest/40" : ""}`} style={{ gridTemplateColumns: "1.8rem 1fr 1fr" }}>
                      <span className="text-[10px] text-on-surface-variant/20 self-center px-1 py-1.5">{m.num}.</span>
                      <button
                        onClick={() => goToPly(m.wPly)}
                        data-active={currentPly === m.wPly ? "" : undefined}
                        className={`text-left font-mono py-1.5 px-1 transition-colors hover:bg-primary/10 ${
                          currentPly === m.wPly ? "bg-primary/15 text-primary font-bold" : "text-on-surface-variant/70"
                        }`}>{m.white?.san}{wAnnot && <span className="ml-0.5" style={{ color: wAnnot.bg }} title={wAnnot.label}>{wAnnot.glyph}</span>}</button>
                      {m.black ? (
                        <button
                          onClick={() => goToPly(m.bPly)}
                          data-active={currentPly === m.bPly ? "" : undefined}
                          className={`text-left font-mono py-1.5 px-1 transition-colors hover:bg-primary/10 ${
                            currentPly === m.bPly ? "bg-primary/15 text-primary font-bold" : "text-on-surface-variant/50"
                          }`}>{m.black.san}{bAnnot && <span className="ml-0.5" style={{ color: bAnnot.bg }} title={bAnnot.label}>{bAnnot.glyph}</span>}</button>
                      ) : <span />}
                    </div>
                  );
                })}
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
            <div className="flex gap-1.5 flex-wrap">
              <button onClick={() => { loadGame(""); }}
                className="flex-1 py-2.5 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-primary transition-colors active:scale-[0.96]">
                New
              </button>
              <button onClick={() => {
                  const params = new URLSearchParams();
                  params.set("id", analysisIdRef.current || Date.now().toString(36));
                  if (gameHeaders?.White) params.set("w", gameHeaders.White);
                  if (gameHeaders?.Black) params.set("b", gameHeaders.Black);
                  if (startFen !== START_FEN) params.set("fen", startFen);
                  if (history.length > 0) {
                    const moves = history.map((m) => m.from + m.to + (m.promotion || "")).join(",");
                    params.set("moves", moves);
                  }
                  if (currentPly !== history.length) params.set("ply", String(currentPly));
                  const shareUrl = `${window.location.origin}/analysis${params.toString() ? "?" + params.toString() : ""}`;
                  navigator.clipboard.writeText(shareUrl).then(() => { setShareCopied(true); setTimeout(() => setShareCopied(false), 1500); });
                }}
                className="flex-1 py-2.5 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-primary transition-colors active:scale-[0.96]">
                {shareCopied ? "Copied!" : "Share"}
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

            {/* Saved boards - always render so the empty state is
                visible (and the user discovers the Save action). */}
            <div className="bg-surface-container border border-white/[0.04]">
              <div className="p-2.5 border-b border-white/[0.03] flex items-center justify-between">
                <span className="text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/55">
                  Saved ({savedBoards.length}/{MAX_SAVED})
                </span>
              </div>
              {savedBoards.length > 0 ? (
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
                        <span className="text-[9px] text-on-surface-variant/55">
                          {new Date(b.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </span>
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteSavedBoard(b.id); }}
                        className="shrink-0 p-1 text-on-surface-variant/40 hover:text-error transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        title="Delete saved board"
                        aria-label={`Delete saved board ${b.name}`}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-2.5 py-3 text-[10px] text-on-surface-variant/55 leading-relaxed">
                  Save up to {MAX_SAVED} positions here. They survive page refreshes and let you jump back into the same line later.
                </p>
              )}
            </div>

          </div>
        </div>
      </div>

      {/* Hints - between main content and friends panel */}
      <div className="hidden xl:flex flex-col gap-2 w-48 shrink-0 py-4 pr-2">
        <div className="p-4 bg-surface-container border border-white/[0.04] rounded">
          <p className="text-[13px] text-on-surface-variant/55 leading-relaxed">
            <span className="text-on-surface-variant/70 font-bold text-sm">Shortcuts</span><br />
            Arrow keys navigate.<br />
            Home/End jump to start/end.<br />
            F flips the board.<br />
            Delete removes last move.<br />
            Right-click highlights squares.<br />
            Right-drag draws arrows.<br />
            Save up to {MAX_SAVED} boards.
          </p>
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

