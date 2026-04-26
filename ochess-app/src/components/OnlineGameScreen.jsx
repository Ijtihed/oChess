import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Chess } from "chess.js";
import InteractiveBoard from "./InteractiveBoard";
import SocialPanel from "./SocialPanel";
import { useAuth } from "./AuthProvider";
import { joinGameChannel, completeGame, saveGameStateToDB, createRematchGame, subscribeToGameRow } from "../lib/online-game";
import { getOpeningName, resetOpeningCache } from "../lib/openings";
import useClock, { formatTime } from "../hooks/useClock";
import { playMoveSound, playGameStart, playVictory, playDefeat, playDraw, playLowTime, preloadAll } from "../lib/sounds";
import { supabase } from "../lib/supabase";

const STARTING = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const PIECE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const PIECE_ORDER = ["q", "r", "b", "n", "p"];

const BAD_WORDS = new Set(["fuck","shit","bitch","nigger","nigga","faggot","retard","cunt","dick","pussy","asshole","bastard","whore","slut","cock","kys","kill yourself","stfu"]);
function moderateChat(text) {
  const lower = text.toLowerCase();
  for (const w of BAD_WORDS) { if (lower.includes(w)) return null; }
  return text.slice(0, 200);
}

/**
 * Apply server-stored time-control state to the live clock.
 *
 * The active side has the wall-clock time since `last_move_at`
 * subtracted from it, but the deduction is capped at 5 minutes so a
 * tab that was closed for hours (or a row with an old / missing
 * `last_move_at` we somehow didn't notice) cannot land on the page
 * with a clock already at 0 and immediately fire a bogus timeout.
 *
 * Returns `{ white, black, activeSide }` for the caller to feed into
 * useClock.restore + useClock.start.
 */
export function reconcileClockState({ whiteMs, blackMs, lastMoveAt, turn, fallbackTurn, now = Date.now(), maxElapsedMs = 5 * 60 * 1000 }) {
  const activeSide = turn || fallbackTurn || "w";
  let white = Number.isFinite(whiteMs) ? whiteMs : 0;
  let black = Number.isFinite(blackMs) ? blackMs : 0;
  if (lastMoveAt) {
    const t = new Date(lastMoveAt).getTime();
    if (Number.isFinite(t)) {
      const raw = now - t;
      const elapsed = Math.max(0, Math.min(raw, maxElapsedMs));
      if (activeSide === "w") white = Math.max(0, white - elapsed);
      else black = Math.max(0, black - elapsed);
    }
  }
  return { white, black, activeSide };
}

/**
 * Normalize a stored chat row into the in-memory shape used by the UI.
 *
 * Older rows persisted opponent messages as `{from: "opp"}` because
 * the receiver didn't store the sender's user_id. New rows store the
 * actual user_id (or `null` if it couldn't be determined). Either
 * shape round-trips to a stable `fromId` that equals one of the two
 * participants — so `fromId === authUserId` is the only thing the
 * renderer needs to ask.
 */
export function normalizeChat(stored, opponentId, myId) {
  let fromId = stored.from;
  if (fromId === "opp" || fromId === "them") fromId = opponentId || null;
  if (fromId === "you") fromId = myId || null;
  return {
    fromId,
    text: stored.text,
    name: stored.name || (fromId === myId ? "You" : "Opponent"),
  };
}

/**
 * Map a chess result + the local player's color to a UI outcome.
 *
 * Decisive games (`1-0`, `0-1`) map to `won: true` for the winning
 * color and `won: false` for the losing color. Both draws and
 * aborts/unfinished (`*`) intentionally return `won: null` so the UI
 * shows "Draw" / "Game ended" instead of mislabeling an abort as a
 * loss.
 */
export function computeGameOver(result, playerColor, reason) {
  let won = null;
  if (result === "1-0") won = playerColor === "w";
  else if (result === "0-1") won = playerColor === "b";
  return { result, reason, won };
}

function getCaptured(fen) {
  const board = fen.split(" ")[0];
  const w = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  const b = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  for (const ch of board) {
    if (ch >= "A" && ch <= "Z") { const k = ch.toLowerCase(); if (k in w) w[k]++; }
    else if (ch >= "a" && ch <= "z") { if (ch in b) b[ch]++; }
  }
  const capturedByWhite = [], capturedByBlack = [];
  let whiteMat = 0, blackMat = 0;
  for (const p of PIECE_ORDER) {
    whiteMat += w[p] * PIECE_VAL[p]; blackMat += b[p] * PIECE_VAL[p];
    for (let i = 0; i < STARTING[p] - b[p]; i++) capturedByWhite.push(p);
    for (let i = 0; i < STARTING[p] - w[p]; i++) capturedByBlack.push(p);
  }
  return { capturedByWhite, capturedByBlack, advantage: whiteMat - blackMat };
}

export default function OnlineGameScreen({ gameData, playerColor }) {
  const navigate = useNavigate();
  const { user: authUser, profile } = useAuth();
  const gameRef = useRef(new Chess());
  const channelRef = useRef(null);
  const authUserIdRef = useRef(authUser?.id);
  authUserIdRef.current = authUser?.id;
  const gameDataRef = useRef(gameData);
  gameDataRef.current = gameData;
  const premoveRef = useRef(null);
  const gameOverRef = useRef(null);
  const lowTimeFiredRef = useRef(false);
  const moveListRef = useRef(null);
  const chatRef = useRef(null);

  const [fen, setFen] = useState(gameRef.current.fen());
  const [history, setHistory] = useState([]);
  const [gameOver, setGameOver] = useState(null);
  const [lastMove, setLastMove] = useState(null);
  const [premove, setPremove] = useState(null);
  const [previewPly, setPreviewPly] = useState(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [confirmDraw, setConfirmDraw] = useState(false);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [confirmRematch, setConfirmRematch] = useState(false);
  const [drawIncoming, setDrawIncoming] = useState(false);
  const [myDrawOffers, setMyDrawOffers] = useState(0);
  const MAX_DRAW_OFFERS = 3;
  const [connected, setConnected] = useState(false);
  const [connectionDegraded, setConnectionDegraded] = useState(false);
  const [opponentOnline, setOpponentOnline] = useState(false);
  const [pgnCopied, setPgnCopied] = useState(false);
  const [dbError, setDbError] = useState(null);
  const [openingName, setOpeningName] = useState(null);
  const [opponentProfile, setOpponentProfile] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [rematchOffered, setRematchOffered] = useState(false);
  const [rematchIncoming, setRematchIncoming] = useState(false);

  const tc = gameData.time_control?.match(/^(\d+)\+(\d+)$/);
  const baseMs = tc ? parseInt(tc[1]) * 60000 : 0;
  const incMs = tc ? parseInt(tc[2]) * 1000 : 0;
  const hasTime = baseMs > 0;
  const clock = useClock(baseMs, incMs);

  const myName = profile?.display_name || profile?.username || authUser?.email?.split("@")[0] || "You";
  const opponentId = playerColor === "w" ? gameData.black_id : gameData.white_id;
  const opponentNameRaw = playerColor === "w" ? gameData.black_name : gameData.white_name;
  const opponentName = opponentProfile?.display_name || opponentProfile?.username || opponentNameRaw || "Opponent";
  const opponentAvatar = opponentProfile?.avatar_url || null;
  const opponentRating = Math.round((playerColor === "w" ? gameData.black_rating : gameData.white_rating) || 1500);
  const myRating = Math.round((playerColor === "w" ? gameData.white_rating : gameData.black_rating) || 1500);
  const opponentColor = playerColor === "w" ? "b" : "w";
  const tcLabel = gameData.time_control || "Unlimited";

  const [myProfile, setMyProfile] = useState(profile);
  const myAvatar = myProfile?.avatar_url || profile?.avatar_url || authUser?.user_metadata?.avatar_url || null;
  const myDisplayName = myProfile?.display_name || myProfile?.username || myName;

  useEffect(() => {
    if (!supabase) return;
    const fetchProfile = async (id) => {
      try {
        const { data } = await supabase.from("profiles").select("*").eq("id", id).maybeSingle();
        return data || null;
      } catch { return null; }
    };
    if (opponentId) fetchProfile(opponentId).then((p) => { if (p) setOpponentProfile(p); });
    if (authUser?.id) fetchProfile(authUser.id).then((p) => { if (p) setMyProfile(p); });
  }, [opponentId, authUser?.id]);

  // Stable ref so saveGameState doesn't recreate every clock tick
  const clockRef = useRef(clock);
  clockRef.current = clock;

  const saveGameState = useCallback((extraFields = {}) => {
    if (!gameDataRef.current?.id) return;
    saveGameStateToDB(gameDataRef.current.id, {
      pgn: gameRef.current.pgn(),
      moves_count: gameRef.current.history().length,
      turn: gameRef.current.turn(),
      last_move_at: new Date().toISOString(),
      white_time_ms: clockRef.current.display.white,
      black_time_ms: clockRef.current.display.black,
      ...extraFields,
    });
  }, []);

  const endGame = useCallback(async (result, reason) => {
    if (gameOverRef.current) return;
    const go = computeGameOver(result, playerColor, reason);
    setGameOver(go); gameOverRef.current = go; clock.stop();
    // Premove can never execute now; clear it so the banner disappears.
    setPremove(null); premoveRef.current = null;
    if (go.won === true) playVictory(); else if (go.won === false) playDefeat(); else playDraw();
    try {
      const pgn = gameRef.current.pgn();
      const res = await completeGame(gameDataRef.current.id, pgn, result, reason, gameRef.current.history().length);
      if (!res.ok) setDbError("Game ended but failed to save to server");
    } catch { setDbError("Game ended but failed to save"); }
  }, [playerColor, clock]);

  const checkEnd = useCallback(() => {
    const g = gameRef.current;
    if (g.isCheckmate()) { endGame(g.turn() === "w" ? "0-1" : "1-0", "checkmate"); return true; }
    if (g.isStalemate()) { endGame("1/2-1/2", "stalemate"); return true; }
    if (g.isDraw()) { endGame("1/2-1/2", "draw"); return true; }
    return false;
  }, [endGame]);

  const executePremove = useCallback(() => {
    const pm = premoveRef.current;
    if (!pm) return;
    setPremove(null); premoveRef.current = null;
    const g = gameRef.current;
    if (g.isGameOver() || g.turn() !== playerColor) return;
    try {
      const result = g.move(pm);
      if (!result) return;
      playMoveSound(result);
      setLastMove({ from: result.from, to: result.to });
      setFen(g.fen());
      setHistory([...g.history({ verbose: true })]);
      if (hasTime) clock.switchSide();
      saveGameState();
      channelRef.current?.sendMove({ from: result.from, to: result.to, promotion: result.promotion || undefined });
      checkEnd();
    } catch {}
  }, [playerColor, saveGameState, clock, hasTime, checkEnd]);

  // Opening name
  useEffect(() => {
    resetOpeningCache();
    if (history.length > 0 && history.length <= 30) {
      getOpeningName(history).then((name) => { if (name) setOpeningName(name); });
    }
  }, [history.length]);

  // Confirmation dismiss on outside click
  useEffect(() => {
    if (!confirmResign && !confirmDraw && !confirmAbort && !confirmRematch) return;
    const handler = (e) => {
      const btn = e.target.closest("[data-confirm-resign], [data-confirm-draw], [data-confirm-abort], [data-confirm-rematch]");
      if (!btn) { setConfirmResign(false); setConfirmDraw(false); setConfirmAbort(false); setConfirmRematch(false); }
    };
    window.addEventListener("pointerdown", handler, true);
    return () => window.removeEventListener("pointerdown", handler, true);
  }, [confirmResign, confirmDraw, confirmAbort, confirmRematch]);

  // ── Main connection + game lifecycle ──
  //
  // Architecture:
  //   DB row (games table) = single source of truth
  //   Postgres Changes sub = how clients receive authoritative updates (the "feed")
  //   Broadcast channel    = speed optimization (instant, but not authoritative)
  //   Presence             = online indicators only
  //
  // Move flow:
  //   1. Player validates move locally (chess.js)
  //   2. Writes new PGN + clocks to DB (authoritative write)
  //   3. Broadcasts move via channel (fast hint for opponent)
  //   4. Opponent receives broadcast → applies optimistically
  //   5. Opponent receives DB change → confirms/corrects state
  //   6. If broadcast missed, DB change still delivers the move

  useEffect(() => {
    preloadAll(); playGameStart();

    // ── Hydrate from the game row we already have ──
    if (gameData.pgn?.trim()) {
      try {
        gameRef.current.loadPgn(gameData.pgn);
        const h = gameRef.current.history({ verbose: true });
        if (h.length > 0) { setHistory(h); setFen(gameRef.current.fen()); setLastMove({ from: h[h.length - 1].from, to: h[h.length - 1].to }); }
      } catch {}
    }
    if (hasTime && gameData.white_time_ms != null && gameData.black_time_ms != null) {
      const { white: wTime, black: bTime } = reconcileClockState({
        whiteMs: gameData.white_time_ms,
        blackMs: gameData.black_time_ms,
        lastMoveAt: gameData.last_move_at,
        turn: gameData.turn,
        fallbackTurn: gameRef.current.turn(),
      });
      clock.restore(wTime, bTime);
    }
    if (gameData.chat && Array.isArray(gameData.chat) && gameData.chat.length > 0) {
      setChatMessages(gameData.chat.map((m) => normalizeChat(m, opponentId, authUser?.id)));
    }

    const validPlayers = new Set([gameData.white_id, gameData.black_id].filter(Boolean));

    // ── Sync local state from an authoritative DB row ──
    const applyServerRow = (row) => {
      if (!row) return;
      if (gameOverRef.current) return;

      // Game completed on the server (by us or opponent)
      if (row.status === "completed") { endGame(row.result || "*", row.result_reason || "game ended"); return; }

      const localMoves = gameRef.current.history().length;
      const serverMoves = row.moves_count || 0;
      const movesAdvanced = row.pgn?.trim() && serverMoves > localMoves;

      // Sync moves if server is ahead of us
      if (movesAdvanced) {
        const g = new Chess();
        try { g.loadPgn(row.pgn); } catch { return; }
        gameRef.current = g;
        const h = g.history({ verbose: true });
        setHistory(h);
        setFen(g.fen());
        if (h.length > 0) {
          const last = h[h.length - 1];
          setLastMove({ from: last.from, to: last.to });
          playMoveSound(last);
        }
        if (premoveRef.current) setTimeout(() => executePremove(), 80);
      }

      // Sync clocks from server — only when a move actually advanced.
      // Replaying restore() on every chat / draw / rematch update jitters
      // the local ticker against the elapsed time we re-derive here.
      if (movesAdvanced && hasTime && row.white_time_ms != null && row.black_time_ms != null && row.last_move_at) {
        const { white: wTime, black: bTime, activeSide } = reconcileClockState({
          whiteMs: row.white_time_ms,
          blackMs: row.black_time_ms,
          lastMoveAt: row.last_move_at,
          turn: row.turn,
          fallbackTurn: gameRef.current.turn(),
        });
        clock.restore(wTime, bTime);
        clock.start(activeSide);
      }

      // Sync chat
      if (row.chat && Array.isArray(row.chat) && row.chat.length > 0) {
        const restored = row.chat.map((m) => normalizeChat(m, opponentId, authUserIdRef.current));
        setChatMessages((prev) => prev.length > restored.length ? prev : restored);
      }

      // Sync draw offers
      const myDrawField = playerColor === "w" ? row.white_draw_offers : row.black_draw_offers;
      if (myDrawField != null) setMyDrawOffers(myDrawField);

      // Sync rematch state. When the DB clears rematch_offered_by (cancel /
      // decline), drop both local flags so the prompt disappears.
      if (row.rematch_game_id) { navigate(`/game/online/${row.rematch_game_id}`); return; }
      if (!row.rematch_offered_by) {
        setRematchIncoming(false);
        setRematchOffered(false);
      } else if (row.rematch_offered_by !== authUserIdRef.current) {
        setRematchIncoming(true);
        setRematchOffered(false);
      } else {
        setRematchOffered(true);
        setRematchIncoming(false);
      }
    };

    // Verify a broadcast termination claim against the DB before
    // ending the game locally. The Realtime broadcast layer uses the
    // anon key and is *not* sender-authenticated; treating it as
    // authoritative would let any anon client forge resign / draw /
    // game_over events for a participant uuid. We re-read the row;
    // if the DB really shows status='completed', applyServerRow does
    // the right thing. Otherwise we ignore the forged claim.
    const verifyTermination = (expectedReason) => {
      if (gameOverRef.current || !supabase) return;
      supabase.from("games").select("*").eq("id", gameData.id).maybeSingle()
        .then(({ data }) => {
          if (!data || gameOverRef.current) return;
          if (data.status === "completed") applyServerRow(data);
          // Soft retry once after 1.5s for the case where the actual
          // resigner's DB write has not landed yet — the row will
          // flip to completed within glicko2_update's transaction.
          else setTimeout(() => {
            if (gameOverRef.current) return;
            supabase.from("games").select("*").eq("id", gameData.id).maybeSingle()
              .then(({ data: data2 }) => {
                if (data2?.status === "completed" && !gameOverRef.current) applyServerRow(data2);
              })
              .catch(() => {});
          }, 1500);
        })
        .catch(() => {});
    };

    // ── Subscribe to the game row in the DB (the authoritative feed) ──
    const dbSub = subscribeToGameRow(gameData.id, applyServerRow);

    // ── Broadcast channel (speed layer + presence) ──
    const ch = joinGameChannel(gameData.id, {
      userId: authUser?.id,
      // Broadcast move = optimistic fast path.  DB subscription confirms.
      onMove: (move) => {
        if (gameOverRef.current) return;
        try {
          const result = gameRef.current.move(move);
          if (result) {
            playMoveSound(result);
            setLastMove({ from: result.from, to: result.to });
            setFen(gameRef.current.fen());
            setHistory([...gameRef.current.history({ verbose: true })]);
            if (hasTime) clock.switchSide();
            if (!checkEnd() && premoveRef.current) setTimeout(() => executePremove(), 80);
          }
          // If move fails locally, do nothing — the DB subscription will correct us
        } catch {}
      },
      onResign: ({ userId }) => {
        if (!validPlayers.has(userId) || userId === authUserIdRef.current) return;
        // Broadcast is a fast hint, not authority. Verify against the
        // DB row before terminating — a malicious actor with the
        // anon key could otherwise forge resign payloads.
        verifyTermination("resignation");
      },
      onDrawOffer: ({ userId }) => {
        if (!validPlayers.has(userId) || userId === authUserIdRef.current) return;
        setDrawIncoming(true);
      },
      onDrawAccept: ({ userId }) => {
        if (!validPlayers.has(userId)) return;
        // Same: only terminate after the DB confirms status='completed'.
        verifyTermination("draw by agreement");
      },
      onDrawDecline: ({ userId }) => {
        // Broadcast self:false hides this from the decliner, so we
        // are the offerer. Refund the increment we charged on offer
        // and persist the corrected count back to the DB so a
        // refresh doesn't re-debit the player.
        if (userId && !validPlayers.has(userId)) return;
        setMyDrawOffers((c) => {
          const next = Math.max(0, c - 1);
          const field = playerColor === "w" ? "white_draw_offers" : "black_draw_offers";
          saveGameState({ [field]: next });
          return next;
        });
        setConfirmDraw(false);
      },
      onGameOver: (data) => {
        if (data?.userId && !validPlayers.has(data.userId)) return;
        // Same DB-first guard as the other terminal events. The
        // sender hasn't necessarily written the games row yet (e.g.
        // the 30s auto-abort path) — verify on the DB and let
        // applyServerRow finalize if the status really is completed.
        verifyTermination(data?.reason || "game ended");
      },
      onChat: ({ userId, text, name }) => {
        if (!validPlayers.has(userId)) return;
        const fromMe = userId === authUserIdRef.current;
        setChatMessages((prev) => [...prev.slice(-50), { fromId: userId, text, name: name || (fromMe ? "You" : "Opponent") }]);
        setTimeout(() => chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" }), 50);
      },
      onRematchOffer: ({ userId }) => {
        if (!validPlayers.has(userId) || userId === authUserIdRef.current) return;
        setRematchIncoming(true);
      },
      onRematchAccept: (newGameData) => {
        if (newGameData?.id) navigate(`/game/online/${newGameData.id}`);
      },
      onRematchDecline: () => { setRematchOffered(false); },
      onConnected: () => {
        setConnected(true);
        setConnectionDegraded(false);
        // On first connect, do one manual read to catch up
        if (supabase) {
          supabase.from("games").select("*").eq("id", gameData.id).maybeSingle()
            .then(({ data }) => { if (data) applyServerRow(data); });
        }
        if (hasTime && gameData.white_time_ms == null) {
          saveGameState({ white_time_ms: baseMs, black_time_ms: baseMs, turn: "w", last_move_at: new Date().toISOString() });
        }
      },
      onPresenceSync: (state) => {
        const users = new Set();
        for (const key of Object.keys(state)) {
          const presences = state[key];
          if (Array.isArray(presences)) presences.forEach((p) => { if (p.user_id) users.add(p.user_id); });
        }
        setOpponentOnline(users.has(opponentId));
      },
    });

    channelRef.current = ch;
    if (hasTime) clock.start(gameRef.current.turn());

    // Auto-abort if no moves are played within 30s of the game's
    // creation. Both sides run the timer, anchored to created_at so a
    // refresh by either player does NOT reset the window. Skipped if
    // this client joins an in-progress game, or if the row predates
    // the created_at column (no anchor → don't fire client-side; the
    // host that originally created the game still aborts on its own
    // server-stamped 30s window).
    let abortTimer = null;
    if (gameRef.current.history().length === 0 && gameData.created_at) {
      const startedAt = new Date(gameData.created_at).getTime();
      if (Number.isFinite(startedAt)) {
        const elapsed = Date.now() - startedAt;
        if (elapsed < 30000) {
          const remaining = 30000 - elapsed;
          abortTimer = setTimeout(() => {
            if (gameRef.current.history().length === 0 && !gameOverRef.current) {
              ch?.sendGameOver({ result: "*", reason: "aborted — no moves in 30s", userId: authUserIdRef.current });
              endGame("*", "aborted — no moves in 30s");
            }
          }, remaining);
        }
        // If we're already past the 30s window without moves, don't
        // fire instantly — the originating host has already aborted
        // (or is about to) and we'll learn about it via the DB sync.
      }
    }

    // If the realtime channel never reaches SUBSCRIBED within 8s,
    // surface a banner so the user knows something is off — moves
    // still go through the DB write path so the game continues, but
    // they won't see opponent moves until the page reconciles.
    const degradeTimer = setTimeout(() => {
      if (!gameOverRef.current) setConnectionDegraded((prev) => prev || !connected);
    }, 8000);

    return () => {
      ch?.leave();
      dbSub?.unsubscribe();
      if (abortTimer) clearTimeout(abortTimer);
      clearTimeout(degradeTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Handlers ──

  const handleMove = useCallback((move) => {
    if (gameOver) return false;
    if (previewPly) { setPreviewPly(null); setFen(gameRef.current.fen()); return false; }
    const g = gameRef.current;
    if (g.turn() !== playerColor) {
      setPremove(move); premoveRef.current = move;
      return false;
    }
    setPremove(null); premoveRef.current = null;
    try {
      const result = g.move(move);
      if (!result) return false;
      playMoveSound(result);
      setLastMove({ from: result.from, to: result.to });
      setFen(g.fen());
      setHistory([...g.history({ verbose: true })]);
      if (hasTime) clock.switchSide();
      // 1. Write to DB (authoritative — opponent's subscription will fire)
      saveGameState();
      // 2. Broadcast for instant delivery (speed hint)
      channelRef.current?.sendMove({ from: result.from, to: result.to, promotion: result.promotion || undefined });
      checkEnd();
      return true;
    } catch { return false; }
  }, [gameOver, playerColor, saveGameState, clock, hasTime, checkEnd, previewPly]);

  const handleResign = useCallback(() => {
    if (!confirmResign) { setConfirmResign(true); return; }
    channelRef.current?.sendResign(authUserIdRef.current);
    endGame(playerColor === "w" ? "0-1" : "1-0", "resignation");
    setConfirmResign(false);
  }, [playerColor, endGame, confirmResign]);

  const handleDrawOffer = useCallback(() => {
    if (myDrawOffers >= MAX_DRAW_OFFERS) return;
    if (!confirmDraw) { setConfirmDraw(true); return; }
    channelRef.current?.sendDrawOffer(authUserIdRef.current);
    const newCount = myDrawOffers + 1;
    setMyDrawOffers(newCount);
    setConfirmDraw(false);
    const field = playerColor === "w" ? "white_draw_offers" : "black_draw_offers";
    saveGameState({ [field]: newCount });
  }, [confirmDraw, myDrawOffers, playerColor, saveGameState]);

  const handleDrawAccept = useCallback(() => {
    channelRef.current?.sendDrawAccept(authUserIdRef.current);
    endGame("1/2-1/2", "draw by agreement");
    setDrawIncoming(false);
  }, [endGame]);

  const handleDrawDecline = useCallback(() => {
    channelRef.current?.sendDrawDecline(authUserIdRef.current);
    setDrawIncoming(false);
  }, []);

  const handleAbort = useCallback(async () => {
    if (!confirmAbort) { setConfirmAbort(true); return; }
    channelRef.current?.sendGameOver({ result: "*", reason: "aborted", userId: authUserIdRef.current });
    setConfirmAbort(false);
    await endGame("*", "aborted");
  }, [endGame, confirmAbort]);

  const handleRematchOffer = useCallback(async () => {
    if (!confirmRematch) { setConfirmRematch(true); return; }
    setConfirmRematch(false);
    setRematchOffered(true);
    saveGameState({ rematch_offered_by: authUserIdRef.current });
    channelRef.current?.sendRematchOffer(authUserIdRef.current);
  }, [confirmRematch, saveGameState]);

  const handleRematchCancel = useCallback(() => {
    setRematchOffered(false);
    saveGameState({ rematch_offered_by: null });
  }, [saveGameState]);

  const rematchAcceptingRef = useRef(false);
  const handleRematchAccept = useCallback(async () => {
    if (rematchAcceptingRef.current) return;
    rematchAcceptingRef.current = true;
    try {
      // The RPC handles the race: if the opponent already accepted,
      // we get back the same rematch row instead of creating a new one.
      const newGame = await createRematchGame(gameData.id, authUserIdRef.current);
      if (!newGame) return;
      channelRef.current?.sendRematchAccept(newGame);
      navigate(`/game/online/${newGame.id}`);
    } finally {
      rematchAcceptingRef.current = false;
    }
  }, [gameData, navigate]);

  const handleRematchDecline = useCallback(() => {
    channelRef.current?.sendRematchDecline(authUserIdRef.current);
    setRematchIncoming(false);
    saveGameState({ rematch_offered_by: null });
  }, [saveGameState]);

  const handleSendChat = useCallback(() => {
    const text = moderateChat(chatInput.trim());
    if (!text) { setChatInput(""); return; }
    channelRef.current?.sendChat(authUserIdRef.current, text, myDisplayName);
    const newMsg = { fromId: authUserIdRef.current, text, name: myDisplayName };
    setChatMessages((prev) => {
      const updated = [...prev.slice(-50), newMsg];
      // Persist with stable user ids so a hard-refresh by either
      // player rehydrates each message under the correct sender.
      saveGameState({ chat: updated.map((m) => ({ from: m.fromId, text: m.text, name: m.name })) });
      return updated;
    });
    setChatInput("");
    setTimeout(() => chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" }), 50);
  }, [chatInput, myDisplayName, saveGameState]);

  // Move preview (arrow key navigation)
  const handlePreviewMove = useCallback((ply) => {
    if (previewPly === ply || ply === history.length) { setPreviewPly(null); setFen(gameRef.current.fen()); return; }
    setPreviewPly(ply);
    const temp = new Chess();
    for (let i = 0; i < ply && i < history.length; i++) temp.move(history[i].san);
    setFen(temp.fen());
  }, [history, previewPly]);

  const handleBackToLive = useCallback(() => {
    setPreviewPly(null);
    setFen(gameRef.current.fen());
  }, []);

  // Arrow key navigation
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const total = history.length;
      if (!total) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const cur = previewPly ?? total;
        if (cur > 1) handlePreviewMove(cur - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const cur = previewPly ?? total;
        if (cur < total) handlePreviewMove(cur + 1);
        else handleBackToLive();
      } else if (e.key === "Home") {
        e.preventDefault();
        handlePreviewMove(1);
      } else if (e.key === "End") {
        e.preventDefault();
        handleBackToLive();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [history.length, previewPly, handlePreviewMove, handleBackToLive]);

  // Low time warning
  useEffect(() => {
    if (!hasTime || gameOver) return;
    const playerMs = playerColor === "w" ? clock.display.white : clock.display.black;
    if (playerMs <= 30000 && !lowTimeFiredRef.current) { lowTimeFiredRef.current = true; playLowTime(); }
  }, [clock.display, hasTime, gameOver, playerColor]);

  // Timeout detection
  useEffect(() => {
    if (!hasTime || gameOver) return;
    if (clock.timedOut) {
      const result = clock.timedOut === "w" ? "0-1" : "1-0";
      channelRef.current?.sendGameOver({ result, reason: "timeout", userId: authUserIdRef.current });
      endGame(result, "timeout");
    }
  }, [clock.timedOut, hasTime, gameOver, endGame]);

  // Auto-scroll move list
  useEffect(() => {
    if (moveListRef.current) {
      if (gameOver) moveListRef.current.scrollTop = moveListRef.current.scrollHeight;
      else moveListRef.current.scrollTop = 0;
    }
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [history.length, gameOver]);

  // ── Computed values ──

  const highlightSquares = useMemo(() => {
    const sq = {};
    const activePly = previewPly;
    if (activePly && history[activePly - 1]) {
      const m = history[activePly - 1];
      sq[m.from] = { backgroundColor: "rgba(59,130,246,0.2)" };
      sq[m.to] = { backgroundColor: "rgba(59,130,246,0.3)" };
    } else if (lastMove) {
      sq[lastMove.from] = { backgroundColor: "rgba(255,255,255,0.07)" };
      sq[lastMove.to] = { backgroundColor: "rgba(255,255,255,0.11)" };
    }
    return sq;
  }, [previewPly, history, lastMove]);

  const isPreviewingPast = previewPly !== null;

  const captured = useMemo(() => getCaptured(fen), [fen]);
  const advForPlayer = playerColor === "w" ? captured.advantage : -captured.advantage;
  const playerCaptured = playerColor === "w" ? captured.capturedByWhite : captured.capturedByBlack;
  const opponentCaptured = playerColor === "w" ? captured.capturedByBlack : captured.capturedByWhite;

  const pgn = useMemo(() => {
    const g = new Chess();
    for (const m of history) g.move(m.san);
    const result = gameOver?.result || "*";
    g.header("Event", "oChess Online", "White", gameData.white_name || "?", "Black", gameData.black_name || "?", "Result", result);
    return g.pgn();
  }, [history, gameOver, gameData]);

  const opponentTime = playerColor === "w" ? clock.display.black : clock.display.white;
  const playerTime = playerColor === "w" ? clock.display.white : clock.display.black;
  const isPlayerTurn = !gameOver && gameRef.current.turn() === playerColor;

  const turnLabel = gameOver
    ? (gameOver.won === true ? "You win" : gameOver.won === false ? "You lost" : "Draw")
    : isPlayerTurn ? "Your turn" : "Waiting...";

  const movePairs = [];
  for (let i = 0; i < history.length; i += 2) {
    movePairs.push({ num: Math.floor(i / 2) + 1, white: history[i], black: history[i + 1] || null });
  }

  return (
    <div className="min-h-screen min-h-[100dvh] bg-surface flex flex-col">
      {/* ── Top bar ── */}
      <div className="w-full bg-surface-lowest/80 backdrop-blur-xl border-b border-white/[0.04] px-4 sm:px-6 h-12 flex items-center justify-between shrink-0 z-10">
        <button onClick={() => navigate("/")} className="flex items-center gap-2 text-on-surface-variant/50 hover:text-primary transition-colors py-2 pr-3">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
          <span className="font-headline text-lg font-extrabold tracking-tighter text-primary">oChess</span>
        </button>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/30">
            vs {opponentName} · {tcLabel}
          </span>
          {!connected && !connectionDegraded && <div className="w-2.5 h-2.5 border border-primary/30 border-t-primary rounded-full animate-spin" aria-label="Connecting" />}
          {connectionDegraded && !connected && (
            <span title="Realtime is unreachable. Your moves still reach the server, but updates may be delayed."
              className="text-[10px] font-headline font-bold uppercase tracking-wide px-2 py-0.5 bg-amber-500/15 text-amber-400">
              Reconnecting
            </span>
          )}
          <span className={`text-[10px] font-headline font-bold uppercase tracking-wide px-2 py-0.5 ${
            gameOver
              ? gameOver.won ? "bg-emerald-500/15 text-emerald-400" : gameOver.won === false ? "bg-error/15 text-error" : "bg-surface-high text-on-surface-variant/50"
              : isPlayerTurn ? "bg-primary/10 text-primary" : "bg-surface-high text-on-surface-variant/40"
          }`}>{turnLabel}</span>
        </div>
      </div>

      {/* ── Main body: game + social ── */}
      <div className="flex-1 flex">
      <div className="flex-1 min-w-0 flex flex-col xl:flex-row px-4 sm:px-8 xl:pl-16 xl:pr-6 py-3 sm:py-4 gap-4 xl:gap-6">
        {/* Board column */}
        <div className="flex-1 flex flex-col items-center xl:items-start max-w-[720px]">
          {/* Opponent bar */}
          <PlayerBar
            name={opponentName}
            rating={opponentRating}
            avatar={opponentAvatar}
            captured={opponentCaptured}
            advantage={advForPlayer < 0 ? Math.abs(advForPlayer) : 0}
            pieceColor={opponentColor}
            time={hasTime ? opponentTime : null}
            active={!gameOver && gameRef.current.turn() === opponentColor}
            online={opponentOnline}
          />

          <div className="w-full">
            <InteractiveBoard
              fen={fen}
              onMove={handleMove}
              orientation={playerColor === "w" ? "white" : "black"}
              interactive={!gameOver && !isPreviewingPast}
              highlightSquares={highlightSquares}
              premoveSquares={premove}
              playerColor={playerColor}
              onBoardClick={() => { if (premove) { setPremove(null); premoveRef.current = null; } }}
            />
          </div>

          {premove && !gameOver && (
            <div className="w-full mt-1 flex items-center justify-between px-2 py-1.5 bg-blue-900/20 border border-blue-500/15">
              <span className="text-[10px] font-headline font-bold uppercase tracking-wide text-blue-400/70">Premove: {premove.from}{premove.to}</span>
              <button onClick={() => { setPremove(null); premoveRef.current = null; }} className="text-[10px] text-blue-400/50 hover:text-blue-300 transition-colors">Cancel</button>
            </div>
          )}

          {isPreviewingPast && !gameOver && (
            <button onClick={handleBackToLive} className="w-full mt-1 py-2 bg-blue-900/30 border border-blue-500/20 font-headline text-xs font-bold uppercase tracking-wide text-blue-400/80 hover:bg-blue-900/50 transition-colors active:scale-[0.97]">
              Back to live position
            </button>
          )}

          {/* Player bar */}
          <PlayerBar
            name={myDisplayName}
            rating={myRating}
            avatar={myAvatar}
            captured={playerCaptured}
            advantage={advForPlayer > 0 ? advForPlayer : 0}
            pieceColor={playerColor}
            time={hasTime ? playerTime : null}
            active={isPlayerTurn}
            isPlayer
          />
        </div>

        {/* ── Sidebar (live play) ── */}
        {!gameOver && (
          <div className="w-full xl:w-[340px] shrink-0 flex flex-col gap-3">
            {/* Controls */}
            <div className="flex gap-2 shrink-0 flex-wrap">
              {history.length <= 2 ? (
                <button data-confirm-abort onClick={handleAbort}
                  className={`flex-1 py-2.5 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${confirmAbort ? "bg-error/20 text-error border border-error/20" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/35 hover:text-on-surface-variant/60"}`}>
                  Abort
                </button>
              ) : (
                <>
                  <button data-confirm-draw onClick={handleDrawOffer} disabled={myDrawOffers >= MAX_DRAW_OFFERS}
                    className={`py-2.5 px-3 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${
                      myDrawOffers >= MAX_DRAW_OFFERS ? "bg-surface-low/50 border border-white/[0.02] text-on-surface-variant/15"
                      : confirmDraw ? "bg-amber-500/20 text-amber-400 border border-amber-500/20"
                      : "bg-surface-low border border-white/[0.04] text-on-surface-variant/35 hover:text-amber-400 hover:border-amber-500/15"
                    }`}>
                    {myDrawOffers >= MAX_DRAW_OFFERS ? "No draws left" : `Draw${myDrawOffers > 0 ? ` (${MAX_DRAW_OFFERS - myDrawOffers})` : ""}`}
                  </button>
                  <button data-confirm-resign onClick={handleResign}
                    className={`flex-1 py-2.5 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${confirmResign ? "bg-error/20 text-error border border-error/20" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/35 hover:text-error hover:border-error/15"}`}>
                    Resign
                  </button>
                </>
              )}
              <button onClick={() => navigate("/play")} className="py-2.5 px-3 bg-surface-low border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/35 hover:text-primary transition-colors active:scale-[0.96]">Menu</button>
            </div>

            {drawIncoming && (
              <div className="bg-primary/10 border border-primary/20 p-3">
                <span className="text-[12px] text-primary font-bold block mb-2">Opponent offers a draw</span>
                <div className="flex gap-2">
                  <button onClick={handleDrawAccept} className="flex-1 py-2 bg-primary text-on-primary font-headline text-[10px] font-bold uppercase">Accept</button>
                  <button onClick={handleDrawDecline} className="flex-1 py-2 bg-surface-low text-on-surface-variant/50 font-headline text-[10px] font-bold uppercase">Decline</button>
                </div>
              </div>
            )}

            {/* Chat */}
            <div className="bg-surface-container border border-white/[0.04] shrink-0">
              <div className="p-2 border-b border-white/[0.03]">
                <h2 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">Chat</h2>
              </div>
              <div ref={chatRef} className="max-h-[140px] overflow-y-auto p-2.5 space-y-1.5">
                {chatMessages.length === 0 && <p className="text-[11px] text-on-surface-variant/20 italic">Say hello...</p>}
                {chatMessages.map((msg, i) => {
                  const isMe = msg.fromId === authUser?.id;
                  return (
                    <p key={i} className={`text-[11px] leading-relaxed break-words ${isMe ? "text-primary/70" : "text-on-surface-variant/60"}`}>
                      <span className="font-bold text-[10px]">{isMe ? myDisplayName : opponentName}: </span>
                      {msg.text}
                    </p>
                  );
                })}
              </div>
              <div className="flex border-t border-white/[0.03]">
                <input value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && chatInput.trim()) handleSendChat(); }}
                  placeholder="Type a message..."
                  maxLength={200}
                  className="flex-1 bg-transparent px-2.5 py-2 text-[11px] text-on-surface placeholder:text-on-surface-variant/20 outline-none" />
                <button onClick={handleSendChat} disabled={!chatInput.trim()}
                  className="px-3 text-[10px] font-bold text-primary/50 hover:text-primary transition-colors disabled:opacity-30">Send</button>
              </div>
            </div>

            {/* Opening */}
            <div className="bg-surface-container border border-white/[0.04] px-3 py-2 shrink-0">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/30 mr-2">Opening</span>
                  <span className="text-[12px] font-headline font-semibold text-on-surface-variant/70">{openingName || "\u2026"}</span>
                </div>
                {openingName && (
                  <div className="flex gap-2 shrink-0 ml-2">
                    <a href={`https://en.wikipedia.org/wiki/${encodeURIComponent(openingName.replace(/:.*/, "").trim())}`} target="_blank" rel="noopener noreferrer" className="text-[9px] text-on-surface-variant/30 hover:text-primary transition-colors">Wiki</a>
                    <a href={`https://lichess.org/opening/${encodeURIComponent(openingName.replace(/:.*/, "").trim())}`} target="_blank" rel="noopener noreferrer" className="text-[9px] text-on-surface-variant/30 hover:text-primary transition-colors">Lichess</a>
                  </div>
                )}
              </div>
            </div>

            {/* Move list (live — reversed, newest on top) */}
            <div className="bg-surface-low flex flex-col flex-1 min-h-0">
              <div className="p-3 flex justify-between items-center border-b border-white/[0.03] shrink-0">
                <h2 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">Moves</h2>
                <span className="text-[10px] text-on-surface-variant/20 tabular-nums">{history.length}</span>
              </div>
              <div ref={moveListRef} className="flex-1 overflow-y-auto max-h-[320px] xl:max-h-none">
                {movePairs.length === 0 && (
                  <div className="p-4 text-center text-[11px] text-on-surface-variant/20">{isPlayerTurn ? "Your move" : "Waiting..."}</div>
                )}
                {[...movePairs].reverse().map((m, ri) => {
                  const origIdx = movePairs.length - 1 - ri;
                  const wPly = origIdx * 2 + 1;
                  const bPly = origIdx * 2 + 2;
                  const isActive = (ply) => previewPly === ply;
                  return (
                    <div key={m.num} className={`grid text-[13px] ${ri % 2 === 0 ? "bg-surface-lowest/40" : ""}`} style={{ gridTemplateColumns: "1.8rem 1fr 1fr" }}>
                      <span className="text-[10px] text-on-surface-variant/20 self-center px-1 py-1.5">{m.num}.</span>
                      <button onClick={() => handlePreviewMove(wPly)} className={`font-mono text-left py-1.5 px-1 transition-colors hover:bg-primary/10 ${isActive(wPly) ? "bg-primary/15 text-primary font-bold" : "text-on-surface-variant/70"}`}>
                        {m.white?.san}
                      </button>
                      {m.black ? (
                        <button onClick={() => handlePreviewMove(bPly)} className={`font-mono text-left py-1.5 px-1 transition-colors hover:bg-primary/10 ${isActive(bPly) ? "bg-primary/15 text-primary font-bold" : "text-on-surface-variant/45"}`}>
                          {m.black.san}
                        </button>
                      ) : <span />}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── Post-game sidebar ── */}
        {gameOver && (
          <div className="w-full xl:w-[340px] shrink-0 flex flex-col gap-3">
            {/* Result panel */}
            <div className="anim-fade-up p-4 bg-surface-container border border-white/[0.06]">
              <span className="font-headline text-2xl font-extrabold text-primary block mb-0.5">
                {gameOver.won === true ? "You win!" : gameOver.won === false ? "You lost" : "Draw"}
              </span>
              <span className="text-[11px] text-on-surface-variant/40 capitalize block mb-3">{gameOver.reason}</span>
              {dbError && <p className="text-[10px] text-amber-400 mb-2">{dbError}</p>}
              <div className="flex gap-2">
                <button onClick={() => navigate("/play")} className="btn btn-primary flex-1 py-2 text-[10px]">
                  New Game
                </button>
                <button onClick={() => navigate("/analysis", { state: { pgn, orientation: playerColor === "w" ? "white" : "black" } })}
                  className="btn btn-secondary flex-1 py-2 text-[10px]">
                  Analyze
                </button>
              </div>
              <div className="flex gap-2 mt-2">
                <button onClick={() => { navigator.clipboard.writeText(pgn); setPgnCopied(true); setTimeout(() => setPgnCopied(false), 2000); }}
                  className={`btn flex-1 py-2 text-[10px] ${
                    pgnCopied ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/20" : "btn-secondary"
                  }`}>
                  {pgnCopied ? "Copied!" : "Copy PGN"}
                </button>
                <button onClick={() => {
                  const blob = new Blob([pgn], { type: "application/x-chess-pgn" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a"); a.href = url; a.download = "game.pgn"; a.click();
                  URL.revokeObjectURL(url);
                }}
                  className="btn btn-secondary flex-1 py-2 text-[10px]">
                  Download PGN
                </button>
              </div>

              {/* Rematch */}
              {rematchIncoming ? (
                <div className="bg-primary/10 border border-primary/20 p-3 mt-3">
                  <span className="text-[12px] text-primary font-bold block mb-2">{opponentName} wants a rematch!</span>
                  <div className="flex gap-2">
                    <button onClick={handleRematchAccept} className="flex-1 py-2 bg-primary text-on-primary font-headline text-[10px] font-bold uppercase">Accept</button>
                    <button onClick={handleRematchDecline} className="flex-1 py-2 bg-surface-low text-on-surface-variant/50 font-headline text-[10px] font-bold uppercase">Decline</button>
                  </div>
                </div>
              ) : rematchOffered ? (
                <div className="mt-3 flex gap-2">
                  <div className="flex-1 py-2.5 bg-surface-low border border-white/[0.04] text-center">
                    <span className="text-[11px] text-on-surface-variant/30">Rematch sent — waiting...</span>
                  </div>
                  <button onClick={handleRematchCancel}
                    className="py-2.5 px-3 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/30 hover:text-error transition-colors">Cancel</button>
                </div>
              ) : (
                <button data-confirm-rematch onClick={handleRematchOffer}
                  className={`w-full mt-3 py-2.5 font-headline text-[10px] font-bold uppercase tracking-wide transition-colors active:scale-[0.97] ${confirmRematch ? "bg-primary text-on-primary" : "bg-surface-low border border-primary/15 hover:border-primary/30 text-primary/70 hover:text-primary"}`}>
                  {confirmRematch ? "Confirm Rematch" : "Rematch"}
                </button>
              )}
            </div>

            {/* Opening */}
            {openingName && (
              <div className="bg-surface-container border border-white/[0.04] px-3 py-2">
                <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/30 mr-2">Opening</span>
                <span className="text-[12px] font-headline font-semibold text-on-surface-variant/70">{openingName}</span>
              </div>
            )}

            {/* Move list (post-game, chronological, clickable) */}
            <div className="bg-surface-low flex flex-col flex-1 min-h-0" style={{ maxHeight: "min(65vh, 580px)" }}>
              <div className="p-3 border-b border-white/[0.03] shrink-0">
                <h2 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">Moves</h2>
              </div>
              <div ref={moveListRef} className="overflow-y-auto flex-1">
                {movePairs.map((m, ri) => {
                  const wPly = ri * 2 + 1;
                  const bPly = ri * 2 + 2;
                  const isActive = (ply) => previewPly === ply;
                  return (
                    <div key={m.num} className={`grid text-[12px] ${ri % 2 === 0 ? "bg-surface-lowest/40" : ""}`} style={{ gridTemplateColumns: "1.6rem 1fr 1fr" }}>
                      <span className="text-[9px] text-on-surface-variant/20 self-center px-1 py-1">{m.num}.</span>
                      <button onClick={() => handlePreviewMove(wPly)} className={`font-mono text-left py-1 px-1 transition-colors hover:bg-primary/10 ${isActive(wPly) ? "bg-primary/15 text-primary font-bold" : "text-on-surface-variant/70"}`}>
                        {m.white?.san}
                      </button>
                      {m.black ? (
                        <button onClick={() => handlePreviewMove(bPly)} className={`font-mono text-left py-1 px-1 transition-colors hover:bg-primary/10 ${isActive(bPly) ? "bg-primary/15 text-primary font-bold" : "text-on-surface-variant/45"}`}>
                          {m.black.san}
                        </button>
                      ) : <span />}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
      <SocialPanel />
      </div>
    </div>
  );
}

function PlayerBar({ name, rating, avatar, captured = [], advantage = 0, pieceColor, time, active, isPlayer, online }) {
  return (
    <div className={`w-full flex items-center justify-between py-2 px-2 rounded ${isPlayer ? "mt-2 bg-surface-low/50" : "mb-2 bg-surface-low/50"}`}>
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 relative overflow-hidden ${
          isPlayer ? "bg-primary/25" : "bg-surface-high"
        }`}>
          {avatar ? (
            <img src={avatar} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <span className={`font-headline text-sm font-bold uppercase ${isPlayer ? "text-primary" : "text-on-surface-variant/70"}`}>
              {name[0]}
            </span>
          )}
          {online != null && (
            <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-surface ${online ? "bg-emerald-500" : "bg-on-surface-variant/20"}`} />
          )}
        </div>
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`font-headline text-sm font-bold truncate ${isPlayer ? "text-primary" : "text-on-surface-variant/80"}`}>
            {name}
          </span>
          {rating && <span className="text-xs text-on-surface-variant/35 tabular-nums shrink-0">{rating}</span>}
        </div>
        {captured.length > 0 && (
          <div className="flex items-center gap-px ml-1 shrink-0">
            {captured.map((p, i) => {
              const capturedColor = pieceColor === "w" ? "b" : "w";
              const needsBrighten = capturedColor === "b";
              return (
                <img key={i} src={`/piece/cburnett/${capturedColor}${p.toUpperCase()}.svg`} alt={p} className="w-4 h-4"
                  style={needsBrighten ? { filter: "brightness(2.5) grayscale(0.6)", opacity: 0.7 } : { opacity: 0.6 }} draggable={false} />
              );
            })}
            {advantage > 0 && <span className="text-[10px] font-bold text-on-surface-variant/30 ml-1 tabular-nums">+{advantage}</span>}
          </div>
        )}
      </div>
      {time != null && <ClockDisplay time={time} active={active} />}
    </div>
  );
}

function ClockDisplay({ time, active }) {
  const low = time < 30000;
  const critical = time < 10000;
  return (
    <div className={`px-3 py-1 font-mono text-base font-bold tabular-nums transition-colors shrink-0 ${
      active
        ? critical ? "bg-error/20 text-error" : low ? "bg-primary/10 text-primary" : "bg-surface-high text-primary"
        : "bg-surface-low/80 text-on-surface-variant/35"
    }`}>
      {formatTime(time)}
    </div>
  );
}
