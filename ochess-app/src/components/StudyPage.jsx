import { useState } from "react";
import { useNavigate } from "react-router-dom";
import ChessBoard from "./ChessBoard";
import SocialPanel from "./SocialPanel";

const CHAPTERS = [
  { id: 1, title: "Italian Game: Basics", moves: 24, active: true },
  { id: 2, title: "Giuoco Piano: Main Line", moves: 32 },
  { id: 3, title: "Evans Gambit", moves: 18 },
  { id: 4, title: "Two Knights Defense", moves: 28 },
  { id: 5, title: "Hungarian Defense", moves: 14 },
];

const STUDIES = [
  { title: "Italian Game Repertoire", chapters: 5, by: "You" },
  { title: "Endgame Fundamentals", chapters: 12, by: "oChess" },
  { title: "Sicilian Najdorf Deep Dive", chapters: 8, by: "GM_Magnus" },
];

export default function StudyPage({ onNavigate }) {
  const [activeChapter, setActiveChapter] = useState(1);
  const navigate = useNavigate();

  return (
    <div className="flex">
      <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
      {/* Header */}
      <div className="anim-fade-up flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-3" style={{ "--delay": "0.05s" }}>
        <div>
          <h1 className="font-headline text-3xl sm:text-4xl font-extrabold tracking-tighter text-primary">Study</h1>
          <p className="text-[11px] text-on-surface-variant/55 uppercase tracking-widest mt-1">Preview · Italian Game Repertoire</p>
        </div>
        <div className="flex gap-2">
          <span className="px-3 py-2 bg-amber-500/10 border border-amber-500/20 text-[10px] font-headline font-bold uppercase tracking-wide text-amber-400">Coming soon</span>
          <button onClick={() => navigate("/analysis")}
            className="btn btn-secondary px-4 py-2 text-xs">
            Open Analysis
          </button>
        </div>
      </div>

      {/* Honest preview banner — the chapters / annotations below
          are hard-coded sample content while the real Study system
          is being built. Send users to working surfaces now. */}
      <div className="anim-fade-up mb-6 p-3 bg-surface-low border border-white/[0.04] text-[12px] text-on-surface-variant/70 leading-relaxed" style={{ "--delay": "0.06s" }}>
        Studies aren't fully wired up yet — this page shows a sample to illustrate the layout.
        For now, use{" "}
        <button onClick={() => navigate("/analysis")} className="text-primary hover:underline font-bold">Analysis</button>
        {" "}to explore positions and{" "}
        <button onClick={() => navigate("/review")} className="text-primary hover:underline font-bold">Anki</button>
        {" "}to drill saved cards.
      </div>

      <div className="flex flex-col xl:flex-row gap-6 xl:gap-8">
        {/* Board */}
        <div className="flex-1 flex flex-col items-center xl:items-start">
          <div className="anim-scale-in w-full max-w-[600px] xl:max-w-[640px]" style={{ "--delay": "0.1s" }}>
            <ChessBoard />
          </div>

          {/* Annotation area */}
          <div className="anim-fade-up w-full max-w-[600px] xl:max-w-[640px] mt-4 p-4 bg-surface-low border border-white/[0.03]" style={{ "--delay": "0.18s" }}>
            <p className="text-sm text-on-surface-variant/50 leading-relaxed">
              The Italian Game begins with <span className="font-mono text-primary">1.e4 e5 2.Nf3 Nc6 3.Bc4</span>, aiming for quick development and central control. White targets the vulnerable f7 pawn.
            </p>
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-full xl:w-[340px] shrink-0 space-y-6">
          {/* Chapters */}
          <div className="anim-fade-up" style={{ "--delay": "0.1s" }}>
            <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">
              Chapters
            </h3>
            <div className="space-y-1">
              {CHAPTERS.map((ch) => (
                <button
                  key={ch.id}
                  onClick={() => setActiveChapter(ch.id)}
                  className={`w-full text-left px-4 py-3 flex items-center justify-between transition-colors active:scale-[0.98] ${
                    activeChapter === ch.id
                      ? "bg-primary/5 border-l-2 border-primary"
                      : "bg-surface-low/50 border-l-2 border-transparent hover:bg-surface-high/30"
                  }`}
                >
                  <div>
                    <span className={`font-headline text-xs font-bold block ${activeChapter === ch.id ? "text-primary" : "text-on-surface-variant/60"}`}>
                      {ch.title}
                    </span>
                    <span className="text-[10px] text-on-surface-variant/25">{ch.moves} moves</span>
                  </div>
                  <span className="text-[10px] text-on-surface-variant/20">{ch.id}/{CHAPTERS.length}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Your studies */}
          <div className="anim-fade-up" style={{ "--delay": "0.2s" }}>
            <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">
              Your Studies
            </h3>
            <div className="space-y-1">
              {STUDIES.map((s) => (
                <div key={s.title} className="flex items-center justify-between py-3 px-4 bg-surface-low/50 border border-white/[0.02] hover:bg-surface-high/30 transition-colors">
                  <div>
                    <span className="font-headline text-xs font-bold text-on-surface-variant/60 block">{s.title}</span>
                    <span className="text-[10px] text-on-surface-variant/25">{s.chapters} chapters · by {s.by}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      </div>
      <SocialPanel />
    </div>
  );
}
