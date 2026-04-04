const VARIANTS = [
  { name: "Standard",         desc: "Classic chess with all the standard rules.",                     players: "12,847" },
  { name: "Chess960",         desc: "Randomized back-rank starting position. Fischer Random.",       players: "3,210" },
  { name: "Crazyhouse",       desc: "Captured pieces can be dropped back on the board.",             players: "1,845" },
  { name: "King of the Hill", desc: "Win by getting your king to the center 4 squares.",             players: "921" },
  { name: "Three-Check",      desc: "Check your opponent three times to win.",                       players: "756" },
  { name: "Antichess",        desc: "Lose all your pieces to win. Captures are forced.",             players: "634" },
  { name: "Atomic",           desc: "Captures cause explosions that destroy surrounding pieces.",    players: "512" },
  { name: "Horde",            desc: "White has 36 pawns. Black has a standard army. Asymmetric.",    players: "389" },
  { name: "Racing Kings",     desc: "Race your king to the 8th rank. No checks allowed.",           players: "245" },
  { name: "From Position",    desc: "Set up any custom position and play from there.",               players: "—" },
];

export default function VariantsPage({ onNavigate }) {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
      <div className="anim-fade-up mb-6 sm:mb-8" style={{ "--delay": "0.05s" }}>
        <h1 className="font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-1">
          Variants
        </h1>
        <p className="text-sm text-on-surface-variant/40">Chess, but different. Pick a mode.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 sm:gap-3">
        {VARIANTS.map((v, i) => (
          <button
            key={v.name}
            onClick={() => onNavigate("play")}
            className="anim-fade-up group flex flex-col justify-between p-5 sm:p-6 bg-surface-low border border-white/[0.04] text-left hover:bg-surface-high transition-all duration-200 active:scale-[0.97]"
            style={{ "--delay": `${0.06 + i * 0.03}s` }}
          >
            <div className="mb-3">
              <h3 className="font-headline text-base sm:text-lg font-bold text-primary group-hover:text-primary/90 mb-1">{v.name}</h3>
              <p className="text-[11px] sm:text-xs text-on-surface-variant/35 leading-relaxed">{v.desc}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/60" />
              <span className="text-[10px] text-on-surface-variant/25 uppercase tracking-wide">{v.players} playing</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
