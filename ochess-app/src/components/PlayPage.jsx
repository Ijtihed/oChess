import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { BOT_CONFIG } from "../lib/bot-engine";
import { getSavedGame, clearSavedGame } from "./GameScreen";
import SocialPanel from "./SocialPanel";

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

const SAMPLE_FRIENDS = [
  { name: "KnightRider42", rating: 1580, online: true },
  { name: "DarkBishop",    rating: 1623, online: true },
  { name: "PawnStorm99",   rating: 1545, online: false },
  { name: "QueenGambit",   rating: 1601, online: true },
  { name: "EndgameWizard", rating: 1890, online: false },
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
            <button onClick={resumeGame} className="py-2.5 px-5 bg-primary text-on-primary font-headline text-xs font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.96]">
              Resume
            </button>
            <button onClick={abandonGame} className="py-2.5 px-5 bg-surface-low border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-error hover:border-error/20 transition-colors active:scale-[0.96]">
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
                className="w-full py-4 bg-primary text-on-primary font-headline text-sm font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.97]">
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
                  <p className="text-[10px] text-on-surface-variant/20 mt-4 leading-relaxed">{bot.desc}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ vs Humans ═══ */}
      {tab === "humans" && (
        <div className="anim-fade-up flex flex-col xl:flex-row gap-6 xl:gap-10" style={{ "--delay": "0.1s" }}>
          <div className="flex-1 space-y-6">
            {/* Quick match */}
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
              <div className="grid grid-cols-5 gap-1.5">
                {PRESETS.map((p) => (
                  <button key={p.label}
                    className="flex flex-col items-center justify-center py-3.5 bg-surface-low border border-white/[0.04] hover:bg-surface-high transition-all duration-150 active:scale-[0.95] opacity-60">
                    <span className="font-headline text-sm sm:text-base font-extrabold text-primary">{p.label}</span>
                    <span className="text-[9px] text-on-surface-variant/30 uppercase tracking-wide mt-0.5">{p.cat}</span>
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-on-surface-variant/20 mt-2 uppercase tracking-widest">
                Online matchmaking coming soon
              </p>
            </div>

            {/* Create game */}
            <div>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Create game</h2>
              <div className="w-full py-3.5 bg-surface-low/50 border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/20 flex items-center justify-center gap-2">
                Invite links coming soon
              </div>
            </div>

            {/* Challenge a friend */}
            <div>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Challenge a friend</h2>
              <div className="space-y-1 max-h-[240px] overflow-y-auto">
                {SAMPLE_FRIENDS.map((f) => (
                  <div key={f.name} className="flex items-center justify-between py-2.5 px-3 bg-surface-low/50 border border-white/[0.02]">
                    <div className="flex items-center gap-2.5">
                      <div className="relative">
                        <div className="w-7 h-7 rounded-full bg-surface-high flex items-center justify-center">
                          <span className="font-headline text-[9px] font-bold text-on-surface-variant/50 uppercase">{f.name[0]}</span>
                        </div>
                        {f.online && <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-surface" />}
                      </div>
                      <div>
                        <span className="font-headline text-xs font-bold text-on-surface-variant/70 block">{f.name}</span>
                        <span className="text-[10px] text-on-surface-variant/25 tabular-nums">{f.rating}</span>
                      </div>
                    </div>
                    <span className="text-[10px] font-headline font-bold uppercase tracking-wide text-on-surface-variant/20">Soon</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right: open games */}
          <div className="w-full xl:w-[320px] shrink-0">
            <div className="sticky top-20">
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Open games</h2>
              <div className="p-6 text-center bg-surface-low border border-white/[0.04]">
                <span className="text-[11px] text-on-surface-variant/20">No open games yet</span>
              </div>
              <p className="text-[10px] text-on-surface-variant/20 mt-3 leading-relaxed">
                Online play coming soon. Play bots for now.
              </p>
            </div>
          </div>
        </div>
      )}
      </div>
      <SocialPanel />
    </div>
  );
}
