import { useNavigate } from "react-router-dom";

export default function ComingSoon({ page, onBack }) {
  const navigate = useNavigate();
  const is404 = page === "unknown";

  return (
    <div className="min-h-[calc(100dvh-4rem)] flex flex-col items-center justify-center px-6 text-center">
      <span
        className="anim-fade-up font-label text-[10px] uppercase tracking-[0.3em] text-on-surface-variant/30 mb-4"
        style={{ "--delay": "0.05s" }}
      >
        {is404 ? "404" : "Coming Soon"}
      </span>
      <h2
        className="anim-fade-up font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-3"
        style={{ "--delay": "0.12s" }}
      >
        {is404 ? "Page not found" : page}
      </h2>
      <p
        className="anim-fade-up text-sm text-on-surface-variant/40 max-w-xs mb-8"
        style={{ "--delay": "0.2s" }}
      >
        {is404
          ? "This page doesn't exist. It might have been moved or you may have typed the wrong URL."
          : `This section is under construction.`}
      </p>
      <button
        onClick={onBack || (() => navigate("/"))}
        className="anim-fade-up px-8 py-3 border border-white/[0.06] bg-surface-low font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.96]"
        style={{ "--delay": "0.28s" }}
      >
        Back to Home
      </button>
    </div>
  );
}
