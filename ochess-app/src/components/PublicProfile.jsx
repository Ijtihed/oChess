import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { getProfileByUsername, getRatings, getRecentGames } from "../lib/auth";
import { isOnline } from "../lib/supabase";
import { sendFriendRequest, getFriends, getPendingRequests, acceptFriendRequest, declineFriendRequest } from "../lib/friends";
import SocialPanel from "./SocialPanel";

const CATEGORY_LABELS = { bullet: "Bullet", blitz: "Blitz", rapid: "Rapid", classical: "Classical" };

export default function PublicProfile() {
  const { username } = useParams();
  const navigate = useNavigate();
  const { user: authUser, profile: myProfile } = useAuth();
  const [profile, setProfile] = useState(null);
  const [ratings, setRatings] = useState([]);
  const [games, setGames] = useState([]);
  const [gamesError, setGamesError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [friendStatus, setFriendStatus] = useState(null);
  const [incomingRequestId, setIncomingRequestId] = useState(null);
  const [outgoingRequestId, setOutgoingRequestId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [copiedLink, setCopiedLink] = useState(false);

  useEffect(() => {
    if (!username) { setLoading(false); setNotFound(true); return; }
    if (!isOnline()) { setLoading(false); setNotFound(true); return; }

    if (authUser && myProfile?.username === username) {
      navigate("/profile", { replace: true });
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      setNotFound(false);
      try {
        const p = await getProfileByUsername(username);
        if (cancelled) return;
        if (!p) { setNotFound(true); setLoading(false); return; }

        if (authUser && p.id === authUser.id) { navigate("/profile", { replace: true }); return; }

        setProfile(p);
        // Track ratings + games separately so a network failure on
        // games doesn't render as "no games" - shown as an explicit
        // error row instead.
        const [rRes, gRes] = await Promise.allSettled([
          getRatings(p.id),
          getRecentGames(p.id, 10),
        ]);
        if (cancelled) return;
        setRatings(rRes.status === "fulfilled" && rRes.value ? rRes.value : []);
        if (gRes.status === "fulfilled" && Array.isArray(gRes.value)) {
          setGames(gRes.value);
          setGamesError(false);
        } else {
          setGames([]);
          setGamesError(true);
        }

        if (authUser) {
          try {
            const [friends, pending] = await Promise.all([getFriends(authUser.id), getPendingRequests(authUser.id)]);
            if (cancelled) return;
            if (friends.some((f) => f.id === p.id)) setFriendStatus("friends");
            else if (pending.outgoing?.includes(p.id)) {
              setFriendStatus("pending");
              setOutgoingRequestId(pending.outgoingRequestIds?.[p.id] || null);
            } else {
              const incomingReq = pending.incoming?.find((r) => r.id === p.id);
              if (incomingReq) { setFriendStatus("incoming"); setIncomingRequestId(incomingReq.requestId); }
              else setFriendStatus(null);
            }
          } catch { setFriendStatus(null); }
        }
      } catch {
        if (!cancelled) setNotFound(true);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [username, authUser, myProfile]);

  const handleAddFriend = useCallback(async () => {
    if (!authUser || !profile) return;
    setAdding(true);
    setAddError(null);
    try {
      await sendFriendRequest(authUser.id, profile.id);
      setFriendStatus("pending");
    } catch (err) {
      setAddError(err.message || "Couldn't send the request");
      setTimeout(() => setAddError(null), 4000);
    }
    setAdding(false);
  }, [authUser, profile]);

  const handleAcceptFriend = useCallback(async () => {
    if (!incomingRequestId) return;
    setAdding(true);
    setAddError(null);
    try {
      await acceptFriendRequest(incomingRequestId);
      setFriendStatus("friends");
      setIncomingRequestId(null);
    } catch (err) {
      setAddError(err.message || "Couldn't accept the request");
      setTimeout(() => setAddError(null), 4000);
    }
    setAdding(false);
  }, [incomingRequestId]);

  const handleWithdrawRequest = useCallback(async () => {
    if (!outgoingRequestId) return;
    setAdding(true);
    setAddError(null);
    try {
      // declineFriendRequest also deletes the row, so it's the right
      // primitive for "withdraw my own request" too - same operation.
      await declineFriendRequest(outgoingRequestId);
      setFriendStatus(null);
      setOutgoingRequestId(null);
    } catch (err) {
      setAddError(err.message || "Couldn't withdraw the request");
      setTimeout(() => setAddError(null), 4000);
    }
    setAdding(false);
  }, [outgoingRequestId]);

  if (loading) {
    return (
      <div className="flex min-h-[calc(100dvh-4rem)]">
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            <span className="text-[11px] uppercase tracking-widest text-on-surface-variant/40">
              Loading profile&hellip;
            </span>
          </div>
        </div>
        <SocialPanel />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="flex min-h-[calc(100dvh-4rem)]">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h1 className="font-headline text-3xl font-extrabold tracking-tighter text-on-surface-variant/55 mb-2">User not found</h1>
            <p className="text-[13px] text-on-surface-variant/55 mb-4">No player with username "{username}"</p>
            <button onClick={() => navigate("/")} className="btn btn-primary px-5 py-2 text-xs">Home</button>
          </div>
        </div>
        <SocialPanel />
      </div>
    );
  }

  if (!profile) return null;

  const displayName = profile.display_name || profile.username || "?";
  const profileUrl = `${window.location.origin}/u/${profile.username}`;

  return (
    <div className="flex min-h-[calc(100dvh-4rem)]">
      <div className="flex-1 min-w-0 px-4 sm:px-6 xl:pl-16 xl:pr-6 py-6 sm:py-10">
        {/* Header */}
        <div className="anim-fade-up flex items-start gap-4 sm:gap-5 mb-4" style={{ "--delay": "0.05s" }}>
          <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-surface-high flex items-center justify-center shrink-0 overflow-hidden">
            {profile.avatar_url ? (
              <img src={profile.avatar_url} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
            ) : (
              <span className="font-headline text-2xl sm:text-3xl font-bold text-on-surface-variant/70 uppercase">{displayName[0]}</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-headline text-2xl sm:text-3xl font-extrabold tracking-tighter text-primary truncate">{displayName}</h1>
            <p className="text-[12px] text-on-surface-variant/40">
              @{profile.username}
              {profile.country && ` · ${profile.country}`}
            </p>
            {profile.bio && <p className="text-[12px] text-on-surface-variant/50 mt-1">{profile.bio}</p>}
            {(profile.lichess_username || profile.chesscom_username) && (
              <div className="flex gap-3 mt-1.5">
                {profile.lichess_username && (
                  <a href={`https://lichess.org/@/${profile.lichess_username}`} target="_blank" rel="noopener noreferrer"
                    className="text-[11px] text-on-surface-variant/30 hover:text-primary transition-colors">Lichess: {profile.lichess_username}</a>
                )}
                {profile.chesscom_username && (
                  <a href={`https://www.chess.com/member/${profile.chesscom_username}`} target="_blank" rel="noopener noreferrer"
                    className="text-[11px] text-on-surface-variant/30 hover:text-primary transition-colors">Chess.com: {profile.chesscom_username}</a>
                )}
              </div>
            )}
          </div>
          <div className="shrink-0 flex flex-col gap-2">
            {authUser && friendStatus === null && (
              <button onClick={handleAddFriend} disabled={adding}
                className="px-5 py-2.5 bg-primary text-on-primary font-headline text-[11px] font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.96] disabled:opacity-50">
                {adding ? "..." : "Add Friend"}
              </button>
            )}
            {authUser && friendStatus === "incoming" && (
              <button onClick={handleAcceptFriend} disabled={adding}
                className="px-5 py-2.5 bg-primary text-on-primary font-headline text-[11px] font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.96] disabled:opacity-50">
                {adding ? "..." : "Accept Request"}
              </button>
            )}
            {friendStatus === "pending" && (
              <div className="flex flex-col gap-1.5 items-end">
                <span className="px-4 py-2.5 bg-surface-low border border-white/[0.06] font-headline text-[11px] font-bold uppercase tracking-wide text-on-surface-variant/55">Request Sent</span>
                {outgoingRequestId && (
                  <button onClick={handleWithdrawRequest} disabled={adding}
                    className="text-[10px] font-headline font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-error transition-colors disabled:opacity-50">
                    {adding ? "..." : "Withdraw"}
                  </button>
                )}
              </div>
            )}
            {friendStatus === "friends" && (
              <span className="px-4 py-2.5 bg-emerald-500/10 border border-emerald-500/20 font-headline text-[11px] font-bold uppercase tracking-wide text-emerald-400">Friends</span>
            )}
            {!authUser && (
              <span className="text-[11px] text-on-surface-variant/55">Sign in to add friend</span>
            )}
            {addError && <span className="text-[11px] text-error">{addError}</span>}
          </div>
        </div>

        {/* Profile link */}
        <div className="flex items-center gap-2 mb-6 px-1">
          <span className="text-[11px] text-on-surface-variant/25 font-mono select-all">{profileUrl}</span>
          <button onClick={() => { navigator.clipboard.writeText(profileUrl); setCopiedLink(true); setTimeout(() => setCopiedLink(false), 2000); }}
            className={`px-2.5 py-1 font-headline text-[9px] font-bold uppercase tracking-wide transition-colors ${copiedLink ? "bg-emerald-500/20 text-emerald-400" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/40 hover:text-primary"}`}>
            {copiedLink ? "Copied!" : "Copy"}
          </button>
        </div>

        {/* Ratings */}
        {ratings.length > 0 && (
          <div className="anim-fade-up mb-8" style={{ "--delay": "0.1s" }}>
            <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Ratings</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {ratings.map((r) => (
                <div key={r.category} className="p-4 bg-surface-low border border-white/[0.04]">
                  <span className="font-headline text-2xl font-extrabold text-primary block">{Math.round(r.rating)}</span>
                  <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/35">{CATEGORY_LABELS[r.category] || r.category}</span>
                  <div className="text-[9px] text-on-surface-variant/20 mt-1">{r.games_played}G · {r.wins}W · {r.losses}L</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent Games - always render the section header so the
            "no games" / load-failure states are visible instead of
            silently disappearing. */}
        <div className="anim-fade-up" style={{ "--delay": "0.15s" }}>
          <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/55 mb-3">Recent Games</h2>
          {gamesError ? (
            <div className="p-4 bg-error/10 border border-error/20 text-[12px] text-error">
              Couldn't load this player's games. Try again later.
            </div>
          ) : games.length > 0 ? (
            <div className="space-y-1">
              {games.map((g) => {
                const isWhite = g.white_id === profile.id;
                const won = (isWhite && g.result === "1-0") || (!isWhite && g.result === "0-1");
                const lost = (isWhite && g.result === "0-1") || (!isWhite && g.result === "1-0");
                return (
                  <button key={g.id} onClick={() => navigate("/analysis", { state: { pgn: g.pgn } })}
                    className="w-full text-left px-4 py-3 bg-surface-low border border-white/[0.03] hover:bg-surface-high/40 transition-colors flex items-center justify-between">
                    <span className="text-[13px] font-mono text-on-surface-variant/70 truncate">
                      {g.white_name || "?"} <span className="text-on-surface-variant/40">vs</span> {g.black_name || "?"}
                    </span>
                    <span className={`text-[11px] font-mono font-bold ${won ? "text-emerald-400" : lost ? "text-error" : "text-on-surface-variant/55"}`}>{g.result}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="p-6 bg-surface-low border border-white/[0.04] text-center">
              <span className="text-[12px] text-on-surface-variant/55">No games yet</span>
            </div>
          )}
        </div>

        {ratings.length === 0 && games.length === 0 && !gamesError && (
          <p className="mt-6 text-[11px] text-on-surface-variant/55 text-center">
            This player hasn't played any rated games yet.
          </p>
        )}
      </div>
      <SocialPanel />
    </div>
  );
}
