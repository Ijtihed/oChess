import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { isOnline, supabase } from "../lib/supabase";
import { getChallenge, acceptChallengeRPC, createChallenge, deleteChallenge, watchChallenge, pollChallenge } from "../lib/challenges";
import { getRatings } from "../lib/auth";
import { categoryFromTimeControl } from "../lib/glicko2";
import SocialPanel from "./SocialPanel";

const TIME_CONTROLS = ["1+0", "3+0", "3+2", "5+0", "5+3", "10+0", "10+5", "15+10", "30+0"];

export function CreateChallenge() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [tc, setTc] = useState("10+0");
  const [colorPref, setColorPref] = useState("random");
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
        timeControl: tc, colorPref,
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
  }, [isLoggedIn, user, profile, tc, colorPref, navigateToGame]);

  useEffect(() => () => {
    watchRef.current?.unsubscribe();
    if (expiryRef.current) clearTimeout(expiryRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  const link = challenge ? `${window.location.origin}/challenge/${challenge.code}` : null;

  return (
    <div className="flex min-h-[calc(100vh-4rem)]">
      <div className="flex-1 min-w-0 px-4 sm:px-6 xl:pl-16 xl:pr-6 py-6 sm:py-10">
        <h1 className="font-headline text-3xl font-extrabold tracking-tighter text-primary mb-6">Create Challenge</h1>

        {!isLoggedIn && (
          <div className="p-4 bg-amber-500/10 border border-amber-500/20 text-[12px] text-amber-400 mb-6">Sign in to create game links.</div>
        )}
        {expired && (
          <div className="max-w-md p-4 bg-error/10 border border-error/20 text-[12px] text-error mb-4">Challenge expired. Create a new one.</div>
        )}
        {error && (
          <div className="max-w-md p-4 bg-error/10 border border-error/20 text-[12px] text-error mb-4">{error}</div>
        )}

        {!challenge ? (
          <div className="max-w-md space-y-5">
            <div>
              <label className="text-[11px] text-on-surface-variant/30 block mb-2">Time Control</label>
              <div className="grid grid-cols-3 gap-1.5">
                {TIME_CONTROLS.map((t) => (
                  <button key={t} onClick={() => setTc(t)}
                    className={`py-2.5 font-headline text-sm font-bold transition-colors ${tc === t ? "bg-primary text-on-primary" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary"}`}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-[11px] text-on-surface-variant/30 block mb-2">Play as</label>
              <div className="flex gap-1.5">
                {[{ id: "random", label: "Random" }, { id: "white", label: "White" }, { id: "black", label: "Black" }].map((c) => (
                  <button key={c.id} onClick={() => setColorPref(c.id)}
                    className={`flex-1 py-2.5 font-headline text-[11px] font-bold uppercase transition-colors ${colorPref === c.id ? "bg-primary text-on-primary" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary"}`}>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="p-3 bg-surface-low border border-white/[0.04] text-[11px] text-on-surface-variant/30">
              Challenge links are always <span className="text-on-surface-variant/50 font-bold">casual</span> (unrated).
            </div>
            <button onClick={handleCreate} disabled={!isLoggedIn || creating}
              className="w-full py-3 bg-primary text-on-primary font-headline text-sm font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.97] disabled:opacity-50">
              {creating ? "Creating..." : "Create Link"}
            </button>
          </div>
        ) : (
          <div className="max-w-md space-y-4">
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
            <p className="text-[11px] text-on-surface-variant/25 text-center">{tc} · Casual · Expires in 15 min</p>
            <a href="/play"
              onPointerDown={() => {
                watchRef.current?.unsubscribe();
                if (expiryRef.current) clearTimeout(expiryRef.current);
                if (pollRef.current) clearInterval(pollRef.current);
                if (challenge) deleteChallenge(challenge.id).catch(() => {});
              }}
              className="w-full py-2 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-error transition-colors block text-center">
              Cancel
            </a>
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
      <div className="flex min-h-[calc(100vh-4rem)]">
        <div className="flex-1 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (error && !challenge) {
    return (
      <div className="flex min-h-[calc(100vh-4rem)]">
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
    <div className="flex min-h-[calc(100vh-4rem)]">
      <div className="flex-1 flex items-center justify-center">
        <div className="max-w-sm w-full p-6 bg-surface-container border border-white/[0.06] text-center">
          <h2 className="font-headline text-xl font-extrabold tracking-tighter text-primary mb-2">Game Challenge</h2>
          <p className="text-[13px] text-on-surface-variant/50 mb-4">
            <span className="font-bold text-on-surface-variant/70">{challenge.creator_name}</span> wants to play!
          </p>
          <div className="flex justify-center gap-4 mb-4 text-[12px] text-on-surface-variant/40">
            <span>{challenge.time_control}</span><span>·</span><span>Casual</span><span>·</span><span>~{Math.round(challenge.creator_rating)}</span>
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
