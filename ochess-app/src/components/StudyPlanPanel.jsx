import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useAuth } from "./AuthProvider";
import { fetchChesscomGames, fetchLichessGames } from "../lib/game-import";
import { Chess } from "chess.js";
import {
  analyzeGameForMistakes,
  buildWeaknessProfile,
  filterCardsByQuery,
  COMMON_WEAKNESS_CHIPS,
  buildDailyPlan,
  planCacheKey,
} from "../lib/study-plan";
import {
  loadCards,
  saveCards,
  cardId,
  loadSchedules,
} from "../lib/review-cards";
import { callCoach, isCoachAvailable } from "../lib/coach-llm";

/**
 * Plan tab — the "what should I work on?" surface.
 *
 * The flow is deliberately three-state:
 *
 *   1. Pre-import: explain, ask for source(s).
 *   2. Importing: fetch games, run Stockfish, append mistake cards
 *      to the existing review-card store.
 *   3. Built: weakness profile + filter + chips + queue + "Start".
 *
 * Each phase lives in this single component; the parent ReviewPage
 * just decides whether to mount us under the "Plan" tab. We never
 * touch the SM-2 review state directly — the cards we generate flow
 * back into the same `ochess_review_cards` storage the Today tab
 * already reads, so SM-2 scheduling is shared automatically.
 */
const SOURCE_GAME_LIMIT = 30;
const DAILY_QUOTA = 5;

const PHASE_LABELS = { opening: "Opening", middlegame: "Middlegame", endgame: "Endgame" };

function detectUserColor(pgn, chesscomUsername, lichessUsername) {
  // Prefer matching on whichever username is known. Fall back to
  // returning "w" so we still produce SOMETHING; for unknown side the
  // caller can skip if both color matches fail.
  const m = (re) => pgn.match(re)?.[1]?.toLowerCase() || "";
  const white = m(/\[White "(.+?)"\]/);
  const black = m(/\[Black "(.+?)"\]/);
  const candidates = [chesscomUsername, lichessUsername].filter(Boolean).map((s) => s.toLowerCase());
  for (const c of candidates) {
    if (white === c) return "w";
    if (black === c) return "b";
  }
  return null;
}

export default function StudyPlanPanel({ onStartSession }) {
  const { profile } = useAuth();
  const cc = profile?.chesscom_username?.trim() || "";
  const li = profile?.lichess_username?.trim() || "";

  // Source selection. If both are configured, default to BOTH. The
  // user can untoggle either before clicking "Analyze". If only one
  // is set, that one is the only option.
  const [useChesscom, setUseChesscom] = useState(!!cc);
  const [useLichess,  setUseLichess]  = useState(!!li);

  // Re-sync source defaults when the profile loads.
  useEffect(() => {
    setUseChesscom(!!cc);
    setUseLichess(!!li);
  }, [cc, li]);

  const [phase, setPhase] = useState("ready"); // ready | importing | analyzing | built | error
  const [progress, setProgress] = useState({ source: "", fetched: 0, total: 0, analyzed: 0, totalMoves: 0, gameIdx: 0, gameCount: 0 });
  const [err, setErr] = useState(null);
  const abortRef = useRef(null);

  // Card store — re-read on every build/refresh so the Today tab and
  // this tab stay in lockstep.
  const [allCards, setAllCards] = useState(() => loadCards());
  const [schedules] = useState(() => loadSchedules());

  // Filter UI state.
  const [query, setQuery] = useState("");
  const [activeChip, setActiveChip] = useState(null);

  // AI Coach state — populated by the Edge Function call. Stored
  // alongside the cards so a user reading the plan and switching
  // tabs doesn't lose what the LLM said. Cleared explicitly when the
  // user re-analyzes (the corpus may have shifted) or when they hit
  // the regenerate button.
  const [coachLoading, setCoachLoading] = useState(false);
  const [coachData, setCoachData] = useState(null);
  const [coachError, setCoachError] = useState(null);

  const profileWeakness = useMemo(() => buildWeaknessProfile(allCards), [allCards]);

  const filteredCards = useMemo(() => {
    let pool = allCards.filter((c) => c.type === "mistake" || c.type === "puzzle");
    if (activeChip) {
      const chip = COMMON_WEAKNESS_CHIPS.find((c) => c.id === activeChip);
      if (chip) pool = pool.filter(chip.match);
    }
    if (query) pool = filterCardsByQuery(pool, query);
    return pool;
  }, [allCards, query, activeChip]);

  const todayPlan = useMemo(
    () => buildDailyPlan(allCards, schedules, { quota: DAILY_QUOTA, query, chipId: activeChip }),
    [allCards, schedules, query, activeChip]
  );

  const cancelImport = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("ready");
  }, []);

  const generateAICoach = useCallback(async () => {
    setCoachLoading(true);
    setCoachError(null);
    try {
      // Send the mistakes that match the *current filter* — that way
      // a user who chipped "Endgame" gets an endgame-specific plan,
      // not a generic one. If nothing's filtered, send the full
      // mistake corpus (capped at 30 server-side).
      const mistakes = (filteredCards.length > 0 ? filteredCards : allCards)
        .filter((c) => c.type === "mistake" || c.type === "puzzle")
        .slice(0, 30);
      if (mistakes.length === 0) {
        setCoachError("No mistake cards to coach yet. Run analysis first.");
        return;
      }
      const result = await callCoach({ mistakes, query, dailyQuota: 5 });
      if (!result.ok) {
        setCoachError(result.error || "Coach unavailable.");
        return;
      }
      setCoachData(result);
    } catch (e) {
      setCoachError(e?.message || "Coach unavailable.");
    } finally {
      setCoachLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredCards, allCards, query]);

  const dismissCoach = useCallback(() => {
    setCoachData(null);
    setCoachError(null);
  }, []);

  const runImport = useCallback(async () => {
    if (!useChesscom && !useLichess) {
      setErr("Pick at least one source — chess.com or lichess.");
      return;
    }
    setErr(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase("importing");
    setProgress({ source: useChesscom ? "chess.com" : "lichess", fetched: 0, total: 0, analyzed: 0, totalMoves: 0, gameIdx: 0, gameCount: 0 });

    try {
      const games = [];
      if (useChesscom && cc) {
        setProgress((p) => ({ ...p, source: "chess.com", fetched: 0 }));
        const ccGames = await fetchChesscomGames(cc, {
          signal: ctrl.signal,
          max: SOURCE_GAME_LIMIT,
          onProgress: (n) => setProgress((p) => ({ ...p, fetched: n })),
        });
        games.push(...ccGames);
      }
      if (useLichess && li && !ctrl.signal.aborted) {
        setProgress((p) => ({ ...p, source: "lichess", fetched: 0 }));
        const liGames = await fetchLichessGames(li, {
          signal: ctrl.signal,
          max: SOURCE_GAME_LIMIT,
          onProgress: (n) => setProgress((p) => ({ ...p, fetched: n })),
        });
        games.push(...liGames);
      }
      if (ctrl.signal.aborted) return;

      // Move into analysis phase. We process games sequentially so
      // Stockfish doesn't fight itself for CPU.
      setPhase("analyzing");
      setProgress((p) => ({ ...p, gameCount: games.length, gameIdx: 0 }));

      const newCards = [];
      const seen = new Set(allCards.map((c) => c.id).filter(Boolean));

      for (let i = 0; i < games.length; i++) {
        if (ctrl.signal.aborted) break;
        const g = games[i];
        const userColor = detectUserColor(g.pgn, cc, li);
        if (!userColor) continue;

        setProgress((p) => ({ ...p, gameIdx: i + 1, analyzed: 0, totalMoves: 0 }));

        const mistakes = await analyzeGameForMistakes(g.pgn, userColor, {
          signal: ctrl.signal,
          onProgress: (n, total) => setProgress((p) => ({ ...p, analyzed: n, totalMoves: total })),
          gameMeta: {
            source: g.source,
            id: g.id,
            gameId: g.id,
            opening: g.opening,
            url: g.url,
          },
        });
        for (const m of mistakes) {
          if (!seen.has(m.id)) {
            newCards.push(m);
            seen.add(m.id);
          }
        }
      }

      if (newCards.length > 0) {
        const merged = [...allCards, ...newCards];
        saveCards(merged);
        setAllCards(merged);
      } else {
        setAllCards(loadCards());
      }

      setPhase("built");
    } catch (e) {
      if (e?.name === "AbortError") return;
      setErr(e?.message || "Something went wrong while building your plan.");
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  }, [useChesscom, useLichess, cc, li, allCards]);

  // Auto-pick the right starting state: if there's no source AND no
  // existing mistake cards, show the empty-empty state. If there are
  // already cards, jump straight to "built".
  useEffect(() => {
    if (phase === "ready" && profileWeakness.total > 0) setPhase("built");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const noSourcesAtAll = !cc && !li;
  const hasAnyMistakes = profileWeakness.total > 0;

  // ── Rendering ──

  if (phase === "importing" || phase === "analyzing") {
    const pctImport = progress.total > 0 ? Math.min(100, (progress.fetched / progress.total) * 100) : null;
    const pctAnalyze = progress.totalMoves > 0 ? (progress.analyzed / progress.totalMoves) * 100 : 0;
    return (
      <div className="anim-fade-up p-6 bg-surface-low border border-white/[0.04]">
        <h3 className="font-headline text-sm font-bold uppercase tracking-widest text-primary mb-3">
          {phase === "importing" ? "Fetching games" : "Finding your mistakes"}
        </h3>
        {phase === "importing" ? (
          <p className="text-[13px] text-on-surface-variant/55 mb-4">
            Pulling from {progress.source}… <span className="text-on-surface-variant/80 font-bold">{progress.fetched}</span> games loaded.
          </p>
        ) : (
          <>
            <p className="text-[13px] text-on-surface-variant/55 mb-1">
              Game <span className="text-on-surface-variant/80 font-bold">{progress.gameIdx}</span> of {progress.gameCount}.
            </p>
            <p className="text-[12px] text-on-surface-variant/40 mb-4">
              Analyzed {progress.analyzed} / {progress.totalMoves} moves in this game.
            </p>
          </>
        )}
        <div className="h-1.5 bg-surface-high overflow-hidden mb-4">
          <div
            className="h-full bg-primary transition-all duration-150"
            style={{ width: `${pctAnalyze || pctImport || 5}%` }}
          />
        </div>
        <button onClick={cancelImport}
          className="btn btn-secondary px-4 py-2 text-xs">
          Cancel
        </button>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="anim-fade-up p-6 bg-error/10 border border-error/20">
        <h3 className="font-headline text-sm font-bold uppercase tracking-widest text-error mb-2">Couldn't build the plan</h3>
        <p className="text-[13px] text-on-surface-variant/60 mb-4">{err}</p>
        <button onClick={() => { setErr(null); setPhase("ready"); }}
          className="btn btn-secondary px-4 py-2 text-xs">
          Try again
        </button>
      </div>
    );
  }

  // The "no sources, no cards" cold-empty case.
  if (noSourcesAtAll && !hasAnyMistakes) {
    return (
      <div className="anim-fade-up p-6 bg-surface-low border border-white/[0.04] text-center">
        <h3 className="font-headline text-base font-bold text-primary mb-2">Connect a chess account first</h3>
        <p className="text-[13px] text-on-surface-variant/55 max-w-md mx-auto leading-relaxed mb-4">
          Add your chess.com or Lichess username on your{" "}
          <a href="/profile" className="text-primary hover:underline font-bold">profile</a>{" "}
          and oChess will pull your recent games, find positions where you make recurring mistakes,
          and turn them into Anki cards organized by weakness.
        </p>
      </div>
    );
  }

  // Pre-build state: usernames present, no mistakes yet.
  if (!hasAnyMistakes && phase === "ready") {
    return (
      <div className="anim-fade-up space-y-5">
        <div className="p-5 bg-surface-low border border-white/[0.04]">
          <h3 className="font-headline text-base font-bold text-primary mb-2">Build your study plan</h3>
          <p className="text-[13px] text-on-surface-variant/55 leading-relaxed mb-4">
            We'll pull your last {SOURCE_GAME_LIMIT} games per source, run Stockfish on your moves to find
            positions where the eval dropped, and save each one as an Anki card you can drill.
            This usually takes ~1 minute per source.
          </p>
          {(cc && li) && (
            <div className="space-y-2 mb-4">
              <span className="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant/40 block">Sources</span>
              <SourceToggle label="chess.com" username={cc} active={useChesscom} onToggle={() => setUseChesscom((v) => !v)} />
              <SourceToggle label="Lichess"   username={li} active={useLichess}  onToggle={() => setUseLichess((v) => !v)} />
            </div>
          )}
          <button onClick={runImport}
            disabled={!useChesscom && !useLichess}
            className="btn btn-primary w-full py-3 text-sm">
            Analyze my games
          </button>
        </div>
      </div>
    );
  }

  // Built state — full plan UI.
  return (
    <div className="anim-fade-up space-y-5">
      {/* Weakness summary */}
      <div className="p-5 bg-surface-low border border-white/[0.04]">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/40">Your weakness profile</h3>
          <span className="text-[11px] text-on-surface-variant/30 tabular-nums">{profileWeakness.total} cards</span>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-4">
          {(["opening", "middlegame", "endgame"]).map((p) => (
            <div key={p} className="p-3 bg-surface-container border border-white/[0.03] text-center">
              <span className="font-headline text-2xl font-extrabold text-primary block">{profileWeakness.phaseCount[p] || 0}</span>
              <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/30">{PHASE_LABELS[p]}</span>
            </div>
          ))}
        </div>
        {profileWeakness.topThemes.length > 0 && (
          <div>
            <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/30 block mb-2">Most common themes</span>
            <div className="flex flex-wrap gap-1">
              {profileWeakness.topThemes.map(({ theme, count }) => (
                <span key={theme} className="px-2 py-1 bg-surface-container border border-white/[0.04] text-[11px] text-on-surface-variant/55">
                  {theme.replace(/_/g, " ")} <span className="text-on-surface-variant/30">{count}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* AI Coach — opt-in. Reads the user's mistake corpus and
          generates a natural-language plan via the `coach` Edge
          Function. The button appears even before generation; once
          we have a result we render summary + multi-day plan +
          per-card insights. */}
      {isCoachAvailable() && (
        <div className="p-5 bg-surface-low border border-primary/15">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-primary/80">AI Coach</h3>
            {coachData && (
              <button onClick={dismissCoach}
                className="text-[10px] uppercase tracking-widest text-on-surface-variant/40 hover:text-on-surface-variant/70 transition-colors">
                Dismiss
              </button>
            )}
          </div>

          {!coachData && !coachError && (
            <p className="text-[12px] text-on-surface-variant/50 mb-3 leading-relaxed">
              Ask a free Llama 3 model to read your mistakes, name your weakness in plain English,
              and write you a multi-day plan. Inference happens on a free Groq API tier through a
              Supabase Edge Function — no per-request cost.
            </p>
          )}
          {coachError && (
            <div className="p-3 bg-error/10 border border-error/20 text-[12px] text-error mb-3">
              {coachError}
            </div>
          )}

          {coachData && (
            <div className="space-y-4 mb-4">
              {coachData.summary && (
                <p className="text-[13px] text-on-surface leading-relaxed">{coachData.summary}</p>
              )}
              {Array.isArray(coachData.plan) && coachData.plan.length > 0 && (
                <div className="space-y-2">
                  <span className="text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40 block">
                    Multi-day plan
                  </span>
                  {coachData.plan.map((d) => (
                    <div key={d.day} className="px-3 py-2 bg-surface-container border border-white/[0.04]">
                      <div className="flex items-baseline justify-between mb-0.5">
                        <span className="font-headline text-[13px] font-bold text-primary">
                          Day {d.day} · {d.focus}
                        </span>
                        <span className="text-[10px] text-on-surface-variant/30 tabular-nums">{d.card_count} cards</span>
                      </div>
                      {d.explanation && (
                        <p className="text-[12px] text-on-surface-variant/55 leading-relaxed">{d.explanation}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {Array.isArray(coachData.insights) && coachData.insights.length > 0 && (
                <div className="space-y-1">
                  <span className="text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40 block">
                    Per-mistake notes
                  </span>
                  {coachData.insights.map((ins, i) => (
                    <p key={i} className="text-[12px] text-on-surface-variant/60 leading-relaxed">
                      <span className="text-on-surface-variant/30 tabular-nums">{ins.ply ?? i + 1}.</span>{" "}
                      {ins.insight}
                    </p>
                  ))}
                </div>
              )}
              {coachData.model && (
                <p className="text-[10px] text-on-surface-variant/20">via {coachData.model}</p>
              )}
            </div>
          )}

          <button onClick={generateAICoach}
            disabled={coachLoading}
            className="btn btn-primary w-full py-2.5 text-xs">
            {coachLoading ? "Thinking…" : coachData ? "Regenerate" : "Generate AI plan"}
          </button>
        </div>
      )}

      {/* Free-text + chip filters */}
      <div className="p-5 bg-surface-low border border-white/[0.04]">
        <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/40 mb-3">Drill what you want</h3>
        <p className="text-[12px] text-on-surface-variant/40 mb-3 leading-relaxed">
          Type a phrase like <span className="text-on-surface-variant/65 font-bold">endgame fork</span> or{" "}
          <span className="text-on-surface-variant/65 font-bold">hanging queen</span> to drill positions matching it. Or pick a chip:
        </p>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What kind of mistakes do you make?"
          className="w-full bg-surface-container border border-white/[0.06] px-3 py-2.5 text-[13px] text-on-surface placeholder:text-on-surface-variant/30 outline-none focus:border-primary/40 mb-3"
        />
        <div className="flex flex-wrap gap-1.5">
          {COMMON_WEAKNESS_CHIPS.map((chip) => (
            <button key={chip.id}
              onClick={() => setActiveChip(activeChip === chip.id ? null : chip.id)}
              className={`px-3 py-1.5 font-headline text-[11px] font-bold uppercase tracking-wide transition-colors ${
                activeChip === chip.id
                  ? "bg-primary text-on-primary"
                  : "bg-surface-container border border-white/[0.04] text-on-surface-variant/55 hover:text-primary hover:bg-surface-high"
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      {/* Today's queue */}
      <div className="p-5 bg-surface-container border border-primary/15">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-primary/70">Today&apos;s plan</h3>
          <span className="text-[11px] text-on-surface-variant/40 tabular-nums">
            {todayPlan.length} of {filteredCards.length} matches
          </span>
        </div>
        {todayPlan.length === 0 ? (
          <p className="text-[12px] text-on-surface-variant/40 leading-relaxed">
            No cards match this filter. Clear the filter or analyze more games.
          </p>
        ) : (
          <>
            <div className="space-y-1.5 mb-4">
              {todayPlan.map((c, i) => (
                <PlanCardRow key={c.id || `${c.type}-${i}`} card={c} index={i + 1} />
              ))}
            </div>
            <button onClick={() => onStartSession?.({ query, chipId: activeChip })}
              className="btn btn-primary w-full py-3 text-sm">
              Start session
            </button>
          </>
        )}
      </div>

      {/* Refresh */}
      <div className="p-4 bg-surface-low border border-white/[0.04] flex items-center justify-between gap-3">
        <span className="text-[12px] text-on-surface-variant/40">
          Played more games?
        </span>
        <button onClick={runImport}
          disabled={!useChesscom && !useLichess}
          className="btn btn-secondary px-4 py-2 text-[11px]">
          Re-analyze
        </button>
      </div>
    </div>
  );
}

function SourceToggle({ label, username, active, onToggle }) {
  return (
    <button onClick={onToggle}
      className={`w-full flex items-center justify-between px-3 py-2 transition-colors ${
        active ? "bg-primary/10 border border-primary/30" : "bg-surface-container border border-white/[0.04]"
      }`}
    >
      <span className="flex items-center gap-2">
        <span className={`w-3 h-3 ${active ? "bg-primary" : "bg-surface-high"}`} />
        <span className={`font-headline text-[12px] font-bold ${active ? "text-primary" : "text-on-surface-variant/50"}`}>{label}</span>
        <span className="text-[11px] text-on-surface-variant/35">@{username}</span>
      </span>
      <span className={`text-[10px] uppercase tracking-widest ${active ? "text-primary/60" : "text-on-surface-variant/25"}`}>
        {active ? "On" : "Off"}
      </span>
    </button>
  );
}

function PlanCardRow({ card, index }) {
  // Try to render a tiny preview of the position via the FEN.
  // For simplicity we just show a text summary; the user clicks
  // through to the actual review session.
  const phaseLabel = card.phase ? PHASE_LABELS[card.phase] || card.phase : "";
  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-surface-low border border-white/[0.03]">
      <span className="font-headline text-[10px] font-bold tabular-nums text-on-surface-variant/30 w-5">{index}.</span>
      <div className="flex-1 min-w-0">
        <span className="font-headline text-[12px] font-bold text-on-surface-variant/65 block truncate">
          {card.played_san ? `You played ${card.played_san}` : card.type === "puzzle" ? "Puzzle" : "Position"}
          {card.best_san ? <span className="text-on-surface-variant/35 font-normal"> · best: {card.best_san}</span> : null}
        </span>
        <span className="text-[10px] text-on-surface-variant/30 truncate block">
          {phaseLabel}
          {card.eval_loss_cp ? ` · −${(card.eval_loss_cp / 100).toFixed(1)}` : ""}
          {card.themes?.length ? ` · ${card.themes.slice(0, 2).join(", ").replace(/_/g, " ")}` : ""}
          {card.opening ? ` · ${card.opening}` : ""}
        </span>
      </div>
      {card.source && (
        <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/25">{card.source}</span>
      )}
    </div>
  );
}
