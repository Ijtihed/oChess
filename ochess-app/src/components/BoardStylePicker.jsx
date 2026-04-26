import { useState, useEffect, useRef } from "react";
import { PIECE_SETS, COLOR_THEMES, IMAGE_THEMES, load, save, getTheme } from "../lib/board-prefs";

function applyPreview(prefs) {
  save(prefs);
  window.dispatchEvent(new Event("ochess-prefs-changed"));
}

export default function BoardStylePicker() {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState(load);
  const [original, setOriginal] = useState(null);
  const panelRef = useRef(null);
  const theme = getTheme(prefs.boardTheme);

  useEffect(() => {
    if (!open) return;
    const outside = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        handleCancel();
      }
    };
    const onKey = (e) => { if (e.key === "Escape") handleCancel(); };
    // pointerdown matches the rest of the app (modal dismissals,
    // navbar search) so touch + pen + mouse all behave identically.
    const id = setTimeout(() => document.addEventListener("pointerdown", outside), 0);
    window.addEventListener("keydown", onKey);
    // On mobile the panel is `inset-4` — almost full-screen — so we
    // lock body scroll while open. Desktop floats it in the corner
    // so background scroll is unobtrusive there, but locking is the
    // safe default.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      clearTimeout(id);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, original]);

  const handleOpen = () => {
    setOriginal(load());
    setOpen(true);
  };

  const handlePreview = (newPrefs) => {
    setPrefs(newPrefs);
    applyPreview(newPrefs);
  };

  const handleApply = () => {
    save(prefs);
    window.dispatchEvent(new Event("ochess-prefs-changed"));
    setOriginal(null);
    setOpen(false);
  };

  const handleCancel = () => {
    if (original) {
      save(original);
      setPrefs(original);
      window.dispatchEvent(new Event("ochess-prefs-changed"));
    }
    setOriginal(null);
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        onClick={handleOpen}
        className="fixed bottom-4 left-4 z-[60] w-10 h-10 bg-surface-high/80 backdrop-blur border border-white/[0.06] flex items-center justify-center hover:bg-surface-highest/80 transition-colors active:scale-90"
        title="Board style"
        aria-label="Open board style picker"
        aria-expanded={open}
      >
        <div className="w-5 h-5 grid grid-cols-2 gap-px overflow-hidden">
          {theme.type === "image" ? (
            <img src={theme.src} alt="" className="w-5 h-5 col-span-2 row-span-2 object-cover" />
          ) : (
            <>
              <div style={{ backgroundColor: theme.light }} className="rounded-[1px]" />
              <div style={{ backgroundColor: theme.dark }} className="rounded-[1px]" />
              <div style={{ backgroundColor: theme.dark }} className="rounded-[1px]" />
              <div style={{ backgroundColor: theme.light }} className="rounded-[1px]" />
            </>
          )}
        </div>
      </button>
    );
  }

  return (
    <div ref={panelRef}
      role="dialog" aria-modal="true" aria-label="Board style settings"
      className="fixed inset-4 sm:inset-auto sm:bottom-4 sm:left-4 z-[60] bg-surface-container/95 backdrop-blur-xl border border-white/[0.06] shadow-2xl flex flex-col sm:max-h-[75vh]" style={{ width: undefined, maxWidth: "min(92vw, 560px)" }}>
      <div className="p-3 border-b border-white/[0.04] flex items-center justify-between shrink-0">
        <h3 className="font-headline text-sm sm:text-xs font-bold uppercase tracking-widest text-on-surface-variant/40">Board Style</h3>
        <button onClick={handleCancel} className="text-xs sm:text-[10px] text-on-surface-variant/30 hover:text-primary transition-colors">Cancel</button>
      </div>

      {/* Mobile: single scrollable column. Desktop: side by side */}
      <div className="flex-1 overflow-y-auto sm:overflow-hidden sm:flex sm:flex-row">
        {/* Boards */}
        <div className="p-3 space-y-3 sm:flex-1 sm:overflow-y-auto sm:border-r border-white/[0.03]">
          <div>
            <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25 block mb-2">Solid</span>
            <div className="grid grid-cols-4 gap-1.5">
              {COLOR_THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => handlePreview({ ...prefs, boardTheme: t.id })}
                  className={`flex flex-col items-center py-1.5 transition-colors active:scale-[0.95] ${prefs.boardTheme === t.id ? "bg-primary/10 border border-primary/30" : "bg-surface-low border border-white/[0.04] hover:bg-surface-high"}`}
                >
                  <div className="w-6 h-3 grid grid-cols-2">
                    <div style={{ backgroundColor: t.light }} />
                    <div style={{ backgroundColor: t.dark }} />
                  </div>
                  <span className="text-[7px] text-on-surface-variant/40 mt-0.5">{t.name}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25 block mb-2">Textured</span>
            <div className="grid grid-cols-4 gap-1.5">
              {IMAGE_THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => handlePreview({ ...prefs, boardTheme: t.id })}
                  className={`flex flex-col items-center py-1 transition-colors active:scale-[0.95] ${prefs.boardTheme === t.id ? "bg-primary/10 border border-primary/30" : "bg-surface-low border border-white/[0.04] hover:bg-surface-high"}`}
                >
                  <img src={t.src} alt={t.name} className="w-8 h-4 object-cover" />
                  <span className="text-[6px] text-on-surface-variant/40 mt-0.5 truncate w-full text-center">{t.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Pieces */}
        <div className="p-3 sm:w-[200px] sm:shrink-0 sm:overflow-y-auto border-t sm:border-t-0 border-white/[0.03]">
          <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25 block mb-2">Pieces</span>
          <div className="grid grid-cols-4 gap-1.5">
            {PIECE_SETS.map((s) => (
              <button
                key={s}
                onClick={() => handlePreview({ ...prefs, pieceSet: s })}
                className={`flex flex-col items-center py-1 transition-colors active:scale-[0.95] ${prefs.pieceSet === s ? "bg-primary/10 border border-primary/30" : "bg-surface-low border border-white/[0.04] hover:bg-surface-high"}`}
              >
                <img src={`/piece/${s}/wN.svg`} alt={s} className="w-6 h-6" />
                <span className="text-[5px] text-on-surface-variant/30 truncate w-full text-center">{s}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="p-3 border-t border-white/[0.04] flex gap-2 shrink-0">
        <button onClick={handleApply} className="flex-1 py-2 bg-primary text-on-primary font-headline text-xs font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.96]">
          Apply
        </button>
        <button onClick={() => handlePreview({ pieceSet: "cburnett", boardTheme: "dark" })} className="py-2 px-3 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/30 hover:text-primary transition-colors active:scale-[0.96]">
          Reset
        </button>
        <button onClick={handleCancel} className="py-2 px-3 bg-surface-low border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-primary transition-colors active:scale-[0.96]">
          Cancel
        </button>
      </div>
    </div>
  );
}
