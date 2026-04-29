import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useAuth } from "./AuthProvider";
import { fetchChesscomGames, fetchLichessGames } from "../lib/game-import";
import { updateProfile } from "../lib/auth";
import {
  analyzeGameForMistakes,
  buildWeaknessProfile,
  MISTAKE_CP_THRESHOLD,
} from "../lib/study-plan";
import { loadCards, saveCards } from "../lib/review-cards";

/**
 * ImportGamesPanel - the focused "pull my games and find mistakes"
 * surface that lives under Review's Import games tab.
 *
 * Replaces the older StudyPlanPanel which had grown into a
 * everything-tab: import controls + free-text filter + chip filter
 * + manual save-as-deck + AI deck generator + AI preview +
 * weakness-profile stats. That made the page hard to scan and
 * duplicated functionality already living in Today's deck browser.
 *
 * The new split:
 *   - This panel: import games + run Stockfish + drop mistake
 *     cards into the shared collection. Nothing else.
 *   - Today's deck browser: study cards (built-ins + saved drills),
 *     and entry point for the AI deck generator (now a separate
 *     right-side sheet).
 *
 * Cards generated here flow back into the same `ochess_review_cards`
 * storage Today reads, so SM-2 scheduling is shared automatically.
 */
const GAME_LIMIT_OPTIONS = [
  { value: 30,   label: "30",   warn: false },
  { value: 100,  label: "100",  warn: false },
  { value: 200,  label: "200",  warn: true },
  { value: 500,  label: "500",  warn: true },
  { value: 1000, label: "1000", warn: true },
];
const DEFAULT_GAME_LIMIT = 100;

function detectUserColor(pgn, chesscomUsername, lichessUsername) {
  // Prefer matching on whichever username is known. Fall back to
  // null so the caller can skip when neither side resolves.
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

export default function ImportGamesPanel({ onDone }) {
  const { user, profile, refreshProfile } = useAuth();
  const cc = profile?.chesscom_username?.trim() || "";
  const li = profile?.lichess_username?.trim() || "";

  const [useChesscom, setUseChesscom] = useState(!!cc);
  const [useLichess,  setUseLichess]  = useState(!!li);

  const [editingUsernames, setEditingUsernames] = useState(false);
  const [editCC, setEditCC] = useState(cc);
  const [editLI, setEditLI] = useState(li);
  const [savingUsernames, setSavingUsernames] = useState(false);
  const [usernameErr, setUsernameErr] = useState(null);

  const [gameLimit, setGameLimit] = useState(DEFAULT_GAME_LIMIT);

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

  const [phase, setPhase] = useState("ready"); // ready | importing | analyzing | done | error
  const [progress, setProgress] = useState({ source: "", fetched: 0, total: 0, analyzed: 0, totalMoves: 0, gameIdx: 0, gameCount: 0 });
  const [err, setErr] = useState(null);
  const [importedCount, setImportedCount] = useState(0);
  // `cancelling` toggles after the user clicks Cancel so the
  // button can flip to "Stopping..." while we wait for the
  // in-flight Stockfish call to wind down. The actual abort
  // signal does the work; this state is just UI feedback.
  const [cancelling, setCancelling] = useState(false);
  const abortRef = useRef(null);

  // If the user navigates away mid-analysis, abort the in-flight
  // work so we don't keep Stockfish chewing CPU after the
  // component is gone.
  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const [allCards, setAllCards] = useState(() => loadCards());
  const profileWeakness = useMemo(() => buildWeaknessProfile(allCards), [allCards]);

  const cancelImport = useCallback(() => {
    if (!abortRef.current) return;
    setCancelling(true);
    abortRef.current.abort();
  }, []);

  const runImport = useCallback(async () => {
    if (!useChesscom && !useLichess) {
      setErr("Pick at least one source - chess.com or lichess.");
      return;
    }
    setErr(null);
    setCancelling(false);
    setImportedCount(0);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase("importing");
    setProgress({ source: useChesscom ? "chess.com" : "lichess", fetched: 0, total: 0, analyzed: 0, totalMoves: 0, gameIdx: 0, gameCount: 0 });

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

      if (newCards.length > 0) {
        const merged = [...allCards, ...newCards];
        saveCards(merged);
        setAllCards(merged);
      }
      setImportedCount(newCards.length);

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

      setPhase("done");
    } catch (e) {
      if (e?.name === "AbortError") {
        if (newCards.length > 0) {
          const merged = [...allCards, ...newCards];
          saveCards(merged);
          setAllCards(merged);
        }
        setImportedCount(newCards.length);
        setPhase(newCards.length > 0 ? "done" : "ready");
        return;
      }
      setErr(e?.message || "Something went wrong while importing your games.");
      setPhase("error");
    } finally {
      abortRef.current = null;
      setCancelling(false);
    }
  }, [useChesscom, useLichess, cc, li, allCards, gameLimit]);

  const noSourcesAtAll = !cc && !li;

  // Inline username editor reused across the empty + ready states.
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
          {savingUsernames ? "Loading\u2026 saving" : "Save"}
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

  // ── Rendering ──

  if (phase === "importing" || phase === "analyzing") {
    const pctImport = progress.total > 0 ? Math.min(100, (progress.fetched / progress.total) * 100) : null;
    const pctAnalyze = progress.totalMoves > 0 ? (progress.analyzed / progress.totalMoves) * 100 : 0;
    return (
      <div className="anim-fade-up p-6 bg-surface-low border border-white/[0.04]">
        <h3 className="font-headline text-sm font-bold uppercase tracking-widest text-primary mb-3">
          {cancelling ? "Loading\u2026 stopping" : phase === "importing" ? "Loading\u2026 fetching games" : "Loading\u2026 finding your mistakes"}
        </h3>
        {phase === "importing" ? (
          <p className="text-[13px] text-on-surface-variant/55 mb-4">
            Pulling from {progress.source}{"\u2026 "}
            <span className="text-on-surface-variant/80 font-bold">{progress.fetched}</span> games loaded.
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
            ? "Waiting for the current move to finish\u2026 your partial mistakes will be saved."
            : "Stop any time. Mistakes found so far will be kept."}
        </p>
        <button onClick={cancelImport}
          disabled={cancelling}
          className="btn btn-secondary w-full py-2.5 text-xs">
          {cancelling ? "Loading\u2026 stopping" : "Stop analysis"}
        </button>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="anim-fade-up p-6 bg-error/10 border border-error/20">
        <h3 className="font-headline text-sm font-bold uppercase tracking-widest text-error mb-2">Couldn&apos;t import your games</h3>
        <p className="text-[13px] text-on-surface-variant/60 mb-4">{err}</p>
        <button onClick={() => { setErr(null); setPhase("ready"); }}
          className="btn btn-secondary px-4 py-2 text-xs">
          Try again
        </button>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="anim-fade-up p-6 bg-surface-low border border-primary/20 space-y-4">
        <h3 className="font-headline text-sm font-bold uppercase tracking-widest text-primary">
          Import complete
        </h3>
        <p className="text-[13px] text-on-surface-variant/65 leading-relaxed">
          Added <span className="font-headline font-bold text-primary">{importedCount}</span> mistake card{importedCount === 1 ? "" : "s"} to your collection.
          You now have <span className="font-headline font-bold text-on-surface">{profileWeakness.total}</span> total cards across mistakes &amp; puzzles.
        </p>
        <div className="flex flex-wrap gap-2">
          <button onClick={onDone} className="btn btn-primary px-5 py-2 text-xs">
            Go to decks
          </button>
          <button onClick={() => setPhase("ready")} className="btn btn-secondary px-5 py-2 text-xs">
            Import more
          </button>
        </div>
      </div>
    );
  }

  // The "no usernames" cold-empty case. Inline editor surfaces
  // here so the user can wire up accounts without bouncing to
  // /profile.
  if (noSourcesAtAll) {
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

  // Ready state. Stable account summary at the top, source +
  // depth pickers in the middle, big primary "Analyze" button at
  // the bottom.
  return (
    <div className="anim-fade-up space-y-4">
      <div className="p-5 bg-surface-low border border-white/[0.04] space-y-4">
        <div className="flex items-baseline justify-between">
          <h3 className="font-headline text-base font-bold text-primary">Your accounts</h3>
          <button onClick={() => setEditingUsernames((v) => !v)}
            className="text-[10px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40 hover:text-primary transition-colors">
            {editingUsernames ? "Done" : "Edit accounts"}
          </button>
        </div>
        {editingUsernames ? (
          usernamesEditor
        ) : (
          <p className="text-[12px] text-on-surface-variant/55">
            {[cc && `chess.com @${cc}`, li && `lichess @${li}`].filter(Boolean).join(" \u00b7 ")}
          </p>
        )}
      </div>

      <div className="p-5 bg-surface-low border border-white/[0.04] space-y-4">
        <h3 className="font-headline text-base font-bold text-primary">Find my mistakes</h3>
        {importControls}
        <button onClick={runImport}
          disabled={!useChesscom && !useLichess}
          className="btn btn-primary w-full py-3 text-sm">
          Analyze my games
        </button>
        <p className="text-[10px] text-on-surface-variant/30 leading-snug">
          Stockfish runs locally. ~{Math.round(gameLimit * 0.5)}-{gameLimit} seconds depending on your CPU.
          Mistakes get saved as cards under Today.
        </p>
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
