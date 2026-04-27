import ChessBoard from "./ChessBoard";
import ActionCards from "./ActionCards";
import LivePulse from "./LivePulse";

export default function LandingPage({ onNavigate }) {
  return (
    <>
      {/* ─── Hero ─── */}
      <section className="max-w-[1440px] mx-auto px-4 sm:px-6 md:px-10">
        <div className="lg:min-h-[calc(100dvh-64px)] flex flex-col lg:flex-row items-center lg:gap-0">
          {/* Copy side */}
          <div className="w-full lg:w-[40%] xl:w-[36%] flex flex-col justify-center lg:pr-12 pt-8 sm:pt-16 lg:py-0 relative z-10">
            <span
              className="anim-fade-up font-label text-[9px] sm:text-[10px] lg:text-[13px] uppercase tracking-[0.3em] text-on-surface-variant/40 mb-2 sm:mb-4 font-medium"
              style={{ "--delay": "0.1s" }}
            >
              Free &middot; Open &middot; Fast
            </span>

            <h1
              className="anim-fade-up font-headline text-[3rem] sm:text-[4.5rem] md:text-[5.5rem] lg:text-[7rem] xl:text-[8rem] font-extrabold tracking-tighter text-primary leading-[0.82] mb-3 sm:mb-5"
              style={{ "--delay": "0.18s" }}
            >
              oChess
            </h1>

            <p
              className="anim-fade-up font-body text-[12px] sm:text-[13px] md:text-[15px] lg:text-[16px] text-on-surface-variant/50 max-w-sm leading-[1.6] mb-6 sm:mb-10"
              style={{ "--delay": "0.26s" }}
            >
              The only chess platform with built&#8209;in spaced repetition.
              Play, blunder, review, remember. Your mistakes become your
              training&nbsp;- automatically.
            </p>

            <div className="anim-fade-up" style={{ "--delay": "0.34s" }}>
              <ActionCards onNavigate={onNavigate} />
            </div>

            <div className="anim-fade-up mt-5 sm:mt-8" style={{ "--delay": "0.44s" }}>
              <LivePulse />
            </div>
          </div>

          {/* Board - pushed right, large and prominent */}
          <div className="hidden lg:flex lg:w-[60%] xl:w-[64%] items-center justify-end pl-4">
            <div
              className="anim-scale-in w-full max-w-[600px] xl:max-w-[660px]"
              style={{ "--delay": "0.3s", "--dur": "0.7s" }}
            >
              <ChessBoard cycling onClick={() => onNavigate("play")} />
            </div>
          </div>
        </div>
      </section>

      {/* ─── Why oChess ─── */}
      <section className="border-t border-outline-variant/[0.07] bg-surface-low mt-16 sm:mt-20 lg:mt-0">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 md:px-10 py-14 sm:py-20 md:py-24">
          <div className="anim-fade-up mb-10 sm:mb-14" style={{ "--delay": "0.05s" }}>
            <span className="font-label text-[10px] sm:text-[11px] uppercase tracking-[0.3em] text-on-surface-variant/25 block mb-2">
              Why oChess
            </span>
            <h2 className="font-headline text-2xl sm:text-3xl md:text-4xl font-extrabold tracking-tighter text-primary">
              Built different
            </h2>
          </div>

          {/* Lead differentiator - Review/Anki */}
          <div
            className="anim-fade-up p-6 sm:p-8 bg-surface border border-primary/10 mb-3 sm:mb-4"
            style={{ "--delay": "0.08s" }}
          >
            <div className="flex flex-col sm:flex-row sm:items-start gap-4 sm:gap-8">
              <div className="flex-1">
                <h3 className="font-headline text-base sm:text-lg font-bold tracking-tight text-primary mb-2">
                  {DIFFERENTIATORS[0].title}
                </h3>
                <p className="text-[12px] sm:text-[13px] text-on-surface-variant/50 leading-relaxed max-w-lg">
                  {DIFFERENTIATORS[0].desc}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5 sm:shrink-0 sm:pt-1">
                {["Blunders", "Tactics", "Openings", "Endgames", "Coach tips"].map((tag) => (
                  <span key={tag} className="px-2.5 py-1 text-[10px] bg-primary/5 border border-primary/10 text-primary/60">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Other differentiators */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
            {DIFFERENTIATORS.slice(1).map((d, i) => (
              <div
                key={d.title}
                className="anim-fade-up p-6 sm:p-7 bg-surface border border-white/[0.03]"
                style={{ "--delay": `${0.14 + i * 0.06}s` }}
              >
                <h3 className="font-headline text-sm sm:text-base font-bold tracking-tight text-primary mb-2">
                  {d.title}
                </h3>
                <p className="text-[11px] sm:text-[12px] text-on-surface-variant/40 leading-relaxed">
                  {d.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

const DIFFERENTIATORS = [
  {
    title: "Spaced repetition, built in",
    desc: "Every blunder, missed tactic, and forgotten opening line becomes a review card, scheduled with real Anki-style spacing. The core of how oChess makes you better over time.",
    accent: true,
  },
  {
    title: "Board first",
    desc: "The board is the product. Bigger presence, cleaner controls, less clutter. Everything else is secondary to the game itself.",
  },
  {
    title: "AI coach",
    desc: "Plain-language explanations of your mistakes. Not just engine numbers.",
  },
  {
    title: "Open source",
    desc: "No ads. No paywall. No data selling. Free and transparent, always. Fork it, audit it, contribute.",
  },
];
