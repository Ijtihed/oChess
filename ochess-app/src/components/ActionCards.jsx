const ACTIONS = [
  {
    id: "play",
    label: "Play",
    description: "Rated games, instant matchmaking",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
    primary: true,
  },
  {
    id: "review",
    label: "Anki",
    description: "Spaced repetition for chess memory",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
    ),
    accent: true,
  },
  {
    id: "bots",
    label: "Play Bot",
    description: "Train against AI opponents",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="3" />
        <path d="M12 8v3" />
        <circle cx="8" cy="16" r="1" fill="currentColor" />
        <circle cx="16" cy="16" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "puzzles",
    label: "Puzzles",
    description: "Sharpen your tactical vision",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4 7h3a2 2 0 012 2v0a2 2 0 01-2 2H4v5h5v-3a2 2 0 012-2v0a2 2 0 012 2v3h5v-5h-3a2 2 0 01-2-2v0a2 2 0 012-2h3V4h-5v3a2 2 0 01-2 2v0a2 2 0 01-2-2V4H4z" />
      </svg>
    ),
  },
  {
    id: "analysis",
    label: "Analysis",
    description: "Engine review + AI coach",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 3v18h18" />
        <path d="M7 16l4-8 4 4 5-9" />
      </svg>
    ),
  },
];

export default function ActionCards({ onNavigate }) {
  return (
    <div className="w-full lg:max-w-lg">
      {/* Top row: Play + Review */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 mb-2.5 sm:mb-3">
        {ACTIONS.slice(0, 2).map((action) => (
          <button
            key={action.id}
            onClick={() => onNavigate(action.id)}
            className={`group relative flex flex-col justify-between p-4 sm:p-5 md:p-7 text-left transition-all duration-200 active:scale-[0.96] ${
              action.primary
                ? "bg-primary text-on-primary hover:bg-primary-dim"
                : action.accent
                ? "bg-surface-low border border-primary/20 text-on-surface hover:bg-surface-high hover:border-primary/30"
                : "bg-surface-low border border-white/[0.06] text-on-surface hover:bg-surface-high"
            }`}
          >
            <div className="flex items-center justify-between w-full mb-2 sm:mb-4">
              <span className="font-headline text-[22px] sm:text-[25px] font-bold tracking-tight leading-none">
                {action.label}
              </span>
              <span
                className={`opacity-40 group-hover:opacity-100 transition-opacity ${
                  action.primary ? "" : action.accent ? "text-primary" : "text-on-surface-variant"
                }`}
              >
                {action.icon}
              </span>
            </div>
            <span
              className={`text-[13px] sm:text-[15px] leading-snug ${
                action.primary ? "text-on-primary/50" : action.accent ? "text-on-surface-variant/50" : "text-on-surface-variant/40"
              }`}
            >
              {action.description}
            </span>
          </button>
        ))}
      </div>
      {/* Bottom row: Bot, Puzzles, Analysis */}
      <div className="grid grid-cols-3 gap-2.5 sm:gap-3">
        {ACTIONS.slice(2).map((action) => (
          <button
            key={action.id}
            onClick={() => onNavigate(action.id)}
            className="group relative flex flex-col justify-between p-3 sm:p-4 text-left transition-all duration-200 active:scale-[0.96] bg-surface-low border border-white/[0.06] text-on-surface hover:bg-surface-high"
          >
            <div className="flex items-center justify-between w-full mb-1.5 sm:mb-2">
              <span className="font-headline text-[15px] sm:text-[17px] font-bold tracking-tight leading-none">
                {action.label}
              </span>
              <span className="opacity-30 group-hover:opacity-80 transition-opacity text-on-surface-variant hidden sm:block">
                {action.icon}
              </span>
            </div>
            <span className="text-[11px] sm:text-[12px] leading-snug text-on-surface-variant/35">
              {action.description}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
