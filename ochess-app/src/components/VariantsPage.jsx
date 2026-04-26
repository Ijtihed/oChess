import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Chessboard } from "react-chessboard";
import SocialPanel from "./SocialPanel";
import { load as loadPrefs, getTheme } from "../lib/board-prefs";

const PLAYABLE = [
  {
    id: "chess960", name: "Chess960", icon: "♚", players: "3,210",
    desc: "Randomized back-rank. Fischer Random.",
    detail: "Both sides start with the same randomized piece order. Bishops on opposite colors, king between rooks. No memorized openings — pure chess skill.",
    exampleFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/BRKNNQRB w KQ - 0 1",
    exampleHL: {},
  },
  {
    id: "kingOfTheHill", name: "King of the Hill", icon: "⛰", players: "921",
    desc: "Get your king to the center to win.",
    detail: "Normal chess rules, plus: if your king lands on d4, d5, e4, or e5, you win instantly — even if you're down material.",
    exampleFen: "r1bq1bnr/ppppkppp/2n5/4p3/3PK3/8/PPP1PPPP/RNBQ1BNR w - - 0 1",
    exampleHL: { d4: { boxShadow: "inset 0 0 0 3px rgba(255,215,0,0.5)" }, d5: { boxShadow: "inset 0 0 0 3px rgba(255,215,0,0.5)" }, e4: { boxShadow: "inset 0 0 0 3px rgba(255,215,0,0.5)" }, e5: { boxShadow: "inset 0 0 0 3px rgba(255,215,0,0.5)" } },
  },
  {
    id: "threeCheck", name: "Three-Check", icon: "☑", players: "756",
    desc: "Check your opponent three times to win.",
    detail: "All normal rules apply, but deliver 3 checks total and you win. Aggressive, sacrificial play is rewarded.",
    exampleFen: "rnb1kbnr/pppp1ppp/8/4p3/4P2q/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1",
    exampleHL: {},
  },
  {
    id: "noCastling", name: "No Castling", icon: "🚫", players: "1,420",
    desc: "Standard chess, castling removed.",
    detail: "Endorsed by Kramnik as a serious competitive variant. King safety requires creative solutions from move 1.",
    exampleFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b - - 0 1",
    exampleHL: {},
  },
  {
    id: "antichess", name: "Antichess", icon: "↻", players: "634",
    desc: "Lose all your pieces to win. Captures forced.",
    detail: "Goal: lose everything. If you can capture, you must. King has no special status. First to lose all pieces wins. Stalemate = you win.",
    exampleFen: "rnbqkbnr/pppp1ppp/8/4p3/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
    exampleHL: {},
  },
  {
    id: "atomic", name: "Atomic", icon: "💥", players: "512",
    desc: "Captures cause explosions.",
    detail: "Every capture destroys the capturing piece, the captured piece, and all non-pawn neighbors. If a king is caught in the blast — game over.",
    exampleFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    exampleHL: {},
  },
  {
    id: "racingKings", name: "Racing Kings", icon: "🏁", players: "245",
    desc: "Race your king to rank 8. No checks.",
    detail: "Custom starting position. First king to reach the 8th rank wins. No checks allowed — ever. If White arrives first, Black gets one equalizing turn.",
    exampleFen: "8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1",
    exampleHL: {},
  },
  {
    id: "horde", name: "Horde", icon: "♟", players: "389",
    desc: "36 pawns vs a standard army.",
    detail: "White has 36 pawns flooding the board. Black has a normal setup. White wins by checkmate. Black wins by capturing every last pawn.",
    exampleFen: "rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/4K3 w kq - 0 1",
    exampleHL: {},
  },
  {
    id: "extinction", name: "Extinction", icon: "☠", players: "310",
    desc: "Lose any piece type completely = you lose.",
    detail: "Lose both bishops? You lose. Lose your queen? You lose. Every piece type matters. King has no special royal status.",
    exampleFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    exampleHL: {},
  },
  {
    id: "torpedo", name: "Torpedo", icon: "🚀", players: "180",
    desc: "Pawns can double-move from any rank.",
    detail: "Pawns can always move two squares forward, not just from the starting rank. Makes pawn play much more dynamic and aggressive.",
    exampleFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    exampleHL: {},
  },
  {
    id: "fogOfWar", name: "Fog of War", icon: "🌫", players: "890",
    desc: "You only see what your pieces can see.",
    detail: "Standard chess, but the board is dark. You only see squares your pieces can move to or attack. No check warnings — moving your king into danger loses.",
    exampleFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    exampleHL: {},
  },
  {
    id: "rifle", name: "Rifle Chess", icon: "🎯", players: "420",
    desc: "Capture without moving your piece.",
    detail: "When you capture, your piece stays on its original square. The captured piece is removed. Like shooting from a distance. Completely changes tactics.",
    exampleFen: "rnbqkbnr/pppppppp/8/8/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 0 1",
    exampleHL: {},
  },
  {
    id: "circe", name: "Circe Chess", icon: "🔄", players: "280",
    desc: "Captured pieces respawn on their starting square.",
    detail: "When a piece is captured, it reappears on its original starting square (if empty). If the square is occupied, the piece is gone for good. Captures become temporary.",
    exampleFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    exampleHL: {},
  },
  {
    id: "monster", name: "Monster Chess", icon: "👹", players: "340",
    desc: "King + 4 pawns get two moves per turn.",
    detail: "White has only a king and pawns but makes TWO moves per turn. Black has a full army with one move. An asymmetric battle of speed vs power.",
    exampleFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPP1PPP/4K3 w kq - 0 1",
    exampleHL: {},
  },
  {
    id: "marseillais", name: "Marseillais", icon: "2️⃣", players: "290",
    desc: "Two moves per turn. Check ends your turn.",
    detail: "Each player makes two moves per turn (White's first turn is just one). If your first move gives check, your turn ends immediately. Double the tactics.",
    exampleFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    exampleHL: {},
  },
  {
    id: "progressive", name: "Progressive", icon: "📈", players: "210",
    desc: "1 move, 2 moves, 3 moves... escalating.",
    detail: "White makes 1 move, Black makes 2, White makes 3, and so on. Check ends your sequence immediately. Games get wild fast.",
    exampleFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    exampleHL: {},
  },
  {
    id: "dunsanys", name: "Dunsany's Chess", icon: "♟♟", players: "190",
    desc: "32 pawns vs standard pieces.",
    detail: "White has 32 pawns filling ranks 1–4. Black has a normal setup. White wins by getting a pawn to rank 8. Black wins by capturing all pawns. Asymmetric chaos.",
    exampleFen: "rnbqkbnr/pppppppp/8/8/PPPPPPPP/PPPPPPPP/PPPPPPPP/4K3 w kq - 0 1",
    exampleHL: {},
  },
  {
    id: "checkless", name: "Checkless Chess", icon: "🛡", players: "150",
    desc: "You can't give check (except checkmate).",
    detail: "Moves that deliver check are illegal — unless it's checkmate. King safety is guaranteed until the killing blow. Completely changes endgame strategy.",
    exampleFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    exampleHL: {},
  },
  {
    id: "peasants", name: "Peasants' Revolt", icon: "⚔", players: "120",
    desc: "King + 8 pawns vs king + 3 knights.",
    detail: "White has a king and 8 pawns. Black has a king and 3 knights plus a pawn. A classic asymmetric puzzle — can the peasants overwhelm the cavalry?",
    exampleFen: "1nn1k1n1/4p3/8/8/8/8/PPPPPPPP/4K3 w - - 0 1",
    exampleHL: {},
  },
  {
    id: "weakArmy", name: "Weak Army", icon: "🏳", players: "95",
    desc: "Black starts without rooks.",
    detail: "Black has no rooks — a significant material handicap. Great for learning how to play with fewer resources or testing your attack against a crippled army.",
    exampleFen: "1nbqkbn1/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQ - 0 1",
    exampleHL: {},
  },
];

const COMING_SOON = [
  { name: "Crazyhouse", icon: "⬇", desc: "Captured pieces can be dropped back." },
  { name: "Duck Chess", icon: "🦆", desc: "Place a shared blocking duck after each move." },
  { name: "Knightmate", icon: "♞", desc: "Knights and kings swap roles." },
  { name: "Berolina", icon: "♙", desc: "Pawns move diagonal, capture straight." },
  { name: "Placement", icon: "🎲", desc: "Place your back rank pieces before playing." },
  { name: "Maharaja", icon: "👑", desc: "One super-piece vs a full army." },
  { name: "Bughouse", icon: "🤝", desc: "4-player team variant with drops." },
  { name: "Alice", icon: "🪞", desc: "Two boards — pieces teleport after moving." },
  { name: "Capablanca", icon: "🏰", desc: "10×8 board with new piece types." },
  { name: "Cylindrical", icon: "🔁", desc: "a-file and h-file are connected." },
  { name: "Four-Player", icon: "4️⃣", desc: "Cross-shaped board, 4 players." },
  { name: "Kung Fu", icon: "⚡", desc: "Real-time — no turns, cooldown timers." },
];

const BOTS = [
  { level: 0, name: "Random", rating: 400 },
  { level: 1, name: "Rookie", rating: 600 },
  { level: 2, name: "Patzer", rating: 900 },
  { level: 3, name: "Club", rating: 1200 },
  { level: 4, name: "Expert", rating: 1500 },
  { level: 5, name: "Master", rating: 1800 },
];

function MiniBoard({ fen, highlights }) {
  const prefs = loadPrefs();
  const theme = getTheme(prefs.boardTheme);
  const isImage = theme.type === "image";
  return (
    <div className="w-full pointer-events-none">
      <Chessboard options={{
        position: fen,
        boardOrientation: "white",
        boardStyle: isImage ? { borderRadius: "0px", backgroundImage: `url(${theme.src})`, backgroundSize: "100% 100%" } : { borderRadius: "0px" },
        darkSquareStyle: isImage ? { backgroundColor: "transparent" } : { backgroundColor: theme.dark },
        lightSquareStyle: isImage ? { backgroundColor: "transparent" } : { backgroundColor: theme.light },
        squareStyles: highlights || {},
        allowDragging: false, showNotation: false, animationDurationInMs: 0,
      }} />
    </div>
  );
}

export default function VariantsPage() {
  const navigate = useNavigate();
  const [selectedVariant, setSelectedVariant] = useState(null);
  const [hoveredVariant, setHoveredVariant] = useState(null);
  const [selectedBot, setSelectedBot] = useState(3);
  const [selectedColor, setSelectedColor] = useState("w");
  const [showComingSoon, setShowComingSoon] = useState(false);

  const startGame = () => {
    if (!selectedVariant) return;
    const bot = BOTS[selectedBot];
    const color = selectedColor === "random" ? (Math.random() < 0.5 ? "w" : "b") : selectedColor;
    navigate("/variant-game", {
      state: { variantId: selectedVariant, opponent: { name: bot.name, level: bot.level, rating: bot.rating }, playerColor: color },
    });
  };

  const hovered = hoveredVariant && !selectedVariant ? PLAYABLE.find((v) => v.id === hoveredVariant) : null;

  return (
    <div className="flex min-h-[calc(100vh-4rem)]">
      <div className="flex-1 min-w-0 px-4 sm:px-6 xl:pl-16 xl:pr-6 py-6 sm:py-10">
        <div className="anim-fade-up mb-6" style={{ "--delay": "0.05s" }}>
          <h1 className="font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-1">Variants</h1>
          <p className="text-sm text-on-surface-variant/40">Chess, but different. {PLAYABLE.length} playable now, {COMING_SOON.length} more coming.</p>
        </div>

        <div className="flex flex-col xl:flex-row gap-6">
          <div className="flex-1">
            {/* Playable variants */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
              {PLAYABLE.map((v, i) => (
                <button key={v.id}
                  onClick={() => setSelectedVariant(v.id === selectedVariant ? null : v.id)}
                  onMouseEnter={() => setHoveredVariant(v.id)}
                  onMouseLeave={() => setHoveredVariant(null)}
                  className={`anim-fade-up group p-3 border text-left transition-all duration-150 active:scale-[0.97] ${
                    selectedVariant === v.id ? "bg-primary/10 border-primary/30" : "bg-surface-low border-white/[0.04] hover:bg-surface-high hover:border-white/[0.08]"
                  }`} style={{ "--delay": `${0.04 + i * 0.02}s` }}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-sm opacity-50">{v.icon}</span>
                    <h3 className={`font-headline text-[12px] font-bold truncate ${selectedVariant === v.id ? "text-primary" : "text-primary/80 group-hover:text-primary"}`}>{v.name}</h3>
                  </div>
                  <p className="text-[10px] text-on-surface-variant/30 leading-snug line-clamp-2">{v.desc}</p>
                </button>
              ))}
            </div>

            {/* Hover preview */}
            {hovered && (
              <div className="mt-2 bg-surface-container border border-white/[0.04] p-3 flex gap-3 items-start anim-fade-up" style={{ "--delay": "0s" }}>
                <div className="w-[140px] shrink-0"><MiniBoard fen={hovered.exampleFen} highlights={hovered.exampleHL} /></div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-headline text-sm font-bold text-primary mb-1">{hovered.icon} {hovered.name}</h3>
                  <p className="text-[12px] text-on-surface-variant/50 leading-relaxed">{hovered.detail}</p>
                </div>
              </div>
            )}

            {/* Quick links */}
            <div className="flex gap-1.5 mt-3">
              <button onClick={() => navigate("/play")} className="flex-1 py-2.5 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-primary transition-colors">♔ Standard</button>
              <button onClick={() => navigate("/analysis")} className="flex-1 py-2.5 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-primary transition-colors">✎ From Position</button>
            </div>

            {/* Coming soon toggle */}
            <button onClick={() => setShowComingSoon(!showComingSoon)}
              className="mt-4 text-[11px] text-on-surface-variant/30 hover:text-on-surface-variant/50 transition-colors">
              {showComingSoon ? "Hide" : "Show"} {COMING_SOON.length} upcoming variants →
            </button>

            {showComingSoon && (
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-1.5">
                {COMING_SOON.map((v) => (
                  <div key={v.name} className="p-2.5 bg-surface-low/50 border border-white/[0.03] opacity-50">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-xs opacity-40">{v.icon}</span>
                      <span className="font-headline text-[11px] font-bold text-on-surface-variant/40">{v.name}</span>
                    </div>
                    <p className="text-[9px] text-on-surface-variant/20 leading-snug">{v.desc}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Setup panel */}
          {selectedVariant && (
            <div className="w-full xl:w-[260px] shrink-0 anim-fade-up space-y-3" style={{ "--delay": "0s" }}>
              <div className="bg-surface-container border border-white/[0.04] p-4 space-y-4">
                <h3 className="font-headline text-sm font-bold uppercase tracking-widest text-primary/70">
                  {PLAYABLE.find((v) => v.id === selectedVariant)?.name}
                </h3>
                <div>
                  <label className="text-[10px] text-on-surface-variant/30 block mb-1.5">Opponent</label>
                  <div className="grid grid-cols-3 gap-1">
                    {BOTS.map((bot, i) => (
                      <button key={i} onClick={() => setSelectedBot(i)}
                        className={`py-2 px-1 text-center transition-colors ${selectedBot === i ? "bg-primary text-on-primary" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary"}`}>
                        <span className="font-headline text-[10px] font-bold block">{bot.name}</span>
                        <span className="text-[9px] opacity-60">{bot.rating}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-on-surface-variant/30 block mb-1.5">Play as</label>
                  <div className="flex gap-1">
                    {[{ id: "w", label: "White" }, { id: "b", label: "Black" }, { id: "random", label: "Random" }].map((c) => (
                      <button key={c.id} onClick={() => setSelectedColor(c.id)}
                        className={`flex-1 py-2 font-headline text-[10px] font-bold uppercase transition-colors ${selectedColor === c.id ? "bg-primary text-on-primary" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary"}`}>{c.label}</button>
                    ))}
                  </div>
                </div>
                <button onClick={startGame}
                  className="w-full py-3 bg-primary text-on-primary font-headline text-sm font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.97]">
                  Play
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <SocialPanel />
    </div>
  );
}
