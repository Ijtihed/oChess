import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { BOT_CONFIG } from "../lib/bot-engine";
import { getSavedGame, clearSavedGame } from "./GameScreen";
import { useAuth } from "./AuthProvider";
import { isOnline, supabase } from "../lib/supabase";
import { createSeek, cancelSeek, findMatch, claimSeekRPC, getActiveGame, cancelAllMySeeks } from "../lib/online-game";
import { getRatings } from "../lib/auth";
import { categoryFromTimeControl } from "../lib/glicko2";
import SocialPanel from "./SocialPanel";
import { makeLogger } from "../lib/log";

const BOTS = BOT_CONFIG.map((b) => ({
  name: b.name,
  level: b.level,
  desc: b.desc,
  rating: b.level === 0 ? "?" : [0, 400, 800, 1200, 1600, 2000, 2400, 3200][b.level],
}));

const PRESETS = [
  { label: "1+0",   cat: "Bullet",    m: 1,  s: 0 },
  { label: "3+0",   cat: "Blitz",     m: 3,  s: 0 },
  { label: "3+2",   cat: "Blitz",     m: 3,  s: 2 },
  { label: "5+0",   cat: "Blitz",     m: 5,  s: 0 },
  { label: "5+3",   cat: "Blitz",     m: 5,  s: 3 },
  { label: "10+0",  cat: "Rapid",     m: 10, s: 0 },
  { label: "10+5",  cat: "Rapid",     m: 10, s: 5 },
  { label: "15+10", cat: "Rapid",     m: 15, s: 10 },
  { label: "30+0",  cat: "Classical", m: 30, s: 0 },
  { label: "∞",     cat: "Unlimited", m: 0,  s: 0 },
];


export default function PlayPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialTab = location.state?.tab || "humans";
  const [tab, setTab] = useState(initialTab);
  const [botIdx, setBotIdx] = useState(3);
  const [color, setColor] = useState("random");
  const [mode, setMode] = useState("rated");
  const [botTimeIdx, setBotTimeIdx] = useState(PRESETS.length - 1);

  useEffect(() => {
    if (location.state?.tab) setTab(location.state.tab);
  }, [location.state]);

  const [savedGame, setSavedGame] = useState(getSavedGame);

  const bot = BOTS[botIdx];

  const resumeGame = () => {
    navigate("/game", { state: { resume: true } });
  };

  const abandonGame = () => {
    clearSavedGame();
    setSavedGame(null);
  };

  const startBotGame = () => {
    const playerColor = color === "random" ? (Math.random() > 0.5 ? "w" : "b") : color;
    const preset = PRESETS[botTimeIdx];
    const tc = preset.m === 0 ? null : { initial: preset.m * 60000, increment: preset.s * 1000 };
    navigate("/game", {
      state: {
        opponent: { name: bot.name, rating: bot.rating, level: bot.level },
        playerColor,
        timeControl: tc,
      },
    });
  };

  return (
    <div className="flex">
      <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
      <div className="anim-fade-up mb-6" style={{ "--delay": "0.05s" }}>
        <h1 className="font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-1">Play</h1>
      </div>

      {/* Resume game banner */}
      {savedGame && (
        <div className="anim-fade-up mb-6 p-4 bg-surface-container border border-primary/20 flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4" style={{ "--delay": "0.06s" }}>
          <div className="flex-1 min-w-0">
            <span className="font-headline text-sm font-bold text-primary block">Game in progress</span>
            <span className="text-[11px] text-on-surface-variant/50">
              vs {savedGame.opponent?.name} &middot; {savedGame.playerColor === "w" ? "White" : "Black"} &middot; {savedGame.pgn ? Math.ceil(savedGame.pgn.split(/\d+\./).filter(Boolean).length) : 0} moves
            </span>
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={resumeGame} className="btn btn-primary py-2.5 px-5 text-xs">
              Resume
            </button>
            <button onClick={abandonGame} className="btn btn-secondary py-2.5 px-5 text-xs hover:!text-error hover:!border-error/20">
              Abandon
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="anim-fade-up flex gap-1 mb-6" style={{ "--delay": "0.08s" }}>
        {[{ id: "humans", label: "vs Humans" }, { id: "bots", label: "vs Bots" }].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-5 py-2.5 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${tab === t.id ? "bg-primary text-on-primary" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ═══ vs Bots ═══ */}
      {tab === "bots" && (
        <div className="anim-fade-up" style={{ "--delay": "0.1s" }}>
          <div className="flex flex-col xl:flex-row gap-6 xl:gap-10">
            <div className="flex-1 space-y-6">
              {/* Bot selector */}
              <div>
                <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Choose opponent</h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {BOTS.map((b, i) => (
                    <button key={b.name} onClick={() => setBotIdx(i)}
                      className={`flex flex-col items-center py-4 px-3 transition-all duration-150 active:scale-[0.96] ${botIdx === i ? "bg-primary text-on-primary" : "bg-surface-low border border-white/[0.04] hover:bg-surface-high"}`}>
                      <span className="font-headline text-lg font-extrabold tabular-nums">{b.rating}</span>
                      <span className={`text-[10px] uppercase tracking-wide mt-0.5 ${botIdx === i ? "text-on-primary/60" : "text-on-surface-variant/35"}`}>{b.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Color */}
              <div>
                <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Play as</h2>
                <div className="flex gap-2">
                  {[{ id: "random", label: "Random" }, { id: "w", label: "White" }, { id: "b", label: "Black" }].map((c) => (
                    <button key={c.id} onClick={() => setColor(c.id)}
                      className={`flex-1 py-3 font-headline text-sm font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${color === c.id ? "bg-primary text-on-primary" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary"}`}>
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Time control */}
              <div>
                <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Time control</h2>
                <div className="grid grid-cols-5 gap-1.5">
                  {PRESETS.map((p, i) => (
                    <button key={p.label} onClick={() => setBotTimeIdx(i)}
                      className={`flex flex-col items-center justify-center py-3 transition-all duration-150 active:scale-[0.95] ${botTimeIdx === i ? "bg-primary text-on-primary" : "bg-surface-low border border-white/[0.04] hover:bg-surface-high"}`}>
                      <span className="font-headline text-sm font-extrabold">{p.label}</span>
                      <span className={`text-[9px] uppercase tracking-wide mt-0.5 ${botTimeIdx === i ? "text-on-primary/60" : "text-on-surface-variant/30"}`}>{p.cat}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Start button */}
              <button onClick={startBotGame}
                className="btn btn-primary w-full py-4 text-sm">
                Play vs {bot.name}
              </button>

              <p className="text-[10px] text-on-surface-variant/20 px-1">
                {bot.level <= 3 ? "Uses js-chess-engine" : `Stockfish 18 WASM · ELO ${BOT_CONFIG[botIdx].sfElo || "Max"}`} · {PRESETS[botTimeIdx].label === "∞" ? "Unlimited time" : PRESETS[botTimeIdx].label}
              </p>
            </div>

            {/* Right: bot info */}
            <div className="w-full xl:w-[280px] shrink-0">
              <div className="sticky top-20 space-y-4">
                <div className="p-5 bg-surface-container border border-white/[0.04]">
                  <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Selected</h3>
                  <div className="space-y-3">
                    <div>
                      <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25 block">Opponent</span>
                      <span className="font-headline text-lg font-extrabold text-primary">{bot.name}</span>
                      <span className="text-xs text-on-surface-variant/30 ml-2">{bot.rating}</span>
                    </div>
                    <div>
                      <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25 block">Color</span>
                      <span className="font-headline text-sm font-bold text-on-surface-variant/60 capitalize">{color === "w" ? "White" : color === "b" ? "Black" : "Random"}</span>
                    </div>
                    <div>
                      <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25 block">Clock</span>
                      <span className="font-headline text-sm font-bold text-on-surface-variant/60">{PRESETS[botTimeIdx].label === "∞" ? "Unlimited" : `${PRESETS[botTimeIdx].label} ${PRESETS[botTimeIdx].cat}`}</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-on-surface-variant/55 mt-4 leading-relaxed">{bot.desc}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ vs Humans ═══ */}
      {tab === "humans" && (
        <OnlineMatchmaking navigate={navigate} mode={mode} setMode={setMode} />
      )}
      </div>
      <SocialPanel />
    </div>
  );
}

const { log: plog, error: perr } = makeLogger("play");

function OnlineMatchmaking({ navigate, mode, setMode }) {
  const { user, profile } = useAuth();
  const [seeking, setSeeking] = useState(false);
  const [seekId, setSeekId] = useState(null);
  const [seekTC, setSeekTC] = useState(null);
  const [openSeeks, setOpenSeeks] = useState([]);
  const [myRating, setMyRating] = useState(1500);
  const [activeGame, setActiveGame] = useState(null);
  const pollRef = useRef(null);
  const seekIdRef = useRef(null);
  seekIdRef.current = seekId;

  const isLoggedIn = !!user && isOnline();

  // Check for active online game + clean stale seeks on mount.
  // Re-runs when the tab regains focus so finishing a game in another
  // tab clears the "Game in progress" banner here without a refresh.
  useEffect(() => {
    if (!isLoggedIn) return;
    let cancelled = false;
    const refreshActive = () => {
      plog("refreshActive: checking active game, user:", user.id);
      getActiveGame(user.id).then((game) => {
        if (cancelled) return;
        plog("active game check:", game ? game.id : "none");
        setActiveGame(game || null);
      });
    };
    refreshActive();
    // Clean up any ghost seeks left by a previous crashed session.
    // Skipped if we're currently seeking (e.g. user opened a 2nd tab).
    if (!seeking) {
      cancelAllMySeeks(user.id).then(() => plog("stale seeks cleaned up")).catch(() => {});
    }
    const onFocus = () => refreshActive();
    const onVis = () => { if (!document.hidden) refreshActive(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, isLoggedIn]);

  // Load my rating for the display label
  useEffect(() => {
    if (!isLoggedIn) return;
    getRatings(user.id).catch(() => []).then((ratings) => {
      const blitz = ratings?.find((r) => r.category === "blitz");
      if (blitz) { plog("my blitz rating:", Math.round(blitz.rating)); setMyRating(Math.round(blitz.rating)); }
    });
  }, [user?.id, isLoggedIn]);

  const [seeksLoadError, setSeeksLoadError] = useState(null);

  // Load open seeks - initial fetch + Realtime subscription for instant updates
  useEffect(() => {
    if (!isLoggedIn || !supabase) return;

    const loadSeeks = () => {
      plog("loadSeeks: fetching...");
      supabase
        .from("seeks")
        .select("*")
        .neq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(20)
        .then(({ data, error }) => {
          if (error) {
            perr("loadSeeks error:", error.message, error.details, error.hint);
            setSeeksLoadError("Couldn't load open games - check your connection.");
            return;
          }
          plog("loadSeeks:", data?.length || 0, "seeks found", data?.map(s => ({ id: s.id, user: s.username, tc: s.time_control })));
          setSeeksLoadError(null);
          if (data) setOpenSeeks(data);
        })
        .catch((e) => {
          perr("loadSeeks exception:", e);
          setSeeksLoadError("Couldn't load open games - check your connection.");
        });
    };

    loadSeeks();

    // Realtime: re-fetch whenever seeks table changes (INSERT/DELETE)
    const channel = supabase
      .channel("seeks-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "seeks" }, (payload) => {
        plog("seeks realtime event:", payload.eventType, payload.new?.id || payload.old?.id);
        loadSeeks();
      })
      .subscribe((status) => { plog("seeks subscription status:", status); });

    return () => { supabase.removeChannel(channel); };
  }, [user?.id, isLoggedIn]);

  const [seekError, setSeekError] = useState(null);
  const gameSubRef = useRef(null);
  const seekingRef = useRef(false);
  seekingRef.current = seeking;

  // Tear down any background seek work (poll, INSERT subscription).
  // Called from both successful-claim paths and from cancel/unmount.
  const stopSeekWatchers = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (gameSubRef.current && supabase) { supabase.removeChannel(gameSubRef.current); gameSubRef.current = null; }
  }, []);

  const startSeeking = useCallback(async (tc) => {
    if (!isLoggedIn || !supabase) { plog("startSeeking blocked: not logged in or no supabase"); return; }
    if (seekingRef.current) { plog("startSeeking blocked: already seeking"); return; }
    if (activeGame) { plog("startSeeking blocked: active game exists"); setSeekError("You have an active game. Resume or resign it first."); return; }
    plog("startSeeking:", tc);
    setSeeking(true);
    seekingRef.current = true;
    setSeekTC(tc);
    setSeekError(null);
    try {
      const category = categoryFromTimeControl(tc);
      const ratings = await getRatings(user.id).catch(() => []);
      const r = ratings?.find((x) => x.category === category);
      const rating = r ? Math.round(r.rating) : 1500;
      setMyRating(rating);
      const myName = profile?.display_name || profile?.username || "Player";
      plog("seeking as:", myName, "rating:", rating, "category:", category);

      // Clean up any stale seeks this user might have left behind
      await cancelAllMySeeks(user.id);

      // Try to claim an existing seek first. We pass `isRated` so the
      // matchmaker only pairs us with a seek of the same flavour -
      // rated-with-rated, casual-with-casual.
      const match = await findMatch(user.id, rating, { timeControl: tc, isRated: mode === "rated" });
      if (match) {
        plog("found matching seek:", match.id, "by", match.username);
        try {
          const game = await claimSeekRPC(match.id, user.id, myName, rating);
          plog("claimed seek, navigating to game:", game.id);
          stopSeekWatchers();
          setSeeking(false);
          seekingRef.current = false;
          navigate(`/game/online/${game.id}`, { state: { gameData: game } });
          return;
        } catch (e) { plog("claim failed (seek may be taken):", e.message); }
      }

      // No match found - post our own seek (only one at a time)
      plog("no match found, creating seek...");
      const seek = await createSeek(user.id, myName, rating, {
        timeControl: tc, category, isRated: mode === "rated",
      });
      plog("seek created:", seek.id, "- waiting for opponent to claim it");
      setSeekId(seek.id);

      // Subscribe to games table - fires when opponent claims our seek
      if (gameSubRef.current) { supabase.removeChannel(gameSubRef.current); gameSubRef.current = null; }
      const gameCh = supabase
        .channel("my-game-created")
        .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "games" },
          (payload) => {
            const g = payload.new;
            plog("games INSERT received:", g?.id, "white:", g?.white_id, "black:", g?.black_id);
            if (g && (g.white_id === user.id || g.black_id === user.id) && g.status === "active") {
              plog("game created for us! navigating:", g.id);
              stopSeekWatchers();
              setSeeking(false);
              seekingRef.current = false;
              navigate(`/game/online/${g.id}`, { state: { gameData: g } });
            }
          }
        )
        .subscribe((status) => { plog("games INSERT subscription status:", status); });
      gameSubRef.current = gameCh;

      // Fallback poll in case realtime hiccups
      pollRef.current = setInterval(async () => {
        plog("fallback poll: checking for active game...");
        try {
          const game = await getActiveGame(user.id);
          if (game) {
            plog("fallback poll found game:", game.id);
            stopSeekWatchers();
            setSeeking(false);
            seekingRef.current = false;
            navigate(`/game/online/${game.id}`, { state: { gameData: game } });
          }
        } catch {}
      }, 5000);
    } catch (err) {
      perr("startSeeking error:", err);
      setSeeking(false);
      seekingRef.current = false;
      setSeekError(err.message || "Failed to find match");
    }
  }, [isLoggedIn, user, profile, mode, navigate, activeGame, stopSeekWatchers]);

  const stopSeeking = useCallback(async () => {
    stopSeekWatchers();
    // Cancel via specific ID (fast) and also clean up any strays
    if (seekIdRef.current) cancelSeek(seekIdRef.current).catch(() => {});
    if (user?.id) cancelAllMySeeks(user.id).catch(() => {});
    setSeeking(false);
    seekingRef.current = false;
    setSeekId(null);
    setSeekTC(null);
  }, [user?.id, stopSeekWatchers]);

  // Cleanup on unmount / tab close
  useEffect(() => {
    const cleanup = () => {
      stopSeekWatchers();
      if (seekIdRef.current) cancelSeek(seekIdRef.current).catch(() => {});
    };
    window.addEventListener("beforeunload", cleanup);
    return () => {
      window.removeEventListener("beforeunload", cleanup);
      cleanup();
    };
  }, [stopSeekWatchers]);

  const [claiming, setClaiming] = useState(false);

  const acceptSeek = useCallback(async (seek) => {
    plog("acceptSeek:", seek.id, "by", seek.username);
    if (!isLoggedIn || claiming) { plog("acceptSeek blocked:", !isLoggedIn ? "not logged in" : "already claiming"); return; }
    if (activeGame) { plog("acceptSeek blocked: active game exists"); setSeekError("You have an active game. Resume or resign it first."); return; }
    setSeekError(null);
    setClaiming(true);
    try {
      await cancelAllMySeeks(user.id);

      const myName = profile?.display_name || profile?.username || "Player";
      const category = categoryFromTimeControl(seek.time_control);
      const ratings = await getRatings(user.id).catch(() => []);
      const r = ratings?.find((x) => x.category === category);
      const rating = r ? Math.round(r.rating) : 1500;
      plog("claiming seek as:", myName, "rating:", rating);
      const game = await claimSeekRPC(seek.id, user.id, myName, rating);
      plog("acceptSeek OK, navigating to game:", game.id);
      navigate(`/game/online/${game.id}`, { state: { gameData: game } });
    } catch (err) {
      perr("acceptSeek error:", err);
      setClaiming(false);
      setSeekError(err.message || "Game no longer available");
    }
  }, [isLoggedIn, user, profile, navigate, activeGame, claiming]);

  return (
    <div className="anim-fade-up flex flex-col xl:flex-row gap-6 xl:gap-10" style={{ "--delay": "0.1s" }}>
      <div className="flex-1 space-y-6">
        {!isLoggedIn && (
          <div className="p-4 bg-amber-500/10 border border-amber-500/20 text-[12px] text-amber-400">
            Sign in to play online. You can still play against bots in the Bots tab.
          </div>
        )}

        {activeGame && (
          <div className="p-4 bg-primary/10 border border-primary/20 flex items-center justify-between mb-2">
            <div>
              <span className="font-headline text-sm font-bold text-primary block">Game in progress</span>
              <span className="text-[11px] text-on-surface-variant/50">
                {activeGame.white_name || "?"} vs {activeGame.black_name || "?"} · {activeGame.time_control || "Unlimited"} · {activeGame.moves_count || 0} moves
              </span>
            </div>
            <div className="flex gap-2">
              <button onClick={() => navigate(`/game/online/${activeGame.id}`)}
                className="px-4 py-2 bg-primary text-on-primary font-headline text-xs font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.96]">
                Resume
              </button>
            </div>
          </div>
        )}

        {/* Challenge link */}
        {isLoggedIn && (
          <div className="mb-4">
            <button onClick={() => navigate("/create-challenge")}
              className="w-full py-3 bg-surface-low border border-primary/15 hover:border-primary/30 hover:bg-surface-high/40 font-headline text-[12px] font-bold uppercase tracking-wide text-primary transition-colors active:scale-[0.97]">
              Create Game Link · Challenge a Friend
            </button>
          </div>
        )}

        {seekError && (
          <div className="p-3 bg-error/10 border border-error/20 text-[12px] text-error mb-4">{seekError}</div>
        )}

        <div>
          <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Quick match</h2>
          <div className="flex gap-1.5 mb-3">
            {["rated", "casual"].map((m) => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-4 py-2 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${mode === m ? "bg-primary text-on-primary" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary"}`}>
                {m}
              </button>
            ))}
          </div>

          {seeking ? (
            <div className="p-6 bg-surface-low border border-primary/20 text-center">
              <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin mx-auto mb-3" />
              <p className="text-[13px] text-primary font-bold mb-1">Searching for opponent...</p>
              <p className="text-[11px] text-on-surface-variant/40 mb-3">{seekTC} · {mode} · ~{myRating}</p>
              <button onClick={stopSeeking} className="px-5 py-2 bg-surface-high border border-white/[0.06] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/50 hover:text-error transition-colors">
                Cancel
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
              {PRESETS.map((p) => (
                <button key={p.label} onClick={() => isLoggedIn && startSeeking(p.label)}
                  disabled={!isLoggedIn}
                  className={`flex flex-col items-center justify-center py-3.5 border transition-all duration-150 active:scale-[0.95] ${
                    isLoggedIn ? "bg-surface-low border-white/[0.04] hover:bg-surface-high hover:border-primary/15" : "bg-surface-low/50 border-white/[0.03] opacity-40"
                  }`}>
                  <span className="font-headline text-sm sm:text-base font-extrabold text-primary">{p.label}</span>
                  <span className="text-[9px] text-on-surface-variant/30 uppercase tracking-wide mt-0.5">{p.cat}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Open seeks */}
      <div className="w-full xl:w-[320px] shrink-0">
        <div className="sticky top-20">
          <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/55 mb-3">
            Open Games {openSeeks.length > 0 && `(${openSeeks.length})`}
          </h2>
          {seeksLoadError ? (
            <div className="p-4 bg-error/10 border border-error/20 text-[12px] text-error">
              {seeksLoadError}
            </div>
          ) : openSeeks.length > 0 ? (
            <div className="space-y-1 max-h-[400px] overflow-y-auto">
              {openSeeks.map((s) => (
                <button key={s.id} onClick={() => acceptSeek(s)}
                  disabled={!isLoggedIn || seeking || claiming}
                  className="w-full text-left px-3 py-2.5 bg-surface-low border border-white/[0.04] hover:bg-surface-high hover:border-primary/15 transition-colors disabled:opacity-40 disabled:pointer-events-none flex items-center justify-between group">
                  <div>
                    <span className="text-[12px] font-bold text-on-surface-variant/70 group-hover:text-primary transition-colors block">{s.username}</span>
                    <span className="text-[10px] text-on-surface-variant/30">{s.time_control} · {s.is_rated ? "rated" : "casual"}</span>
                  </div>
                  <span className="text-[12px] font-mono font-bold text-primary tabular-nums">{Math.round(s.rating)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="p-6 text-center bg-surface-low border border-white/[0.04]">
              <span className="text-[11px] text-on-surface-variant/55">No open games</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
