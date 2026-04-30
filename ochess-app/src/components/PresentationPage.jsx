import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import InteractiveBoard from "./InteractiveBoard";
import { Position } from "../lib/arena/position";
import { resolveRules } from "../lib/arena/rules";
import { generateLegalMoves } from "../lib/arena/move-gen";
import { applyMove } from "../lib/arena/apply-move";

/**
 * PresentationPage - mounted at /presentation.
 *
 * A single-route slide deck that explains AI Arena + Anki
 * using the SAME real <InteractiveBoard /> the rest of the
 * app uses. Every diagram is a real chess board rendered with
 * react-chessboard + the user's preferred piece set; no
 * hand-rolled HTML approximations.
 *
 * Layout:
 *   - Sticky vertical scroll-snap deck.
 *   - Each slide fills the viewport and is scroll-snapped.
 *   - Side dot navigation for jumping; arrow keys for
 *     keyboard advance.
 *
 * The boards are read-only (`interactive={false}`) so they're
 * pure presentation. For the "play sequence" slides we render
 * one board per panel with a position-only FEN; chess.js
 * accepts any valid placement string regardless of how it was
 * reached, so variant-specific positions render fine even
 * though chess.js would never accept the variant move that
 * produced them.
 */
export default function PresentationPage() {
  const navigate = useNavigate();
  const mainRef = useRef(null);
  const slideRefs = useRef([]);
  const [activeIdx, setActiveIdx] = useState(0);

  // Keyboard nav: arrow keys / page up / page down / home / end.
  useEffect(() => {
    const handler = (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const slides = slideRefs.current.filter(Boolean);
      if (slides.length === 0) return;
      const idx = activeIdx;
      const go = (i) => {
        const target = Math.max(0, Math.min(slides.length - 1, i));
        slides[target]?.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      if (["ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); go(idx + 1); }
      else if (["ArrowUp", "PageUp"].includes(e.key)) { e.preventDefault(); go(idx - 1); }
      else if (e.key === "Home") { e.preventDefault(); go(0); }
      else if (e.key === "End") { e.preventDefault(); go(slides.length - 1); }
      else if (e.key === "Escape") { e.preventDefault(); navigate("/"); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeIdx, navigate]);

  // Track active slide for the dot indicator.
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return undefined;
    const tick = () => {
      const slides = slideRefs.current.filter(Boolean);
      const top = main.scrollTop;
      let best = 0;
      let bestDist = Infinity;
      slides.forEach((s, i) => {
        const dist = Math.abs(s.offsetTop - top);
        if (dist < bestDist) { bestDist = dist; best = i; }
      });
      setActiveIdx(best);
    };
    main.addEventListener("scroll", tick, { passive: true });
    tick();
    return () => main.removeEventListener("scroll", tick);
  }, []);

  const setSlideRef = (i) => (el) => { slideRefs.current[i] = el; };

  return (
    <div className="fixed inset-0 z-40 bg-surface text-on-surface">
      {/* Side dot navigation */}
      <nav className="fixed right-5 top-1/2 -translate-y-1/2 z-50 flex flex-col gap-1.5" aria-label="Slide navigation">
        {SLIDES.map((_, i) => (
          <button key={i}
            type="button"
            onClick={() => slideRefs.current[i]?.scrollIntoView({ behavior: "smooth", block: "start" })}
            aria-label={`Slide ${i + 1}`}
            className={`w-1.5 rounded-full transition-all ${activeIdx === i ? "h-4 bg-primary" : "h-1.5 bg-white/15 hover:bg-white/40"}`}
          />
        ))}
      </nav>

      {/* Close button */}
      <button
        type="button"
        onClick={() => navigate("/")}
        className="fixed top-4 left-4 z-50 px-3 py-2 bg-surface-low/80 backdrop-blur border border-white/10 font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/55 hover:text-primary hover:border-primary/30 transition-colors"
      >
        \u2190 Back
      </button>

      <main
        ref={mainRef}
        className="h-full overflow-y-scroll snap-y snap-mandatory scroll-smooth"
        style={{ scrollbarWidth: "none" }}
      >
        {SLIDES.map((Slide, i) => (
          <section
            key={i}
            ref={setSlideRef(i)}
            className="snap-start min-h-screen min-h-[100dvh] flex flex-col justify-center px-6 sm:px-12 md:px-20 py-8 relative border-b border-white/[0.04]"
          >
            <span className="absolute top-5 right-6 font-headline font-extrabold text-[10px] tracking-[0.3em] text-outline-variant/60">
              {String(i + 1).padStart(2, "0")} / {String(SLIDES.length).padStart(2, "0")}
            </span>
            <Slide />
          </section>
        ))}
      </main>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Drop-in real-board renderer. Wraps <InteractiveBoard /> in a
 * fixed-aspect-ratio container and disables interaction so it
 * behaves like a static diagram. Highlights are passed through
 * `highlightSquares`, which the same prop the regular Play tab
 * uses for last-move tints.
 */
function StaticBoard({ fen, highlights = {}, size = "md" }) {
  const max = size === "lg" ? 460 : size === "sm" ? 220 : 320;
  return (
    <div className="w-full" style={{ maxWidth: `${max}px` }}>
      <InteractiveBoard
        fen={fen}
        interactive={false}
        orientation="white"
        highlightSquares={highlights}
        playerColor="w"
      />
    </div>
  );
}

const tint = (sq, kind = "last") => ({
  [sq]: {
    backgroundColor:
      kind === "from" ? "rgba(120,200,255,0.30)" :
      kind === "to" ? "rgba(120,200,255,0.45)" :
      kind === "target" ? "rgba(255,209,102,0.45)" :
      "rgba(255,255,255,0.10)",
  },
});

function multiTint(squares, kind = "target") {
  const out = {};
  for (const sq of squares) Object.assign(out, tint(sq, kind));
  return out;
}

function Pipeline({ steps }) {
  return (
    <div className="flex flex-col md:flex-row items-stretch gap-1">
      {steps.map((s, i) => (
        <div key={i} className={`flex-1 p-4 ${s.emphasis ? "bg-primary text-on-primary" : "bg-surface-low border border-white/10"}`}>
          <div className={`font-headline font-bold text-[10px] uppercase tracking-widest mb-2 ${s.emphasis ? "opacity-60" : "text-outline"}`}>
            {String(i + 1).padStart(2, "0")} {s.label}
          </div>
          <div className={`font-headline font-bold text-sm ${s.emphasis ? "" : ""}`}>{s.title}</div>
          {s.sub && <div className={`text-xs mt-1 ${s.emphasis ? "opacity-70" : "text-on-surface-variant/60"}`}>{s.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// ── Slide content ───────────────────────────────────────────

function Slide1Title() {
  return (
    <div className="anim-fade-up relative">
      <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-[15%] pointer-events-none select-none font-headline font-black text-[20rem] md:text-[28rem] leading-[0.85] text-white/[0.03]">
        AI
      </div>
      <span className="font-headline font-bold text-[10px] uppercase tracking-[0.3em] text-on-surface-variant/55">oChess</span>
      <h1 className="anim-fade-up font-headline text-6xl sm:text-7xl md:text-[9rem] font-extrabold tracking-tighter text-primary leading-[0.85] mt-3 mb-10">
        AI Arena<br />+ Anki
      </h1>
      <p className="text-base text-on-surface-variant/65 max-w-xl">Two AI tools. One chess app.</p>
      <p className="mt-12 text-[11px] uppercase tracking-[0.3em] text-on-surface-variant/35">
        Scroll &darr; to advance &middot; Press Esc to exit
      </p>
    </div>
  );
}

function Slide2WhatIsArena() {
  return (
    <div className="grid md:grid-cols-2 gap-12 items-center anim-fade-up">
      <div>
        <span className="font-headline font-bold text-[10px] uppercase tracking-[0.3em] text-amber-300/85">AI Arena</span>
        <h2 className="font-headline text-4xl md:text-6xl font-extrabold tracking-tighter text-primary leading-[0.9] mt-3">
          Type a sentence.<br/>Get a chess game.
        </h2>
        <div className="font-mono text-sm bg-surface-low border border-white/10 p-4 mt-8">
          "Pawns can move backward."
        </div>
        <p className="text-sm text-on-surface-variant/65 mt-4">
          Drag a pawn around. The variant rules are live &mdash; pawns can step
          backward as well as forward, but they still capture diagonally only.
        </p>
      </div>
      {/* Real interactive playground: drag the pawns, the
          Arena variant engine resolves the moves under the
          Reverse Pawns ruleset. */}
      <div className="flex justify-center">
        <ReversePawnsPlayground />
      </div>
    </div>
  );
}

/**
 * Self-contained interactive sample of the Reverse Pawns
 * variant. Wraps the real <InteractiveBoard /> with the
 * Arena variant engine so every drag honours the same
 * resolveRules + generateLegalMoves + applyMove pipeline the
 * production Arena rooms use.
 *
 * The board is sandbox-only: no clock, no opponent. Drag any
 * pawn forward OR backward, drag white and black freely
 * (turns alternate), and the dot-hints reflect the variant's
 * legal moves. A reset button resets the position.
 */
const REVERSE_PAWNS_RULES_DIFF = {
  extends: "vanilla",
  name: "Reverse Pawns",
  description: "Pawns may step backward to your own first rank to reset and try again.",
  pieces: {
    p: {
      moves: [
        { kind: "step", dirs: [[0, 1]], conditions: { onlyNonCapture: true } },
        { kind: "step", dirs: [[0, 2]], conditions: { onlyFirstMove: true, onlyNonCapture: true } },
        { kind: "step", dirs: [[1, 1], [-1, 1]], conditions: { onlyCapture: true } },
        { kind: "step", dirs: [[1, 1], [-1, 1]], conditions: { enPassant: true } },
        { kind: "step", dirs: [[0, -1]], conditions: { onlyNonCapture: true } },
      ],
    },
  },
};

const PLAYGROUND_FEN = "4k3/8/4p3/8/8/4P3/8/4K3 w - - 0 1";

function ReversePawnsPlayground() {
  const rules = useMemo(() => {
    try { return resolveRules(REVERSE_PAWNS_RULES_DIFF); }
    catch { return null; }
  }, []);
  const [position, setPosition] = useState(() => Position.fromFen(PLAYGROUND_FEN));
  const [highlight, setHighlight] = useState({});

  const reset = useCallback(() => {
    setPosition(Position.fromFen(PLAYGROUND_FEN));
    setHighlight({});
  }, []);

  // Variant-aware dot hints. Same shape the Arena uses.
  const legalMovesProvider = useCallback((square) => {
    if (!rules) return [];
    return generateLegalMoves(position, rules)
      .filter((m) => m.from === square)
      .map((m) => ({
        to: m.to,
        promotion: m.promotion,
        captured: !!position.pieceAt(m.to) || !!m.enPassant,
      }));
  }, [position, rules]);

  const onMove = useCallback((move) => {
    if (!rules) return false;
    let next;
    try { next = applyMove(position, move, rules); }
    catch { return false; }
    setPosition(next);
    setHighlight({
      [move.from]: { backgroundColor: "rgba(255,255,255,0.07)" },
      [move.to]:   { backgroundColor: "rgba(255,255,255,0.11)" },
    });
    return true;
  }, [position, rules]);

  // Tell the board which side moves next so it can pick up
  // pieces of the correct color. The variant engine tracks
  // turn internally on `position.turn`.
  const playerColor = position.turn;

  return (
    <div className="w-full max-w-md">
      <div className="aspect-square">
        <InteractiveBoard
          fen={position.toFen()}
          orientation="white"
          interactive
          playerColor={playerColor}
          highlightSquares={highlight}
          legalMovesProvider={legalMovesProvider}
          onMove={onMove}
        />
      </div>
      <div className="flex items-center justify-between mt-3">
        <span className="font-mono text-[11px] text-outline">
          {playerColor === "w" ? "white" : "black"} to move
        </span>
        <button
          type="button"
          onClick={reset}
          className="px-3 py-1.5 bg-surface-low border border-white/10 font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/55 hover:text-primary hover:border-primary/30 transition-colors"
        >
          reset
        </button>
      </div>
    </div>
  );
}

function Slide3Pipeline() {
  return (
    <div className="anim-fade-up max-w-7xl w-full mx-auto">
      <span className="font-headline font-bold text-[10px] uppercase tracking-[0.3em] text-amber-300/85">From sentence to board</span>
      <h2 className="font-headline text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mt-3 mb-10">"Pawns can move backward."</h2>
      <Pipeline steps={[
        { label: "prompt", title: "Free-form text", sub: '"Pawns can move backward."' },
        { label: "Gemini Flash", title: "Strict JSON schema", sub: "+ 7 worked examples" },
        { label: "validator", title: "Structure / FEN / king safety" },
        { label: "play", title: "Live", emphasis: true },
      ]} />
      <div className="grid md:grid-cols-2 gap-6 mt-10">
        <div>
          <span className="font-headline font-bold text-[10px] uppercase tracking-[0.3em] text-on-surface-variant/55 block mb-2">What the AI returns</span>
          <pre className="font-mono text-[11px] leading-[1.6] bg-surface-container-lowest border border-white/[0.05] p-4 overflow-x-auto whitespace-pre text-on-surface-variant">
{`{
  "extends": "vanilla",
  "name": "Reverse Pawns",
  "pieces": {
    "p": {
      "moves": [
        // vanilla pawn moves...
        {
          "kind": "step",
          "dirs": [[0, -1]],
          "conditions": { "onlyNonCapture": true }
        }
      ]
    }
  }
}`}
          </pre>
        </div>
        <div className="space-y-2">
          <span className="font-headline font-bold text-[10px] uppercase tracking-[0.3em] text-on-surface-variant/55 block mb-2">Engine reads it as</span>
          <div className="bg-surface-low border border-white/10 p-3 flex items-center gap-3">
            <span className="text-amber-300 font-bold text-base w-6 text-center">&darr;</span>
            <p className="text-sm"><span className="font-bold">step</span> <span className="font-mono text-xs text-outline">[0, -1]</span> &mdash; one square backward</p>
          </div>
          <div className="bg-surface-low border border-white/10 p-3 flex items-center gap-3">
            <span className="text-amber-300 font-bold text-base w-6 text-center">&times;</span>
            <p className="text-sm"><span className="font-bold">onlyNonCapture</span> &mdash; no diagonal-back captures</p>
          </div>
          <div className="bg-surface-low border border-white/10 p-3 flex items-center gap-3">
            <span className="text-amber-300 font-bold text-base w-6 text-center">+</span>
            <p className="text-sm">added to existing forward / capture / first-move steps</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Slide4Variants() {
  return (
    <div className="anim-fade-up max-w-7xl w-full mx-auto">
      <span className="font-headline font-bold text-[10px] uppercase tracking-[0.3em] text-amber-300/85">Four variants</span>
      <h2 className="font-headline text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mt-3 mb-8">Different rules. Same engine.</h2>
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
        <VariantCard
          name="Royal Center"
          prompt='"Kings start in the middle"'
          fen="rnbq1bnr/pppppppp/8/3k4/8/4K3/PPPPPPPP/RNBQ1BNR w - - 0 1"
          highlights={{ ...tint("d5", "target"), ...tint("e3", "target") }}
        />
        <VariantCard
          name="Knight Storm"
          prompt='"Knights leap twice as far"'
          fen="4k3/8/8/8/3N4/8/8/4K3 w - - 0 1"
          highlights={{
            ...tint("d4", "from"),
            // Standard knight targets (from d4):
            ...multiTint(["b5", "f5", "b3", "f3", "c2", "e2", "c6", "e6"], "target"),
            // Variant: extended hops (offsets like [3,3], [4,2], etc.).
            // Computed targets that land on the board from d4.
            ...multiTint(["a1", "g1", "h2", "h6", "g7", "f8", "b8", "a7"], "from"),
          }}
        />
        <VariantCard
          name="Three Strikes"
          prompt='"First to 3 captures wins"'
          fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
          captureCount={3}
        />
        <VariantCard
          name="King Race"
          prompt='"First king to the 8th rank"'
          fen="rnbq1bnr/pppppppp/8/8/4K3/8/PPPP1PPP/RNBQ1BNR w - - 0 1"
          highlights={{
            ...tint("e4", "from"),
            ...tint("e8", "target"),
          }}
        />
      </div>
    </div>
  );
}

function VariantCard({ name, prompt, fen, highlights, captureCount }) {
  return (
    <div className="space-y-2">
      <StaticBoard fen={fen} highlights={highlights} size="md" />
      {captureCount && (
        <div className="flex justify-center gap-1 -mt-1">
          {Array.from({ length: captureCount }).map((_, i) => (
            <span key={i} className="w-3 h-3 bg-amber-300" aria-hidden="true" />
          ))}
        </div>
      )}
      <p className="font-headline font-bold text-sm tracking-tight">{name}</p>
      <p className="font-mono text-[10px] text-outline">{prompt}</p>
    </div>
  );
}

/**
 * Example sequence: a clean Knight Storm tactic. Stylized
 * minimal position so the variant's extended-leap is the only
 * thing on screen - no opening clutter to obscure the idea.
 *
 * The leap from a5 to d8 is offset [+3, +3], one of the
 * variant's extended-hop offsets. Black recaptures with the
 * king but white came out a queen for a knight ahead.
 */
const KNIGHT_STORM_GAME = [
  {
    fen: "3qk3/8/8/N7/8/8/8/K7 w - - 0 1",
    highlights: {
      ...tint("a5", "from"),
      ...multiTint(["a1", "d8", "g7"], "target"),
    },
    note: "Knight Storm: a knight can take a normal hop OR an extended one, two knight-moves away.",
  },
  {
    fen: "3qk3/8/8/N7/8/8/8/K7 w - - 0 1",
    highlights: {
      ...tint("a5", "from"),
      ...tint("d8", "target"),
    },
    note: "From a5, the variant lets the knight leap straight to d8 \u2014 right where the queen sits.",
  },
  {
    fen: "3Nk3/8/8/8/8/8/8/K7 b - - 0 1",
    highlights: {
      ...tint("a5", "from"),
      ...tint("d8", "to"),
    },
    note: "Nxd8. Queen captured in one move. Black has only the king to respond.",
  },
  {
    fen: "3k4/8/8/8/8/8/8/K7 w - - 0 2",
    highlights: {
      ...tint("e8", "from"),
      ...tint("d8", "to"),
    },
    note: "Kxd8. White lost a knight, won a queen. +6 material.",
  },
];

function Slide5ExampleGame() {
  const [step, setStep] = useState(0);
  const total = KNIGHT_STORM_GAME.length;
  const current = KNIGHT_STORM_GAME[step];
  const next = useCallback(() => setStep((s) => Math.min(total - 1, s + 1)), [total]);
  const prev = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);

  return (
    <div className="anim-fade-up max-w-7xl w-full mx-auto">
      <span className="font-headline font-bold text-[10px] uppercase tracking-[0.3em] text-amber-300/85">Example &mdash; Knight Storm</span>
      <h2 className="font-headline text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mt-3 mb-8">
        Knight takes queen.
      </h2>
      <div className="grid md:grid-cols-[1fr_minmax(280px,360px)] gap-10 items-start">
        <div className="flex justify-center">
          <StaticBoard fen={current.fen} highlights={current.highlights} size="lg" />
        </div>
        <div className="space-y-4">
          <div className="flex items-baseline justify-between">
            <span className="font-headline font-extrabold text-3xl text-primary tabular-nums">
              {String(step + 1).padStart(2, "0")}
            </span>
            <span className="font-mono text-[11px] text-outline">/ {String(total).padStart(2, "0")}</span>
          </div>
          <p className="text-sm text-on-surface-variant/80 leading-relaxed min-h-[5.5rem]">
            {current.note}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={prev}
              disabled={step === 0}
              className="px-3 py-2 bg-surface-low border border-white/10 font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/65 hover:text-primary hover:border-primary/30 transition-colors disabled:opacity-30 disabled:hover:text-on-surface-variant/65 disabled:hover:border-white/10"
            >
              &larr; prev
            </button>
            <button
              type="button"
              onClick={next}
              disabled={step === total - 1}
              className="flex-1 px-3 py-2 bg-primary text-on-primary font-headline text-[10px] font-bold uppercase tracking-widest hover:opacity-90 transition-opacity disabled:opacity-30"
            >
              next &rarr;
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Bridge slide between the Arena half and the Anki half. Tag-
 * line only; the visual is four mini boards of the SAME
 * position separated by growing intervals (Day 1 / 4 / 11 /
 * 27). The "show don't tell" idea: spaced repetition is just
 * a card showing up again, later.
 */
const SR_DEMO_FEN = "r1bqk2r/pp2nppp/2n1p3/3pP3/3P4/2NB1N2/PP3PPP/R1BQK2R w KQkq - 0 1";
const SR_REPS = [
  { label: "Day 1",  delta: "first review" },
  { label: "Day 4",  delta: "+3" },
  { label: "Day 11", delta: "+7" },
  { label: "Day 27", delta: "+16" },
];

function Slide6Transition() {
  return (
    <div className="anim-fade-up max-w-7xl w-full mx-auto">
      <span className="font-headline font-bold text-[10px] uppercase tracking-[0.3em] text-amber-300/85">
        Section 02
      </span>
      <h2 className="font-headline text-4xl md:text-6xl font-extrabold tracking-tighter text-primary leading-[0.9] mt-3 mb-12">
        Now: train.
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {SR_REPS.map((r, i) => (
          <div key={i} className="space-y-2">
            <StaticBoard
              fen={SR_DEMO_FEN}
              highlights={tint("f6", "from")}
              size="md"
            />
            <div className="flex items-baseline justify-between">
              <span className="font-headline font-bold text-sm text-primary">{r.label}</span>
              <span className="font-mono text-[10px] text-outline">{r.delta}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="font-mono text-[11px] text-outline mt-8 text-center">
        same card. growing intervals.
      </p>
    </div>
  );
}

function Slide7AnkiIntro() {
  return (
    <div className="anim-fade-up max-w-7xl w-full mx-auto grid md:grid-cols-2 gap-12 items-center">
      <div>
        <span className="font-headline font-bold text-[10px] uppercase tracking-[0.3em] text-amber-300/85">Anki review</span>
        <h2 className="font-headline text-4xl md:text-6xl font-extrabold tracking-tighter text-primary leading-[0.9] mt-3 mb-8">
          Your blunders.<br/>Your flashcards.
        </h2>
        <div className="grid grid-cols-3 gap-2 max-w-sm">
          <Numbered n={1} label="import" />
          <Numbered n={2} label="analyze" />
          <Numbered n={3} label="repeat" />
        </div>
      </div>
      <div className="flex justify-center">
        <StaticBoard
          fen="r1bqk2r/pp2nppp/2n1p3/3pP3/3P4/2NB1N2/PP3PPP/R1BQK2R w KQkq - 0 1"
          highlights={{
            ...tint("f6", "from"),
            ...tint("d5", "target"),
            ...tint("e5", "target"),
          }}
          size="lg"
        />
      </div>
    </div>
  );
}

function Numbered({ n, label }) {
  return (
    <div className="bg-surface-low border border-white/10 p-3">
      <div className="font-headline font-extrabold text-2xl text-primary">{n}</div>
      <div className="text-[10px] uppercase tracking-widest text-on-surface-variant/50 mt-1">{label}</div>
    </div>
  );
}

function Slide8Anki() {
  return (
    <div className="anim-fade-up max-w-7xl w-full mx-auto">
      <span className="font-headline font-bold text-[10px] uppercase tracking-[0.3em] text-amber-300/85">How a card is born</span>
      <h2 className="font-headline text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mt-3 mb-10">From your game to a flashcard.</h2>
      <Pipeline steps={[
        { label: "import", title: "Lichess + Chess.com" },
        { label: "Stockfish d12", title: "eval \u0394" },
        { label: "threshold", title: "drop \u2265 100 cp" },
        { label: "card", title: "queued", emphasis: true },
      ]} />
      <div className="grid md:grid-cols-2 gap-8 mt-12 items-start">
        <StaticBoard
          fen="r1bqk2r/pp2nppp/2n1p3/3pP3/3P4/2NB1N2/PP3PPP/R1BQK2R w KQkq - 0 1"
          highlights={{
            ...tint("f6", "from"),
            ...tint("d5", "target"),
            ...tint("e5", "target"),
          }}
          size="lg"
        />
        <pre className="font-mono text-[11px] leading-[1.6] bg-surface-container-lowest border border-white/[0.05] p-4 overflow-x-auto whitespace-pre text-on-surface-variant">
{`{
  "type": "mistake",
  "played_san": "Nxe5",
  "best_san": "Nxd5",
  "eval_loss_cp": 185,
  "source": "lichess"
}`}
        </pre>
      </div>
    </div>
  );
}

function Slide9End() {
  const navigate = useNavigate();
  return (
    <div className="anim-fade-up text-center w-full relative">
      <div className="absolute right-[-5%] top-1/2 -translate-y-1/2 pointer-events-none select-none font-headline font-black text-[16rem] leading-[0.85] text-white/[0.025]">
        END
      </div>
      <span className="font-headline font-bold text-[10px] uppercase tracking-[0.3em] text-on-surface-variant/55">oChess</span>
      <h2 className="font-headline text-6xl md:text-8xl font-extrabold tracking-tighter text-primary mt-4">Play it.</h2>
      <button
        onClick={() => navigate("/arena")}
        className="inline-flex items-center gap-3 mt-12 px-7 py-4 bg-primary text-on-primary font-headline font-bold text-sm uppercase tracking-widest hover:opacity-90 transition-opacity"
      >
        Open Arena &rarr;
      </button>
    </div>
  );
}

const SLIDES = [
  Slide1Title,
  Slide2WhatIsArena,
  Slide3Pipeline,
  Slide4Variants,
  Slide5ExampleGame,
  Slide6Transition,
  Slide7AnkiIntro,
  Slide8Anki,
  Slide9End,
];
