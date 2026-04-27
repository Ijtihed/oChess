import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { isOnline, supabase } from "../lib/supabase";
import { getChallenge, acceptChallengeRPC, createChallenge, deleteChallenge, watchChallenge, pollChallenge } from "../lib/challenges";
import { getRatings } from "../lib/auth";
import { categoryFromTimeControl } from "../lib/glicko2";
import { ONLINE_SUPPORTED_VARIANTS } from "../lib/variants";
import SocialPanel from "./SocialPanel";

// Match PlayPage's PRESETS so a user moving between Quick-match and
// Create-challenge sees the same time-control buttons in the same
// order. Casual-only here - challenge links are always unrated.
const TIME_CONTROLS = [
  { label: "1+0", cat: "Bullet" },
  { label: "3+0", cat: "Blitz" },
  { label: "3+2", cat: "Blitz" },
  { label: "5+0", cat: "Blitz" },
  { label: "5+3", cat: "Blitz" },
  { label: "10+0", cat: "Rapid" },
  { label: "10+5", cat: "Rapid" },
  { label: "15+10", cat: "Rapid" },
  { label: "30+0", cat: "Classical" },
];

// Variants offered in the picker. The list is intentionally narrower
// than `lib/variants.VARIANT_DEFS` - only variants that round-trip
// cleanly across reload via PGN replay are exposed here. Atomic and
// Crazyhouse stay bot-only for now (see ONLINE_SUPPORTED_VARIANTS in
// lib/variants.js for the rationale).
const VARIANT_OPTIONS = [
  { id: "standard",      label: "Standard",       desc: "Classic chess." },
  { id: "antichess",     label: "Antichess",      desc: "Lose all pieces to win." },
  { id: "kingOfTheHill", label: "King of the Hill", desc: "Get your king to the center." },
  { id: "threeCheck",    label: "Three-Check",    desc: "Three checks and you win." },
  { id: "horde",         label: "Horde",          desc: "Pawns vs full army." },
  { id: "racingKings",   label: "Racing Kings",   desc: "First king to rank 8." },
  { id: "fogOfWar",      label: "Fog of War",     desc: "Only see what your pieces see." },
  { id: "chess960",      label: "Chess 960",      desc: "Randomized back rank." },
];

export function CreateChallenge() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [searchParams] = useSearchParams();
  // Allow deep-linking from VariantsPage with `?variant=antichess`. We
  // sanitize against ONLINE_SUPPORTED_VARIANTS so a stale link to a
  // bot-only variant falls back to standard rather than producing an
  // unpickable challenge row.
  const initialVariant = ONLINE_SUPPORTED_VARIANTS.has(searchParams.get("variant"))
    ? searchParams.get("variant")
    : "standard";
  const [tc, setTc] = useState("10+0");
  const [colorPref, setColorPref] = useState("random");
  const [variant, setVariant] = useState(initialVariant);
  const [challenge, setChallenge] = useState(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState(null);
  const watchRef = useRef(null);
  const expiryRef = useRef(null);
  const pollRef = useRef(null);

  const isLoggedIn = !!user && isOnline();

  const navigateToGame = useCallback(async (gameId) => {
    watchRef.current?.unsubscribe();
    if (expiryRef.current) clearTimeout(expiryRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
    try {
      if (supabase) {
        const { data: game } = await supabase.from("games").select("*").eq("id", gameId).maybeSingle();
        if (game) {
          navigate(`/game/online/${game.id}`, { state: { gameData: game } });
          return;
        }
      }
    } catch {}
    navigate(`/game/online/${gameId}`);
  }, [navigate]);

  const handleCreate = useCallback(async () => {
    if (!isLoggedIn) return;
    setCreating(true);
    setError(null);
    setExpired(false);
    try {
      const category = categoryFromTimeControl(tc);
      const ratings = await getRatings(user.id).catch(() => []);
      const r = ratings?.find((x) => x.category === category);
      const ch = await createChallenge(user.id, profile?.display_name || profile?.username || "Player", r ? Math.round(r.rating) : 1500, {
        timeControl: tc, colorPref, variant,
      });
      setChallenge(ch);

      watchRef.current = watchChallenge(ch.id, (updated) => {
        if (updated.status === "accepted" && updated.game_id) {
          navigateToGame(updated.game_id);
        } else if (updated.status === "expired") {
          watchRef.current?.unsubscribe();
          if (pollRef.current) clearInterval(pollRef.current);
          setChallenge(null);
          setExpired(true);
        }
      });

      pollRef.current = setInterval(async () => {
        const latest = await pollChallenge(ch.id);
        if (latest?.status === "accepted" && latest.game_id) {
          navigateToGame(latest.game_id);
        } else if (!latest || latest.status === "expired") {
          if (pollRef.current) clearInterval(pollRef.current);
          watchRef.current?.unsubscribe();
          setChallenge(null);
          setExpired(true);
        }
      }, 3000);

      expiryRef.current = setTimeout(() => {
        watchRef.current?.unsubscribe();
        if (pollRef.current) clearInterval(pollRef.current);
        deleteChallenge(ch.id).catch(() => {});
        setChallenge(null);
        setExpired(true);
      }, 15 * 60 * 1000);
    } catch (err) {
      setError(err.message || "Failed to create challenge");
    }
    setCreating(false);
  }, [isLoggedIn, user, profile, tc, colorPref, variant, navigateToGame]);

  useEffect(() => () => {
    watchRef.current?.unsubscribe();
    if (expiryRef.current) clearTimeout(expiryRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  const link = challenge ? `${window.location.origin}/challenge/${challenge.code}` : null;

  // Tear down everything (subscription, expiry timer, poll) and
  // delete the row so the opponent doesn't land on a stale link.
  // Used by the explicit Cancel button and by the back navigation
  // when there's a live challenge in flight.
  const teardownAndExit = useCallback(() => {
    watchRef.current?.unsubscribe();
    if (expiryRef.current) clearTimeout(expiryRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
    if (challenge) deleteChallenge(challenge.id).catch(() => {});
    navigate("/play");
  }, [challenge, navigate]);

  return (
    <div className="flex">
      <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
        {/* Back affordance - sub-pages need a way out. Leaving early
            with a live challenge tears the row down so a half-shared
            link can't trap an opponent. */}
        <button
          onClick={challenge ? teardownAndExit : () => navigate("/play")}
          className="anim-fade-up inline-flex items-center gap-1.5 mb-4 text-[11px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40 hover:text-primary transition-colors active:scale-[0.97]"
          style={{ "--delay": "0.04s" }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back to Play
        </button>

        <div className="anim-fade-up mb-6" style={{ "--delay": "0.05s" }}>
          <h1 className="font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-1">
            Create Challenge
          </h1>
          <p className="text-sm text-on-surface-variant/40">
            Generate a private game link to share with a friend.
          </p>
        </div>

        {!isLoggedIn && (
          <div className="anim-fade-up max-w-md p-4 bg-amber-500/10 border border-amber-500/20 text-[12px] text-amber-400 mb-6" style={{ "--delay": "0.07s" }}>
            Sign in to create game links.
          </div>
        )}
        {expired && (
          <div className="anim-fade-up max-w-md p-4 bg-error/10 border border-error/20 text-[12px] text-error mb-4" style={{ "--delay": "0.07s" }}>
            Challenge expired. Create a new one.
          </div>
        )}
        {error && (
          <div className="anim-fade-up max-w-md p-4 bg-error/10 border border-error/20 text-[12px] text-error mb-4" style={{ "--delay": "0.07s" }}>
            {error}
          </div>
        )}

        {!challenge ? (
          <div className="anim-fade-up max-w-md space-y-6" style={{ "--delay": "0.1s" }}>
            <div>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Time control</h2>
              <div className="grid grid-cols-3 gap-1.5">
                {TIME_CONTROLS.map((t) => (
                  <button key={t.label} onClick={() => setTc(t.label)}
                    className={`flex flex-col items-center justify-center py-3 transition-all duration-150 active:scale-[0.95] ${tc === t.label ? "bg-primary text-on-primary" : "bg-surface-low border border-white/[0.04] hover:bg-surface-high"}`}>
                    <span className="font-headline text-sm font-extrabold">{t.label}</span>
                    <span className={`text-[9px] uppercase tracking-wide mt-0.5 ${tc === t.label ? "text-on-primary/60" : "text-on-surface-variant/30"}`}>{t.cat}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Variant</h2>
              <div className="grid grid-cols-2 gap-1.5">
                {VARIANT_OPTIONS.map((v) => (
                  <button key={v.id} onClick={() => setVariant(v.id)}
                    className={`text-left px-3 py-2.5 transition-all duration-150 active:scale-[0.97] ${variant === v.id ? "bg-primary text-on-primary" : "bg-surface-low border border-white/[0.04] hover:bg-surface-high"}`}>
                    <span className="font-headline text-[13px] font-extrabold block leading-tight">{v.label}</span>
                    <span className={`text-[10px] block mt-0.5 ${variant === v.id ? "text-on-primary/60" : "text-on-surface-variant/40"}`}>{v.desc}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Play as</h2>
              <div className="flex gap-1.5">
                {[{ id: "random", label: "Random" }, { id: "white", label: "White" }, { id: "black", label: "Black" }].map((c) => (
                  <button key={c.id} onClick={() => setColorPref(c.id)}
                    className={`flex-1 py-3 font-headline text-sm font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${colorPref === c.id ? "bg-primary text-on-primary" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary"}`}>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="p-3 bg-surface-low border border-white/[0.04] text-[11px] text-on-surface-variant/55">
              Challenge links are always <span className="text-on-surface-variant font-bold">casual</span> (unrated).
            </div>
            <button onClick={handleCreate} disabled={!isLoggedIn || creating}
              className="btn btn-primary w-full py-4 text-sm">
              {creating ? "Creating..." : "Create Link"}
            </button>
          </div>
        ) : (
          <div className="anim-fade-up max-w-md space-y-4" style={{ "--delay": "0.05s" }}>
            <div className="p-5 bg-surface-container border border-primary/20 text-center">
              <p className="text-[13px] text-on-surface-variant/50 mb-3">Share this link with your opponent:</p>
              <div className="bg-surface-low border border-white/[0.06] px-3 py-2 mb-3">
                <span className="text-[13px] font-mono text-primary select-all break-all">{link}</span>
              </div>
              <button onClick={() => { navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className={`px-5 py-2 font-headline text-[11px] font-bold uppercase tracking-wide transition-colors ${copied ? "bg-emerald-500/20 text-emerald-400" : "bg-primary text-on-primary hover:bg-primary-dim"}`}>
                {copied ? "Copied!" : "Copy Link"}
              </button>
            </div>
            <div className="flex items-center gap-3 justify-center">
              <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              <span className="text-[12px] text-on-surface-variant/40">Waiting for opponent to join...</span>
            </div>
            <p className="text-[11px] text-on-surface-variant/25 text-center">
              {tc}
              {variant && variant !== "standard" && ` · ${VARIANT_OPTIONS.find((v) => v.id === variant)?.label || variant}`}
              {" · Casual · Expires in 15 min"}
            </p>
            <button onClick={teardownAndExit}
              className="btn btn-secondary w-full py-2 text-[10px] hover:!text-error">
              Cancel
            </button>
          </div>
        )}
      </div>
      <SocialPanel />
    </div>
  );
}

export function JoinChallenge() {
  const { code } = useParams();
  const navigate = useNavigate();
  const { user, profile, loading: authLoading } = useAuth();
  const [challenge, setChallenge] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [joining, setJoining] = useState(false);

  const isLoggedIn = !!user && isOnline();


  useEffect(() => {
    if (!code) { setLoading(false); setError("Invalid link"); return; }
    if (!isOnline()) { setLoading(false); setError("Online features not available"); return; }
    getChallenge(code).then((ch) => {
      if (!ch) setError("Challenge not found or expired");
      else setChallenge(ch);
      setLoading(false);
    }).catch(() => {
      setError("Failed to load challenge"); setLoading(false);
    });
  }, [code]);

  const handleJoin = useCallback(async () => {
    if (!isLoggedIn || !challenge) return;
    setJoining(true);
    setError(null);
    try {
      const category = categoryFromTimeControl(challenge.time_control);
      const ratingsPromise = getRatings(user.id).catch(() => []);
      const ratingsTimeout = new Promise((r) => setTimeout(() => r([]), 3000));
      const ratings = await Promise.race([ratingsPromise, ratingsTimeout]);
      const r = ratings?.find((x) => x.category === category);
      const myRating = r ? Math.round(r.rating) : 1500;
      const myName = profile?.display_name || profile?.username || "Player";
      const game = await acceptChallengeRPC(challenge.id, user.id, myName, myRating);
      navigate(`/game/online/${game.id}`, { state: { gameData: game } });
    } catch (err) {
      setError(err.message || "Failed to join game");
      setJoining(false);
    }
  }, [isLoggedIn, challenge, user, profile, navigate]);

  if (loading || authLoading) {
    return (
      <div className="flex min-h-[calc(100dvh-4rem)]">
        <div className="flex-1 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (error && !challenge) {
    return (
      <div className="flex min-h-[calc(100dvh-4rem)]">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h1 className="font-headline text-2xl font-extrabold tracking-tighter text-on-surface-variant/30 mb-2">{error}</h1>
            <button onClick={() => navigate("/play")} className="mt-4 px-5 py-2 bg-primary text-on-primary font-headline text-xs font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors">Play</button>
          </div>
        </div>
      </div>
    );
  }

  if (!challenge) return null;

  return (
    <div className="flex min-h-[calc(100dvh-4rem)]">
      <div className="flex-1 flex flex-col items-center justify-center px-4">
        <button
          onClick={() => navigate("/play")}
          className="anim-fade-up self-start max-w-sm w-full mb-3 text-left inline-flex items-center gap-1.5 text-[11px] font-headline font-bold uppercase tracking-widest text-on-surface-variant/40 hover:text-primary transition-colors active:scale-[0.97]"
          style={{ "--delay": "0.04s" }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back to Play
        </button>
        <div className="anim-fade-up max-w-sm w-full p-6 bg-surface-container border border-white/[0.06] text-center" style={{ "--delay": "0.07s" }}>
          <h2 className="font-headline text-xl font-extrabold tracking-tighter text-primary mb-2">Game Challenge</h2>
          <p className="text-[13px] text-on-surface-variant/50 mb-4">
            <span className="font-bold text-on-surface-variant/70">{challenge.creator_name}</span> wants to play!
          </p>
          <div className="flex justify-center gap-3 flex-wrap mb-4 text-[12px] text-on-surface-variant/40">
            <span>{challenge.time_control}</span>
            <span>·</span>
            <span>Casual</span>
            <span>·</span>
            <span>~{Math.round(challenge.creator_rating)}</span>
            {challenge.variant && challenge.variant !== "standard" && (
              <>
                <span>·</span>
                <span className="text-primary/70 font-bold">
                  {VARIANT_OPTIONS.find((v) => v.id === challenge.variant)?.label || challenge.variant}
                </span>
              </>
            )}
          </div>
          {error && <p className="text-[12px] text-error mb-3">{error}</p>}
          {isLoggedIn && user?.id === challenge.creator_id ? (
            <p className="text-[12px] text-on-surface-variant/40">You created this challenge. Share the link with someone else.</p>
          ) : isLoggedIn ? (
            <button onClick={handleJoin} disabled={joining}
              className="w-full py-3 bg-primary text-on-primary font-headline text-sm font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.97] disabled:opacity-50">
              {joining ? "Joining..." : "Accept Challenge"}
            </button>
          ) : (
            <div className="space-y-3">
              <p className="text-[12px] text-amber-400 text-center">Sign in to accept this challenge</p>
              <button onClick={() => navigate("/")}
                className="w-full py-3 bg-primary text-on-primary font-headline text-sm font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors">
                Sign In
              </button>
            </div>
          )}
        </div>
      </div>
      <SocialPanel />
    </div>
  );
}
