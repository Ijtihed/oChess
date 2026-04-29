import { useState, useEffect, useCallback, useRef } from "react";
import {
  COMMON_WEAKNESS_CHIPS,
  filterCardsByQuery,
} from "../lib/study-plan";
import { generateAIDecks, isAIAvailable } from "../lib/coach-llm";
import { addDrillSet, countDrillSetCards, saveDrillSets } from "../lib/drill-sets";

/**
 * AIDeckSheet - right-side sheet that hosts the AI deck
 * generator. Pulled out of the old StudyPlanPanel so the Today
 * deck browser can launch it from a single "+ Generate AI decks"
 * button without dragging the whole panel along.
 *
 * Flow:
 *   1. User opens the sheet from the deck browser.
 *   2. Optional free-text query in the search field steers the AI.
 *   3. "Generate" sends the user's mistake corpus + the query to
 *      the coach Edge Function and returns 1-3 proposed decks.
 *   4. Each proposed deck has Save / Practice now buttons; saving
 *      writes a coach-tagged drill set into the shared drill sets
 *      store, which the deck browser picks up automatically on
 *      its next render.
 *
 * The sheet animates in from the right and traps focus while
 * open. Close via the X, the backdrop, or Escape.
 */
export default function AIDeckSheet({
  open,
  onClose,
  cards,
  drillSets,
  onDrillSetsChange,
  onPracticeDeck,
}) {
  const [query, setQuery] = useState("");
  const [activeChip, setActiveChip] = useState(null);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [savedIdx, setSavedIdx] = useState(new Set());
  const [cooldownSec, setCooldownSec] = useState(0);
  const [usage, setUsage] = useState(null);

  // Reset everything when the sheet closes so the next open lands
  // on a clean form. Previously we kept `query` / `activeChip`
  // around as a "don't lose what the user typed" affordance, but
  // it had a worse failure mode: if the user generated decks for
  // query A, clicked Practice on a result (which closes the
  // sheet), then later reopened the sheet, the stale preview from
  // A was still there until they clicked Generate again.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveChip(null);
      setLoading(false);
      setResults(null);
      setError(null);
      setSavedIdx(new Set());
      setUsage(null);
    }
  }, [open]);

  // Cooldown countdown ticks down once per second while a 429 is
  // active. The Generate button shows the remaining seconds
  // instead of being just-disabled so the user knows when to
  // retry.
  useEffect(() => {
    if (cooldownSec <= 0) return undefined;
    const t = setTimeout(() => setCooldownSec((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldownSec]);

  // Escape key closes the sheet. Backdrop click is wired below.
  // Both share the same onClose so external state stays in sync.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Trap a focusable element on open so keyboard users land
  // inside the sheet rather than on the page behind it.
  const inputRef = useRef(null);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const matchCountForQuery = useCallback((q) => {
    if (!q) return 0;
    return countDrillSetCards({ query: q, chipId: null }, cards, {
      chipFor: (id) => COMMON_WEAKNESS_CHIPS.find((c) => c.id === id),
      queryFilter: filterCardsByQuery,
    });
  }, [cards]);

  const generate = useCallback(async () => {
    if (cooldownSec > 0) return;
    setLoading(true);
    setError(null);
    setResults(null);
    setSavedIdx(new Set());
    try {
      const mistakes = cards
        .filter((c) => c.type === "mistake" || c.type === "puzzle")
        .slice(0, 30);
      if (mistakes.length === 0) {
        setError("Run an import first - the AI needs at least one mistake to work from.");
        return;
      }
      const result = await generateAIDecks({ mistakes, query });
      if (!result.ok) {
        if (result.rateLimited) {
          setCooldownSec(Math.max(1, result.retryAfterSeconds || 0));
          setUsage({
            callsInWindow: result.callsInWindow || 0,
            maxCalls: result.maxCalls || 0,
            windowSeconds: result.windowSeconds || 0,
          });
          setError(null);
          return;
        }
        setError(result.error || "AI unavailable.");
        return;
      }
      setResults(result);
      if (result.rateLimit) setUsage(result.rateLimit);
    } catch (e) {
      setError(e?.message || "AI unavailable.");
    } finally {
      setLoading(false);
    }
  }, [cards, query, cooldownSec]);

  // Save a proposed deck as a coach-tagged drill set so it shows
  // up under "My decks" in the browser. Returns the saved drill
  // id (or null if save was rejected) so callers that need the
  // post-save state can chain on it - notably `practiceProposedDeck`
  // below, which both saves and immediately drops the user into
  // a session for the new deck.
  const saveProposedDeck = useCallback((deck, idx) => {
    if (!deck?.query || !deck?.name) return null;
    const { sets, id } = addDrillSet(drillSets, {
      name: deck.name,
      query: deck.query,
      source: "coach",
      summary: deck.summary || "",
    });
    if (!id) return null;
    onDrillSetsChange?.(sets);
    saveDrillSets(sets);
    setSavedIdx((prev) => {
      const next = new Set(prev);
      next.add(idx);
      return next;
    });
    return id;
  }, [drillSets, onDrillSetsChange]);

  // Practice now both SAVES and starts the session. Users
  // expected the deck they just played to show up under "My
  // decks" afterwards, but the previous version started an
  // ephemeral session without persisting - so the AI proposal
  // disappeared the moment the session ended. Now Practice = Save
  // + Start, and the saved-checkmark stays on the row in case
  // the user backs out of the session and reopens the sheet.
  const practiceProposedDeck = useCallback((deck, idx) => {
    if (!deck?.query || !deck?.name) return;
    saveProposedDeck(deck, idx);
    onPracticeDeck?.({ query: deck.query, chipId: null, setName: deck.name });
    onClose?.();
  }, [saveProposedDeck, onPracticeDeck, onClose]);

  if (!open) return null;
  if (!isAIAvailable()) {
    // Defensive - the browser button shouldn't render when AI
    // isn't reachable, but if someone forces the sheet open
    // anyway show a clear "not available" state instead of a
    // broken Generate button.
    return (
      <SheetShell onClose={onClose}>
        <p className="text-sm text-on-surface-variant/55 leading-relaxed">
          AI deck generation isn&apos;t available right now. Sign in or check your connection,
          then try again.
        </p>
      </SheetShell>
    );
  }

  return (
    <SheetShell onClose={onClose}>
      {/* Search + chips. The free-text query is the AI's primary
          steering input; chips are a quick-filter shortcut for
          common mistake patterns. */}
      <div className="space-y-3">
        <div>
          <label className="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant/40 block mb-1.5">
            What kind of mistakes?
          </label>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. hanging queens in the najdorf"
            className="w-full bg-surface-container border border-white/[0.06] px-3 py-2.5 text-[13px] text-on-surface placeholder:text-on-surface-variant/30 outline-none focus:border-primary/40"
            onKeyDown={(e) => { if (e.key === "Enter") generate(); }}
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {COMMON_WEAKNESS_CHIPS.map((chip) => (
            <button key={chip.id}
              onClick={() => {
                const next = activeChip === chip.id ? null : chip.id;
                setActiveChip(next);
                if (next) setQuery((q) => q ? q : chip.label.toLowerCase());
              }}
              className={`px-2.5 py-1 font-headline text-[10px] font-bold uppercase tracking-wide transition-colors ${
                activeChip === chip.id
                  ? "bg-primary text-on-primary"
                  : "bg-surface-container border border-white/[0.04] text-on-surface-variant/55 hover:text-primary hover:bg-surface-high"
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>

        {(() => {
          // Recompute cheap source check on every render so the
          // button enables itself the moment a freshly-imported
          // batch lands in the parent's `cards` prop.
          const hasSource = cards.some(
            (c) => c?.type === "mistake" || c?.type === "puzzle",
          );
          return (
            <>
              <button onClick={generate}
                disabled={loading || cooldownSec > 0 || !hasSource}
                className="btn btn-primary w-full py-3 text-sm disabled:opacity-30 disabled:pointer-events-none">
                {loading
                  ? "Loading\u2026 building decks"
                  : cooldownSec > 0
                    ? `Wait ${cooldownSec}s`
                    : "Generate decks"}
              </button>
              {!hasSource && (
                <p className="text-[11px] text-on-surface-variant/45 leading-snug">
                  No mistake or puzzle cards yet. Import a few games or fail a puzzle first &mdash; the AI builds decks by slicing those.
                </p>
              )}
            </>
          );
        })()}

        {/* Status line. Priority order: error \u2192 cooldown
            \u2192 quiet usage. Empty when idle so the sheet stays
            calm. */}
        {(error || cooldownSec > 0 || usage?.maxCalls > 0) && (
          <p className={`text-[11px] leading-snug ${
            error ? "text-error/80"
              : cooldownSec > 0 ? "text-amber-400/80"
              : "text-on-surface-variant/35"
          }`}>
            {error
              ? error
              : cooldownSec > 0
                ? `AI cooldown - wait ${cooldownSec}s before another request`
                : `${usage.callsInWindow}/${usage.maxCalls} AI calls in last ${Math.round(usage.windowSeconds / 60)} min`}
          </p>
        )}
      </div>

      {/* Result preview. Skeleton while loading, deck rows when
          results land, hidden otherwise. */}
      {loading && <PreviewSkeleton />}
      {!loading && results && Array.isArray(results.decks) && (
        <Preview
          results={results}
          savedIdx={savedIdx}
          matchCountForQuery={matchCountForQuery}
          onSave={saveProposedDeck}
          onPractice={practiceProposedDeck}
        />
      )}
    </SheetShell>
  );
}

function SheetShell({ onClose, children }) {
  return (
    <div className="fixed inset-0 z-50">
      <div onClick={onClose}
        className="absolute inset-0 bg-black/60 anim-fade-up"
        style={{ "--delay": "0s" }}
      />
      <aside
        role="dialog"
        aria-label="AI deck generator"
        className="absolute right-0 top-0 bottom-0 w-full sm:w-[420px] bg-surface border-l border-white/[0.06] shadow-2xl flex flex-col anim-fade-up"
        style={{ "--delay": "0.05s" }}
      >
        <header className="px-5 py-4 border-b border-white/[0.04] flex items-center justify-between gap-3 shrink-0">
          <div>
            <h2 className="font-headline text-base font-extrabold tracking-tighter text-primary">
              Generate AI decks
            </h2>
            <p className="text-[11px] text-on-surface-variant/40 mt-0.5">
              The coach reads your mistakes and proposes focused decks.
            </p>
          </div>
          <button onClick={onClose}
            title="Close"
            className="w-8 h-8 flex items-center justify-center text-on-surface-variant/45 hover:text-primary transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {children}
        </div>
      </aside>
    </div>
  );
}

function PreviewSkeleton() {
  return (
    <div className="anim-fade-up p-4 bg-surface-low border border-primary/20 space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-primary/80">
          Loading&hellip; AI is reading your cards
        </h3>
        <span className="text-[10px] text-on-surface-variant/30 tabular-nums">Usually 3-5s</span>
      </div>
      <div className="h-3 w-3/4 bg-surface-container animate-pulse" />
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="px-3 py-2.5 bg-surface-container border border-white/[0.04] space-y-1.5">
            <div className="flex items-baseline justify-between">
              <div className="h-3 w-1/3 bg-surface-low animate-pulse" />
              <div className="h-2 w-12 bg-surface-low animate-pulse" />
            </div>
            <div className="h-2 w-full bg-surface-low animate-pulse" />
            <div className="h-2 w-5/6 bg-surface-low animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}

function Preview({ results, savedIdx, matchCountForQuery, onSave, onPractice }) {
  return (
    <div className="anim-fade-up p-4 bg-surface-low border border-primary/20 space-y-3">
      <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-primary/80">
        AI suggested decks
      </h3>
      {results.summary && (
        <p className="text-[12px] text-on-surface-variant/75 leading-relaxed">{results.summary}</p>
      )}
      {results.decks.length === 0 ? (
        <p className="text-[11px] text-on-surface-variant/45 leading-relaxed">
          Couldn&apos;t pick a focused deck. Try rephrasing.
        </p>
      ) : (
        <div className="space-y-2">
          {results.decks.map((deck, idx) => {
            const matchCount = matchCountForQuery(deck.query);
            const saved = savedIdx.has(idx);
            const hasMatches = matchCount > 0;
            return (
              <div key={idx} className="px-3 py-2.5 bg-surface-container border border-white/[0.04]">
                <div className="flex items-baseline justify-between mb-1 gap-2">
                  <span className="font-headline text-[13px] font-bold text-primary truncate">
                    {deck.name}
                  </span>
                  <span className={`text-[10px] tabular-nums shrink-0 ${hasMatches ? "text-on-surface-variant/55" : "text-amber-400/70"}`}>
                    {matchCount} card{matchCount === 1 ? "" : "s"}
                  </span>
                </div>
                {deck.summary && (
                  <p className="text-[12px] text-on-surface-variant/55 leading-relaxed mb-2">{deck.summary}</p>
                )}
                <div className="flex gap-1.5">
                  {saved ? (
                    <span className="btn flex-1 py-1.5 text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                      Saved
                    </span>
                  ) : (
                    <>
                      <button onClick={() => onPractice(deck, idx)}
                        disabled={!hasMatches}
                        className="btn btn-primary flex-1 py-1.5 text-[10px] disabled:opacity-30 disabled:pointer-events-none">
                        Practice now
                      </button>
                      <button onClick={() => onSave(deck, idx)}
                        className="btn btn-secondary flex-1 py-1.5 text-[10px]">
                        {hasMatches ? "Save deck" : "Save for later"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
