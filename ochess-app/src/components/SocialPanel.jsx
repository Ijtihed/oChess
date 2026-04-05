const FRIENDS = [
  { name: "KnightRider42", rating: 1580, online: true },
  { name: "DarkBishop", rating: 1623, online: true },
  { name: "PawnStorm99", rating: 1545, online: false },
  { name: "QueenGambit", rating: 1601, online: true },
  { name: "EndgameWizard", rating: 1890, online: false },
  { name: "TacticsFanatic", rating: 1340, online: true },
];

const ACTIVITY = [
  { who: "QueenGambit", what: "won vs Stockfish", when: "1m ago" },
  { who: "DarkBishop", what: "solved 12 puzzles", when: "3m ago" },
  { who: "TacticsFanatic", what: "started a game", when: "7m ago" },
];

export default function SocialPanel() {
  return (
    <div className="hidden 2xl:flex w-[220px] shrink-0 flex-col gap-5 border-l border-white/[0.03] px-5 py-5 sticky top-16 h-[calc(100vh-4rem)] overflow-y-auto">
      <div>
        <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Friends</h3>
        <div className="space-y-1">
          {FRIENDS.map((f) => (
            <div key={f.name} className="flex items-center justify-between py-2 px-2.5 bg-surface-low/50 border border-white/[0.02] hover:bg-surface-high/30 transition-colors">
              <div className="flex items-center gap-2">
                <div className="relative">
                  <div className="w-6 h-6 rounded-full bg-surface-high flex items-center justify-center">
                    <span className="font-headline text-[8px] font-bold text-on-surface-variant/50 uppercase">{f.name[0]}</span>
                  </div>
                  {f.online && <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-emerald-500 rounded-full border-[1.5px] border-surface" />}
                </div>
                <div className="min-w-0">
                  <span className="font-headline text-[10px] font-bold text-on-surface-variant/60 block leading-tight truncate">{f.name}</span>
                  <span className="text-[9px] text-on-surface-variant/25 tabular-nums">{f.rating}</span>
                </div>
              </div>
              {f.online && <span className="text-[9px] text-emerald-500/50">online</span>}
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Activity</h3>
        <div className="space-y-2">
          {ACTIVITY.map((a, i) => (
            <div key={i} className="text-[10px] text-on-surface-variant/25 leading-relaxed">
              <span className="text-on-surface-variant/40 font-bold">{a.who}</span> {a.what}
              <span className="text-on-surface-variant/15 block">{a.when}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
