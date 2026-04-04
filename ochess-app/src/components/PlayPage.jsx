import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";

const BOTS = [
  { name: "Random",      rating: "?",   level: 0 },
  { name: "Rookie",      rating: 400,   level: 1 },
  { name: "Patzer",      rating: 800,   level: 2 },
  { name: "Club",        rating: 1200,  level: 3 },
  { name: "Expert",      rating: 1600,  level: 4 },
  { name: "Master",      rating: 2000,  level: 5 },
  { name: "Grandmaster", rating: 2400,  level: 6 },
  { name: "Stockfish",   rating: 3200,  level: 7 },
];

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
  { name: "EndgameWizard",  rating: 1890, online: false },
];

const OPEN_GAMES = [
  { id: 1, player: "Anon_847",  rating: 1420, tc: "3+0",  cat: "Blitz", rated: true },
  { id: 2, player: "ChessFan",  rating: 1155, tc: "10+5", cat: "Rapid", rated: false },
  { id: 3, player: "KingSlayer", rating: 1780, tc: "5+3",  cat: "Blitz", rated: true },
];

function tcCategory(m, s) {
  const total = m * 60 + s * 40;
  if (total < 180) return "Bullet";
  if (total < 600) return "Blitz";
  if (total < 1800) return "Rapid";
  return "Classical";
}

export default function PlayPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialTab = location.state?.tab || "humans";
  const [tab, setTab] = useState(initialTab);
  const [botIdx, setBotIdx] = useState(3);
  const [color, setColor] = useState("random");
  const [confirm, setConfirm] = useState(null);
  const [customMin, setCustomMin] = useState(5);
  const [customInc, setCustomInc] = useState(0);
  const [showCustom, setShowCustom] = useState(false);
  const [mode, setMode] = useState("rated");

  useEffect(() => {
    if (location.state?.tab) setTab(location.state.tab);
  }, [location.state]);

  const bot = BOTS[botIdx];

  const startBotGame = (minutes, increment) => {
    const playerColor = color === "random" ? (Math.random() > 0.5 ? "w" : "b") : color;
    const initial = minutes * 60000;
    const inc = increment * 1000;
    navigate("/game", {
      state: {
        opponent: { name: bot.name, rating: bot.rating, level: bot.level },
        playerColor,
        timeControl: initial > 0 ? { initial, increment: inc } : null,
      },
    });
  };

  const handlePresetClick = (preset) => {
    setConfirm({ minutes: preset.m, increment: preset.s, label: preset.label, cat: preset.cat });
  };

  const handleCustomConfirm = () => {
    const m = Math.max(1, customMin);
    const s = Math.max(0, customInc);
    setConfirm({ minutes: m, increment: s, label: `${m}+${s}`, cat: tcCategory(m, s) });
  };

  return (
    <div className="max-w-[1440px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
      {/* Header */}
      <div className="anim-fade-up mb-6" style={{ "--delay": "0.05s" }}>
        <h1 className="font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-1">
          Play
        </h1>
      </div>

      {/* Tab switcher */}
      <div className="anim-fade-up flex gap-1 mb-6" style={{ "--delay": "0.08s" }}>
        {[
          { id: "humans", label: "vs Humans" },
          { id: "bots", label: "vs Bots" },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-5 py-2.5 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${
              tab === t.id
                ? "bg-primary text-on-primary"
                : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ═══ vs Bots ═══ */}
      {tab === "bots" && (
        <div className="anim-fade-up flex flex-col xl:flex-row gap-6 xl:gap-10" style={{ "--delay": "0.1s" }}>
          <div className="flex-1 space-y-6">
            {/* Bot selector */}
            <div>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Opponent</h2>
              <div className="grid grid-cols-4 sm:grid-cols-4 gap-1.5">
                {BOTS.map((b, i) => (
                  <button
                    key={b.name}
                    onClick={() => setBotIdx(i)}
                    className={`flex flex-col items-center py-3 px-2 transition-all duration-150 active:scale-[0.96] ${
                      botIdx === i
                        ? "bg-primary text-on-primary"
                        : "bg-surface-low border border-white/[0.04] hover:bg-surface-high"
                    }`}
                  >
                    <span className="font-headline text-sm font-extrabold tabular-nums">{b.rating}</span>
                    <span className={`text-[9px] uppercase tracking-wide mt-0.5 ${
                      botIdx === i ? "text-on-primary/60" : "text-on-surface-variant/35"
                    }`}>{b.name}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Color */}
            <div>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Play as</h2>
              <div className="flex gap-1.5">
                {[
                  { id: "random", label: "Random" },
                  { id: "w", label: "White" },
                  { id: "b", label: "Black" },
                ].map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setColor(c.id)}
                    className={`flex-1 py-2.5 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${
                      color === c.id
                        ? "bg-primary text-on-primary"
                        : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary"
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Time controls */}
            <div>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Time control</h2>
              <div className="grid grid-cols-5 gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => handlePresetClick(p)}
                    className="flex flex-col items-center justify-center py-3.5 bg-surface-low border border-white/[0.04] hover:bg-surface-high transition-all duration-150 active:scale-[0.95]"
                  >
                    <span className="font-headline text-sm sm:text-base font-extrabold text-primary">{p.label}</span>
                    <span className="text-[9px] text-on-surface-variant/30 uppercase tracking-wide mt-0.5">{p.cat}</span>
                  </button>
                ))}
              </div>

              {/* Custom timer */}
              {!showCustom ? (
                <button
                  onClick={() => setShowCustom(true)}
                  className="w-full mt-2 py-2.5 border border-dashed border-white/[0.08] text-[11px] font-headline font-bold uppercase tracking-wide text-on-surface-variant/25 hover:text-on-surface-variant/40 hover:border-white/[0.12] transition-colors"
                >
                  Custom time control
                </button>
              ) : (
                <div className="mt-2 p-4 bg-surface-low border border-white/[0.04]">
                  <div className="flex gap-3 items-end mb-3">
                    <div className="flex-1">
                      <label className="text-[9px] uppercase tracking-widest text-on-surface-variant/30 block mb-1.5">Minutes</label>
                      <input
                        type="number"
                        min={1}
                        max={180}
                        value={customMin}
                        onChange={(e) => setCustomMin(Math.max(1, parseInt(e.target.value) || 1))}
                        className="w-full bg-surface-lowest border border-white/[0.06] px-3 py-2 text-sm font-mono text-primary outline-none focus:border-primary/30 transition-colors"
                      />
                    </div>
                    <span className="text-on-surface-variant/20 text-lg font-bold pb-2">+</span>
                    <div className="flex-1">
                      <label className="text-[9px] uppercase tracking-widest text-on-surface-variant/30 block mb-1.5">Increment (sec)</label>
                      <input
                        type="number"
                        min={0}
                        max={60}
                        value={customInc}
                        onChange={(e) => setCustomInc(Math.max(0, parseInt(e.target.value) || 0))}
                        className="w-full bg-surface-lowest border border-white/[0.06] px-3 py-2 text-sm font-mono text-primary outline-none focus:border-primary/30 transition-colors"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleCustomConfirm}
                      className="flex-1 py-2.5 bg-primary text-on-primary font-headline text-xs font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.96]"
                    >
                      {customMin}+{customInc} · {tcCategory(customMin, customInc)}
                    </button>
                    <button
                      onClick={() => setShowCustom(false)}
                      className="py-2.5 px-4 bg-surface-high border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-primary transition-colors active:scale-[0.96]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

          </div>

          {/* Right column: quick summary */}
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
                </div>
              </div>
              <p className="text-[10px] text-on-surface-variant/20 leading-relaxed px-1">
                Pick a time control to start. The bot plays locally using minimax search — no server needed.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ═══ vs Humans ═══ */}
      {tab === "humans" && (
        <div className="anim-fade-up flex flex-col xl:flex-row gap-6 xl:gap-10" style={{ "--delay": "0.1s" }}>
          <div className="flex-1 space-y-6">
            {/* Matchmaking */}
            <div>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Quick match</h2>
              <div className="flex gap-1.5 mb-3">
                {["rated", "casual"].map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`px-4 py-2 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${
                      mode === m
                        ? "bg-primary text-on-primary"
                        : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-5 gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    className="flex flex-col items-center justify-center py-3.5 bg-surface-low border border-white/[0.04] hover:bg-surface-high transition-all duration-150 active:scale-[0.95] opacity-60"
                  >
                    <span className="font-headline text-sm sm:text-base font-extrabold text-primary">{p.label}</span>
                    <span className="text-[9px] text-on-surface-variant/30 uppercase tracking-wide mt-0.5">{p.cat}</span>
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-on-surface-variant/20 mt-2 uppercase tracking-widest">
                Online matchmaking coming soon — play bots for now
              </p>
            </div>

            {/* Create game */}
            <div>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Create game</h2>
              <div className="w-full py-3.5 bg-surface-low/50 border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/20 flex items-center justify-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-30">
                  <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                </svg>
                Invite links — coming soon
              </div>
            </div>

            {/* Challenge a friend */}
            <div>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Challenge a friend</h2>
              <div className="space-y-1 max-h-[240px] overflow-y-auto">
                {SAMPLE_FRIENDS.map((f) => (
                  <button
                    key={f.name}
                    className="w-full flex items-center justify-between py-2.5 px-3 bg-surface-low/50 border border-white/[0.02] hover:bg-surface-high/40 transition-colors active:scale-[0.98] text-left"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="relative">
                        <div className="w-7 h-7 rounded-full bg-surface-high flex items-center justify-center">
                          <span className="font-headline text-[9px] font-bold text-on-surface-variant/50 uppercase">{f.name[0]}</span>
                        </div>
                        {f.online && (
                          <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-surface" />
                        )}
                      </div>
                      <div>
                        <span className="font-headline text-xs font-bold text-on-surface-variant/70 block">{f.name}</span>
                        <span className="text-[10px] text-on-surface-variant/25 tabular-nums">{f.rating}</span>
                      </div>
                    </div>
                    <span className="text-[10px] font-headline font-bold uppercase tracking-wide text-on-surface-variant/20">
                      Soon
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Right: open games */}
          <div className="w-full xl:w-[320px] shrink-0">
            <div className="sticky top-20">
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Open games</h2>
              <div className="space-y-1.5">
                <div className="p-6 text-center">
                <span className="text-[11px] text-on-surface-variant/20">No open games yet — online play coming soon</span>
              </div>
              </div>
              <p className="text-[10px] text-on-surface-variant/20 mt-3 leading-relaxed">
                Open games appear when players create public matches. Join one to start playing instantly.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Confirmation modal ═══ */}
      {confirm && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center" onClick={() => setConfirm(null)}>
          <div className="modal-backdrop-enter absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <div
            className="modal-sheet-enter relative bg-surface-container border border-white/[0.06] p-6 sm:p-7 max-w-sm w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-headline text-xl font-extrabold tracking-tighter text-primary mb-4">
              Start game?
            </h2>

            <div className="space-y-3 mb-6">
              <div className="flex justify-between items-center">
                <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/30">Time</span>
                <span className="font-headline text-sm font-bold text-primary">{confirm.label}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/30">Category</span>
                <span className="text-xs text-on-surface-variant/50">{confirm.cat}</span>
              </div>
              {tab === "bots" && (
                <>
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/30">Opponent</span>
                    <span className="text-xs text-on-surface-variant/50">{bot.name} ({bot.rating})</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/30">Color</span>
                    <span className="text-xs text-on-surface-variant/50 capitalize">{color === "w" ? "White" : color === "b" ? "Black" : "Random"}</span>
                  </div>
                </>
              )}
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setConfirm(null)}
                className="flex-1 py-3 bg-surface-low border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-primary transition-colors active:scale-[0.96]"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  startBotGame(confirm.minutes, confirm.increment);
                  setConfirm(null);
                }}
                className="flex-1 py-3 bg-primary text-on-primary font-headline text-xs font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.96]"
              >
                Start Game
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
