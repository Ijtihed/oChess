import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useAuth } from "./AuthProvider";
import { fetchChesscomGames, fetchLichessGames } from "../lib/game-import";
import { updateProfile } from "../lib/auth";
import { Chess } from "chess.js";
import {
  analyzeGameForMistakes,
  buildWeaknessProfile,
  filterCardsByQuery,
  COMMON_WEAKNESS_CHIPS,
  MISTAKE_CP_THRESHOLD,
} from "../lib/study-plan";
import { loadCards, saveCards } from "../lib/review-cards";
import { generateAIDecks, isAIAvailable } from "../lib/coach-llm";
import {
  loadDrillSets,
  saveDrillSets,
  addDrillSet,
  countDrillSetCards,
} from "../lib/drill-sets";

/**
 * Plan tab - the "what should I work on?" surface.
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
 * touch the SM-2 review state directly - the cards we generate flow
 * back into the same `ochess_review_cards` storage the Today tab
 * already reads, so SM-2 scheduling is shared automatically.
 */
// User-selectable game-import sizes. The actual analysis time grows
// roughly linearly with this number: ~25-40s per game at depth 12 in
// WASM, so 100 games is around an hour, 500 is several hours. The UI
// surfaces this estimate so the user knows what they're committing
// to before clicking Analyze.
// Time-to-analyze varies wildly with CPU + how many of the user's
// moves were already cached in Stockfish, so concrete estimates were
// misleading more than they helped. The two largest sets just get a
// soft "this can take a while" hint instead.
const GAME_LIMIT_OPTIONS = [
  { value: 30,   label: "30",   warn: false },
  { value: 100,  label: "100",  warn: false },
  { value: 200,  label: "200",  warn: true },
  { value: 500,  label: "500",  warn: true },
  { value: 1000, label: "1000", warn: true },
];
const DEFAULT_GAME_LIMIT = 100;
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
  const { user, profile, refreshProfile } = useAuth();
  const cc = profile?.chesscom_username?.trim() || "";
  const li = profile?.lichess_username?.trim() || "";

  // Source selection. If both are configured, default to BOTH. The
  // user can untoggle either before clicking "Analyze". If only one
  // is set, that one is the only option.
  const [useChesscom, setUseChesscom] = useState(!!cc);
  const [useLichess,  setUseLichess]  = useState(!!li);

  // Inline editor state for the chess.com / lichess usernames so the
  // user can wire up their accounts directly from the Plan tab
  // without bouncing to /profile. Two modes:
  //   - editing === false: read-only summary with "Edit" button
  //   - editing === true:  inputs + Save / Cancel
  // The editor pre-fills from the profile, writes via updateProfile,
  // and refreshes the auth context so the rest of the panel sees the
  // new values immediately.
  const [editingUsernames, setEditingUsernames] = useState(false);
  const [editCC, setEditCC] = useState(cc);
  const [editLI, setEditLI] = useState(li);
  const [savingUsernames, setSavingUsernames] = useState(false);
  const [usernameErr, setUsernameErr] = useState(null);

  // How many games to pull per source. Default 100 covers months of
  // play for an active user without spending hours on Stockfish; the
  // 500 option exists for power users who want a deep dive.
  const [gameLimit, setGameLimit] = useState(DEFAULT_GAME_LIMIT);

  // Re-sync source defaults + editor inputs when the profile loads.
  useEffect(() => {
    setUseChesscom(!!cc);
    setUseLichess(!!li);
    setEditCC(cc);
    setEditLI(li);
  }, [cc, li]);

  const saveUsernames = useCallback(async () => {
    if (!user?.id) {
      setUsernameErr("Sign in first.");
      return;
    }
    setSavingUsernames(true);
    setUsernameErr(null);
    try {
      const ccTrim = editCC.trim().replace(/^@/, "");
      const liTrim = editLI.trim().replace(/^@/, "");
      await updateProfile(user.id, {
        chesscom_username: ccTrim || null,
        lichess_username:  liTrim || null,
      });
      await refreshProfile?.(user.id);
      setEditingUsernames(false);
    } catch (e) {
      setUsernameErr(e?.message || "Couldn't save usernames.");
    } finally {
      setSavingUsernames(false);
    }
  }, [user, editCC, editLI, refreshProfile]);

  const cancelEditUsernames = useCallback(() => {
    setEditCC(cc);
    setEditLI(li);
    setUsernameErr(null);
    setEditingUsernames(false);
  }, [cc, li]);

  const [phase, setPhase] = useState("ready"); // ready | importing | analyzing | built | error
  const [progress, setProgress] = useState({ source: "", fetched: 0, total: 0, analyzed: 0, totalMoves: 0, gameIdx: 0, gameCount: 0 });
  const [err, setErr] = useState(null);
  // `cancelling` toggles after the user clicks Cancel so the button
  // can flip to "Stopping..." while we wait for the in-flight
  // Stockfish call to wind down. The actual abort signal is what
  // does the work; this state is just UI feedback.
  const [cancelling, setCancelling] = useState(false);
  const abortRef = useRef(null);

  // If the user navigates away mid-analysis, abort the in-flight
  // work so we don't keep Stockfish chewing CPU after the component
  // is gone. fetchLichessGames / fetchChesscomGames already respect
  // the signal via fetch(), and analyzeGameForMistakes checks it
  // between every move pair.
  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // Card store - re-read on every build/refresh so the Today tab and
  // this tab stay in lockstep.
  const [allCards, setAllCards] = useState(() => loadCards());
  // Filter UI state. `query` and `activeChip` describe the current
  // ad-hoc drill (the one the "Start session" button kicks off).
  // Saved drill sets live separately in `drillSets`; clicking one
  // applies its filter and starts a session.
  const [query, setQuery] = useState("");
  const [activeChip, setActiveChip] = useState(null);
  const [drillSets, setDrillSets] = useState(() => loadDrillSets());
  const [savingDrill, setSavingDrill] = useState(false);
  const [drillName, setDrillName] = useState("");
  const [editingSetId, setEditingSetId] = useState(null);
  const canSaveDrill = !!(query.trim() || activeChip);

  // AI deck-generator state. The user types a query, clicks
  // "Generate decks with AI", we call the Edge Function, and a
  // 1-3-element list of proposed decks comes back as
  // `aiResults.decks`. Each row in the preview UI then lets the
  // user save individual decks (with match-count visibility).
  // Cleared by clicking "Dismiss" on the preview block.
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResults, setAiResults] = useState(null); // { summary, decks: [...] }
  const [aiError, setAiError] = useState(null);
  // Tracks which proposed decks the user has already saved (by
  // their array index in the response) so the preview can show
  // "Saved" instead of letting them double-save.
  const [aiSavedIdx, setAiSavedIdx] = useState(new Set());
  // Per-user rate-limit cooldown surfaced from the Edge Function.
  // When the server returns a 429, we capture `retryAfterSeconds`
  // and tick down once per second until it hits 0. The Generate
  // button is disabled + relabeled while the countdown is active
  // so the user never has to retry-and-fail to learn the cap.
  const [aiCooldownSec, setAiCooldownSec] = useState(0);
  const [aiUsage, setAiUsage] = useState(null);
  useEffect(() => {
    if (aiCooldownSec <= 0) return;
    const t = setTimeout(() => setAiCooldownSec((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(t);
  }, [aiCooldownSec]);

  const profileWeakness = useMemo(() => buildWeaknessProfile(allCards), [allCards]);

  // Save the current ad-hoc filter as a persistent named drill set.
  // If an existing set is being edited (clicked "rename"), updates
  // it in place; otherwise creates a new one. Either way the new
  // collection is persisted to localStorage so a refresh / tab swap
  // doesn't lose the user's saved drills.
  const saveCurrentAsDrillSet = useCallback(() => {
    if (!canSaveDrill) return;
    const { sets, id } = addDrillSet(drillSets, {
      id: editingSetId,
      name: drillName,
      query,
      chipId: activeChip,
    });
    if (!id) return;
    setDrillSets(sets);
    saveDrillSets(sets);
    setSavingDrill(false);
    setEditingSetId(null);
    setDrillName("");
  }, [drillSets, editingSetId, drillName, query, activeChip, canSaveDrill]);


  const cancelImport = useCallback(() => {
    if (!abortRef.current) return;
    setCancelling(true);
    abortRef.current.abort();
    // Phase transition is handled inside runImport's terminal block
    // - it knows whether any partial cards survived. Setting phase
    // here would race with that block and either show "ready" when
    // we have partial cards or flicker between states.
  }, []);

  // ── AI deck generation ──
  //
  // Replaces the old "Generate AI plan" multi-day-plan flow. The
  // user types a query in the search field (or picks a chip),
  // clicks "Generate decks with AI", and the LLM proposes 1-3
  // focused decks with a name + filter + one-line summary each.
  //
  // The proposals are PREVIEW-ONLY until the user clicks "Save"
  // on the rows they want. 0-match decks get a "Save for later?"
  // affordance per the agreed flow.

  // Compute a deck's match count against the user's actual card
  // collection. Used both for the preview UI and for the toast
  // shown when saving.
  const matchCountForQuery = useCallback((q) => {
    if (!q) return 0;
    return countDrillSetCards({ query: q, chipId: null }, allCards, {
      chipFor: (id) => COMMON_WEAKNESS_CHIPS.find((c) => c.id === id),
      queryFilter: filterCardsByQuery,
    });
  }, [allCards]);

  const generateAIDecksFromQuery = useCallback(async () => {
    if (aiCooldownSec > 0) return;
    setAiLoading(true);
    setAiError(null);
    setAiResults(null);
    setAiSavedIdx(new Set());
    try {
      // Send the FULL mistake + puzzle corpus to the LLM (capped
      // at 30 server-side). Don't pre-filter to the current
      // chip/query selection - the AI is steering its own focus
      // from the natural-language query, not from the chip
      // narrowing. (The chips remain useful for substring
      // search-as-you-type without the AI.)
      const mistakes = allCards
        .filter((c) => c.type === "mistake" || c.type === "puzzle")
        .slice(0, 30);
      if (mistakes.length === 0) {
        setAiError("Run analysis first - the AI needs at least one mistake to work from.");
        return;
      }
      const result = await generateAIDecks({ mistakes, query });
      if (!result.ok) {
        if (result.rateLimited) {
          setAiCooldownSec(Math.max(1, result.retryAfterSeconds || 0));
          setAiUsage({
            callsInWindow: result.callsInWindow || 0,
            maxCalls: result.maxCalls || 0,
            windowSeconds: result.windowSeconds || 0,
          });
          setAiError(null);
          return;
        }
        setAiError(result.error || "AI unavailable.");
        return;
      }
      setAiResults(result);
      if (result.rateLimit) setAiUsage(result.rateLimit);
    } catch (e) {
      setAiError(e?.message || "AI unavailable.");
    } finally {
      setAiLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCards, query, aiCooldownSec]);

  const dismissAI = useCallback(() => {
    setAiResults(null);
    setAiError(null);
    setAiSavedIdx(new Set());
  }, []);

  // Save one of the proposed decks. Tagged with source="coach"
  // and `summary` so the deck browser shows the AI badge and the
  // session view renders the deck banner.
  const saveProposedDeck = useCallback((deck, idx) => {
    if (!deck?.query || !deck?.name) return;
    const { sets, id } = addDrillSet(drillSets, {
      name: deck.name,
      query: deck.query,
      source: "coach",
      summary: deck.summary || "",
    });
    if (!id) return;
    setDrillSets(sets);
    saveDrillSets(sets);
    setAiSavedIdx((prev) => {
      const next = new Set(prev);
      next.add(idx);
      return next;
    });
  }, [drillSets]);

  // "Practice now" - drop straight into a session for the
  // proposed deck without saving it. Useful when the user wants
  // to try a deck before committing.
  const practiceProposedDeck = useCallback((deck) => {
    if (!deck?.query || !deck?.name) return;
    onStartSession?.({ query: deck.query, chipId: null, setName: deck.name });
  }, [onStartSession]);

  const runImport = useCallback(async () => {
    if (!useChesscom && !useLichess) {
      setErr("Pick at least one source - chess.com or lichess.");
      return;
    }
    setErr(null);
    setCancelling(false);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase("importing");
    setProgress({ source: useChesscom ? "chess.com" : "lichess", fetched: 0, total: 0, analyzed: 0, totalMoves: 0, gameIdx: 0, gameCount: 0 });

    // Pre-existing card count so we can decide the terminal phase
    // even if `newCards` ends up empty due to a fast cancel.
    const preExistingMistakes = allCards.filter((c) => c.type === "mistake" || c.type === "puzzle").length;
    const newCards = [];

    try {
      const games = [];
      if (useChesscom && cc) {
        setProgress((p) => ({ ...p, source: "chess.com", fetched: 0 }));
        const ccGames = await fetchChesscomGames(cc, {
          signal: ctrl.signal,
          max: gameLimit,
          onProgress: (n) => setProgress((p) => ({ ...p, fetched: n })),
        });
        games.push(...ccGames);
      }
      if (useLichess && li && !ctrl.signal.aborted) {
        setProgress((p) => ({ ...p, source: "lichess", fetched: 0 }));
        const liGames = await fetchLichessGames(li, {
          signal: ctrl.signal,
          max: gameLimit,
          onProgress: (n) => setProgress((p) => ({ ...p, fetched: n })),
        });
        games.push(...liGames);
      }

      if (!ctrl.signal.aborted) {
        // Move into analysis phase. We process games sequentially so
        // Stockfish doesn't fight itself for CPU.
        setPhase("analyzing");
        setProgress((p) => ({ ...p, gameCount: games.length, gameIdx: 0 }));

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
      }

      // Persist whatever we got - including partial work after a
      // cancel. The user's effort isn't wasted by clicking Stop.
      if (newCards.length > 0) {
        const merged = [...allCards, ...newCards];
        saveCards(merged);
        setAllCards(merged);
      }

      // Surface a useful empty-result message when we processed
      // games but found nothing usable. Skip this if we never made
      // it through analysis (cancellation falls through here too) -
      // in that case the AbortError catch block handles the phase.
      if (newCards.length === 0 && preExistingMistakes === 0 && !ctrl.signal.aborted) {
        if (games.length === 0) {
          setErr(
            "We couldn't find any games on the source(s) you picked. Double-check the username spelling under Edit accounts."
          );
        } else {
          setErr(
            `Analyzed ${games.length} game${games.length === 1 ? "" : "s"} but didn't find any positions where you lost more than ${MISTAKE_CP_THRESHOLD / 100} pawns. Try a larger sample or different sources.`
          );
        }
        setPhase("error");
        return;
      }

      // Terminal phase: built if we have cards (existing or just
      // imported), ready otherwise. This is deliberately the only
      // place that decides the post-import phase, so a Cancel never
      // races with us.
      const finalCount = preExistingMistakes + newCards.length;
      setPhase(finalCount > 0 ? "built" : "ready");
    } catch (e) {
      if (e?.name === "AbortError") {
        // Persist any partial work before bowing out.
        if (newCards.length > 0) {
          const merged = [...allCards, ...newCards];
          saveCards(merged);
          setAllCards(merged);
        }
        const finalCount = preExistingMistakes + newCards.length;
        setPhase(finalCount > 0 ? "built" : "ready");
        return;
      }
      setErr(e?.message || "Something went wrong while building your plan.");
      setPhase("error");
    } finally {
      abortRef.current = null;
      setCancelling(false);
    }
  }, [useChesscom, useLichess, cc, li, allCards, gameLimit]);

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
          {cancelling ? "Stopping..." : phase === "importing" ? "Fetching games" : "Finding your mistakes"}
        </h3>
        {phase === "importing" ? (
          <p className="text-[13px] text-on-surface-variant/55 mb-4">
            Pulling from {progress.source}... <span className="text-on-surface-variant/80 font-bold">{progress.fetched}</span> games loaded.
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
        <div className="h-1.5 bg-surface-high overflow-hidden mb-2">
          <div
            className={`h-full transition-all duration-150 ${cancelling ? "bg-on-surface-variant/30" : "bg-primary"}`}
            style={{ width: `${pctAnalyze || pctImport || 5}%` }}
          />
        </div>
        <p className="text-[10px] text-on-surface-variant/30 mb-4">
          {cancelling
            ? "Waiting for the current move to finish... your partial mistakes will be saved."
            : "Stop any time. Mistakes found so far will be kept."}
        </p>
        <button onClick={cancelImport}
          disabled={cancelling}
          className="btn btn-secondary w-full py-2.5 text-xs">
          {cancelling ? "Stopping..." : "Stop analysis"}
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

  // Inline editor that lets the user type their chess.com / lichess
  // usernames directly here. Reusable across the empty state and the
  // built state's "Re-analyze" panel so the user can update accounts
  // without ever leaving the Plan tab.
  const usernamesEditor = (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant/40 block mb-1">
            chess.com
          </label>
          <input
            value={editCC}
            onChange={(e) => setEditCC(e.target.value)}
            placeholder="username"
            autoCapitalize="none"
            autoCorrect="off"
            className="w-full bg-surface-container border border-white/[0.06] px-3 py-2 text-[13px] text-on-surface placeholder:text-on-surface-variant/30 outline-none focus:border-primary/40"
          />
        </div>
        <div>
          <label className="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant/40 block mb-1">
            Lichess
          </label>
          <input
            value={editLI}
            onChange={(e) => setEditLI(e.target.value)}
            placeholder="username"
            autoCapitalize="none"
            autoCorrect="off"
            className="w-full bg-surface-container border border-white/[0.06] px-3 py-2 text-[13px] text-on-surface placeholder:text-on-surface-variant/30 outline-none focus:border-primary/40"
          />
        </div>
      </div>
      {usernameErr && (
        <p className="text-[12px] text-error">{usernameErr}</p>
      )}
      <div className="flex gap-2">
        <button onClick={saveUsernames}
          disabled={savingUsernames}
          className="btn btn-primary px-4 py-2 text-xs">
          {savingUsernames ? "Saving..." : "Save"}
        </button>
        {(cc || li) && (
          <button onClick={cancelEditUsernames}
            disabled={savingUsernames}
            className="btn btn-secondary px-4 py-2 text-xs">
            Cancel
          </button>
        )}
      </div>
    </div>
  );

  // Game-count + (optional) source toggle picker. Always rendered
  // alongside the "Analyze my games" button so the user picks both
  // depth and breadth in one place.
  const importControls = (
    <div className="space-y-3">
      {(cc && li) && (
        <div className="space-y-1.5">
          <SourceToggle label="chess.com" username={cc} active={useChesscom} onToggle={() => setUseChesscom((v) => !v)} />
          <SourceToggle label="Lichess"   username={li} active={useLichess}  onToggle={() => setUseLichess((v) => !v)} />
        </div>
      )}
      <div>
        <span className="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant/40 block mb-1.5">
          Games per source
        </span>
        <div className="grid grid-cols-5 gap-1.5">
          {GAME_LIMIT_OPTIONS.map((opt) => (
            <button key={opt.value}
              onClick={() => setGameLimit(opt.value)}
              className={`flex flex-col items-center justify-center py-2 transition-colors active:scale-[0.97] ${
                gameLimit === opt.value
                  ? "bg-primary text-on-primary"
                  : "bg-surface-container border border-white/[0.04] text-on-surface-variant/55 hover:text-primary hover:bg-surface-high"
              }`}>
              <span className="font-headline text-sm font-extrabold">{opt.label}</span>
              {opt.warn && (
                <span className={`text-[9px] mt-0.5 ${gameLimit === opt.value ? "text-on-primary/60" : "text-amber-400/60"}`}>
                  slow
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  // The "no usernames, no cards" cold-empty case. Inline editor
  // appears here so the user can wire up accounts without bouncing.
  if (noSourcesAtAll && !hasAnyMistakes) {
    return (
      <div className="anim-fade-up p-5 bg-surface-low border border-white/[0.04]">
        <h3 className="font-headline text-base font-bold text-primary mb-2">Connect a chess account</h3>
        <p className="text-[13px] text-on-surface-variant/55 leading-relaxed mb-4">
          Add your chess.com or Lichess username below. oChess will pull your recent games,
          find positions where you make recurring mistakes, and turn them into Anki cards
          organized by weakness.
        </p>
        {usernamesEditor}
      </div>
    );
  }

  // Pre-build state: usernames present, no mistakes yet.
  if (!hasAnyMistakes && phase === "ready") {
    return (
      <div className="anim-fade-up">
        <div className="p-5 bg-surface-low border border-white/[0.04] space-y-4">
          <div className="flex items-baseline justify-between">
            <h3 className="font-headline text-base font-bold text-primary">Import your games</h3>
            <button onClick={() => setEditingUsernames((v) => !v)}
              className="text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40 hover:text-primary transition-colors">
              {editingUsernames ? "Done" : "Edit accounts"}
            </button>
          </div>
          {editingUsernames && usernamesEditor}
          {importControls}
          <button onClick={runImport}
            disabled={!useChesscom && !useLichess}
            className="btn btn-primary w-full py-3 text-sm">
            Analyze my games
          </button>
        </div>
      </div>
    );
  }

  // Built state - slim "do one thing" UI.
  //
  // The Plan tab's job after analysis: let the user search / chip /
  // ask AI to spin up new decks. Studying happens on the Today tab
  // (deck browser). So this surface is intentionally narrow:
  //
  //   1. Compact stats strip (you've heard "you have 320 mistakes",
  //      now move on).
  //   2. One control block: search + chips + Save / AI button.
  //   3. AI proposals appear inline below the control block when
  //      generated.
  //   4. A single re-analyze footer for tweaking sources / size.
  //
  // What got cut from the prior version: "My drill sets" panel
  // (already in Today's deck browser), "Today's plan" preview
  // (same), the long instructional paragraphs, the duplicated
  // headers + sub-labels.
  return (
    <div className="anim-fade-up space-y-4">
      {/* ── Stats strip ── */}
      <CompactStats profileWeakness={profileWeakness} />

      {/* ── Search + chips + Save / AI ── */}
      <div className="p-5 bg-surface-low border border-white/[0.04]">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What kind of mistakes? e.g. hanging queens, endgame fork"
          className="w-full bg-surface-container border border-white/[0.06] px-3 py-2.5 text-[13px] text-on-surface placeholder:text-on-surface-variant/30 outline-none focus:border-primary/40 mb-3"
        />

        <div className="flex flex-wrap gap-1.5 mb-3">
          {COMMON_WEAKNESS_CHIPS.map((chip) => (
            <button key={chip.id}
              onClick={() => setActiveChip(activeChip === chip.id ? null : chip.id)}
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

        {/* Two parallel ways to turn the current query/chip into a
            deck. Save as deck = exact substring filter. AI = let
            the model split / focus / write a summary. */}
        <div className="flex gap-2">
          <button onClick={() => { setSavingDrill(true); setDrillName(""); }}
            disabled={!canSaveDrill || savingDrill}
            className="btn btn-secondary flex-1 py-2 text-[11px] disabled:opacity-30 disabled:pointer-events-none">
            {editingSetId ? "Edit deck" : "Save as deck"}
          </button>
          {isAIAvailable() && (
            <button onClick={generateAIDecksFromQuery}
              disabled={aiLoading || aiCooldownSec > 0}
              className="btn btn-primary flex-1 py-2 text-[11px]">
              {aiLoading ? "Thinking..." : aiCooldownSec > 0 ? `Wait ${aiCooldownSec}s` : "AI: build decks"}
            </button>
          )}
        </div>

        {/* Save-as-deck inline editor. Only visible after the user
            clicks "Save as deck". */}
        {savingDrill && (
          <div className="mt-3 p-3 bg-surface-container border border-primary/15 space-y-2">
            <input
              value={drillName}
              onChange={(e) => setDrillName(e.target.value)}
              placeholder="Name this deck (e.g. 'Hanging queens')"
              maxLength={60}
              autoFocus
              className="w-full bg-surface-low border border-white/[0.06] px-3 py-2 text-[13px] text-on-surface placeholder:text-on-surface-variant/30 outline-none focus:border-primary/40"
              onKeyDown={(e) => { if (e.key === "Enter") saveCurrentAsDrillSet(); }}
            />
            <div className="flex gap-2">
              <button onClick={saveCurrentAsDrillSet}
                disabled={!canSaveDrill}
                className="btn btn-primary px-4 py-1.5 text-[11px]">
                {editingSetId ? "Update" : "Save"}
              </button>
              <button onClick={() => { setSavingDrill(false); setEditingSetId(null); setDrillName(""); }}
                className="btn btn-secondary px-4 py-1.5 text-[11px]">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* AI inline messaging. Cooldown / error live here so they
            don't take up space when the AI is idle. */}
        {aiCooldownSec > 0 && (
          <p className="anim-fade-up mt-3 text-[11px] text-amber-400/80 leading-snug">
            Limit reached. Try again in {aiCooldownSec}s.
            {aiUsage?.maxCalls
              ? ` (${aiUsage.maxCalls} per ${Math.round(aiUsage.windowSeconds / 60)} min.)`
              : ""}
          </p>
        )}
        {aiError && (
          <p className="anim-fade-up mt-3 text-[11px] text-error/80 leading-snug">{aiError}</p>
        )}
        {aiUsage?.maxCalls > 0 && aiCooldownSec === 0 && !aiError && (
          <p className="mt-3 text-[10px] text-on-surface-variant/30 tabular-nums">
            {aiUsage.callsInWindow}/{aiUsage.maxCalls} AI calls in last {Math.round(aiUsage.windowSeconds / 60)} min
          </p>
        )}
      </div>

      {/* AI deck preview. Renders only after the user generates;
          kept in its own block so the search panel above stays
          scannable when AI is idle. */}
      {aiResults && Array.isArray(aiResults.decks) && (
        <AIPreview
          aiResults={aiResults}
          aiSavedIdx={aiSavedIdx}
          matchCountForQuery={matchCountForQuery}
          practiceProposedDeck={practiceProposedDeck}
          saveProposedDeck={saveProposedDeck}
          dismissAI={dismissAI}
        />
      )}

      {/* ── Re-analyze footer ── */}
      <ReanalyzeFooter
        cc={cc}
        li={li}
        gameLimit={gameLimit}
        cardCount={profileWeakness.total}
        editingUsernames={editingUsernames}
        setEditingUsernames={setEditingUsernames}
        usernamesEditor={usernamesEditor}
        importControls={importControls}
        runImport={runImport}
        useChesscom={useChesscom}
        useLichess={useLichess}
      />
    </div>
  );
}

// ── Sub-components extracted for clarity ──────────────────────────

/**
 * Single-row compact stats strip. Replaces the previous 3-column
 * grid + header + theme-chips block with one line that surfaces
 * the same info: phase split + top theme summary.
 */
function CompactStats({ profileWeakness }) {
  const phases = ["opening", "middlegame", "endgame"];
  return (
    <div className="px-4 py-3 bg-surface-low border border-white/[0.04] flex items-center gap-4 flex-wrap">
      <div className="flex items-baseline gap-3">
        {phases.map((p) => (
          <span key={p} className="flex items-baseline gap-1.5">
            <span className="font-headline text-[15px] font-extrabold text-primary tabular-nums">
              {profileWeakness.phaseCount[p] || 0}
            </span>
            <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/35">
              {PHASE_LABELS[p]}
            </span>
          </span>
        ))}
      </div>
      <span className="text-on-surface-variant/15 hidden sm:inline">·</span>
      <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/30 tabular-nums">
        {profileWeakness.total} cards
      </span>
      {profileWeakness.topThemes.length > 0 && (
        <>
          <span className="text-on-surface-variant/15 hidden sm:inline">·</span>
          <span className="flex flex-wrap gap-1 items-center">
            {profileWeakness.topThemes.slice(0, 4).map(({ theme, count }) => (
              <span key={theme} className="px-1.5 py-0.5 bg-surface-container border border-white/[0.04] text-[10px] text-on-surface-variant/55">
                {theme.replace(/_/g, " ")} <span className="text-on-surface-variant/30 tabular-nums">{count}</span>
              </span>
            ))}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * AI proposal rows. Extracted out of the main render so the
 * "search panel" stays compact and the preview section reads as a
 * distinct block when the user has just generated decks.
 */
function AIPreview({ aiResults, aiSavedIdx, matchCountForQuery, practiceProposedDeck, saveProposedDeck, dismissAI }) {
  return (
    <div className="anim-fade-up p-5 bg-surface-low border border-primary/20 space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-primary/80">AI suggested decks</h3>
        <button onClick={dismissAI}
          className="text-[10px] uppercase tracking-widest text-on-surface-variant/40 hover:text-on-surface-variant/70 transition-colors">
          Dismiss
        </button>
      </div>
      {aiResults.summary && (
        <p className="text-[12px] text-on-surface-variant/75 leading-relaxed">{aiResults.summary}</p>
      )}
      {aiResults.decks.length === 0 ? (
        <p className="text-[11px] text-on-surface-variant/45 leading-relaxed">
          Couldn't pick a focused deck. Try rephrasing.
        </p>
      ) : (
        <div className="space-y-2">
          {aiResults.decks.map((deck, idx) => {
            const matchCount = matchCountForQuery(deck.query);
            const saved = aiSavedIdx.has(idx);
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
                      <button onClick={() => practiceProposedDeck(deck)}
                        disabled={!hasMatches}
                        className="btn btn-primary flex-1 py-1.5 text-[10px] disabled:opacity-30 disabled:pointer-events-none">
                        Practice now
                      </button>
                      <button onClick={() => saveProposedDeck(deck, idx)}
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

/**
 * Compact bottom strip: where the cards came from, when the user
 * last imported, and a Re-analyze action. Replaces the previous
 * full-panel "Re-analyze" block which always showed the import
 * controls inline.
 */
function ReanalyzeFooter({
  cc, li, gameLimit, cardCount,
  editingUsernames, setEditingUsernames,
  usernamesEditor, importControls, runImport,
  useChesscom, useLichess,
}) {
  const [open, setOpen] = useState(false);
  const sources = [cc && `chesscom @${cc}`, li && `lichess @${li}`].filter(Boolean).join(" \u00b7 ");
  return (
    <div className="bg-surface-low border border-white/[0.04]">
      <div className="px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/40 truncate">
          {sources || "No sources connected"} {cardCount > 0 && (<span className="text-on-surface-variant/25">{` \u00b7 ${cardCount} cards from last ${gameLimit} games`}</span>)}
        </span>
        <button onClick={() => setOpen((v) => !v)}
          className="text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40 hover:text-primary transition-colors">
          {open ? "Done" : "Re-analyze"}
        </button>
      </div>
      {open && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-white/[0.04]">
          {editingUsernames || (!cc && !li) ? usernamesEditor : (
            <button onClick={() => setEditingUsernames(true)}
              className="text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40 hover:text-primary transition-colors">
              Edit accounts
            </button>
          )}
          {importControls}
          <button onClick={runImport}
            disabled={!useChesscom && !useLichess}
            className="btn btn-primary w-full py-2 text-[11px]">
            Run analysis
          </button>
        </div>
      )}
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

