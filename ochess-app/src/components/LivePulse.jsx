export default function LivePulse() {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-label text-[10px] sm:text-[11px] text-on-surface-variant/50 uppercase tracking-widest">
      <div className="flex items-center gap-2">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        <span>oChess is live</span>
      </div>
      <span className="text-on-surface-variant/25">Free · Open Source</span>
    </div>
  );
}
