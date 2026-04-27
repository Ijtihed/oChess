import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { isOnline, supabase } from "../lib/supabase";
import { getFriends, getPendingRequests, searchUsers, sendFriendRequest, acceptFriendRequest, declineFriendRequest, removeFriend } from "../lib/friends";
import { makeLogger } from "../lib/log";

const { log } = makeLogger("social");

function Avatar({ url, name, size = "w-8 h-8" }) {
  return url ? (
    <img src={url} alt="" className={`${size} rounded-full object-cover`} referrerPolicy="no-referrer" />
  ) : (
    <div className={`${size} rounded-full bg-surface-high flex items-center justify-center`}>
      <span className="font-headline text-[10px] font-bold text-on-surface-variant/50 uppercase">{name?.[0] || "?"}</span>
    </div>
  );
}

export default function SocialPanel() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // The panel renders on every signed-in route at >= 2xl - including
  // game routes. Players asked for the friends list to stay visible
  // while playing so they can issue rematches / start a new game
  // with someone they just played without leaving the board screen.
  // Width-gating already happens via Tailwind classes on the
  // outermost wrapper (`hidden 2xl:flex`), so on smaller viewports
  // it's never in the way.
  const path = location.pathname;
  // Lobby pages (challenge create / accept) keep the side rail
  // hidden because they're already centered cards.
  const isLobbyRoute =
    path === "/create-challenge" ||
    path.startsWith("/challenge/");
  const [friends, setFriends] = useState([]);
  const [pending, setPending] = useState({ incoming: [], outgoing: [] });
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [sentIds, setSentIds] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [addError, setAddError] = useState(null);

  const loadData = useCallback(async () => {
    // No user OR offline: this is the resting state, not a load. Reset
    // the spinner so the "Friends" panel never sits stuck on the loader
    // when the auth context is still settling.
    if (!user || !isOnline()) {
      log("skip - user:", user?.id, "online:", isOnline());
      setLoading(false);
      setFriends([]);
      setPending({ incoming: [], outgoing: [] });
      setSentIds(new Set());
      return;
    }
    log("loading friends for user:", user.id);
    setLoading(true);
    setLoadError(null);
    try {
      // 4 s upper bound - anything slower is effectively unusable, and
      // a falsy fallback unblocks the spinner cleanly. The timeout
      // never throws; it resolves with the fallback.
      const withTimeout = (p, ms, fallback) =>
        Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

      const [f, p] = await Promise.all([
        withTimeout(getFriends(user.id).catch((e) => { log("getFriends error:", e); return []; }), 4000, []),
        withTimeout(getPendingRequests(user.id).catch((e) => { log("getPendingRequests error:", e); return null; }), 4000, null),
      ]);

      log("loaded - friends:", f?.length, "pending:", p);
      setFriends(f || []);
      const pData = p || { incoming: [], outgoing: [], outgoingRequestIds: {} };
      setPending(pData);
      setSentIds(new Set(pData.outgoing || []));
    } catch (e) {
      log("loadData exception:", e);
      setLoadError("Could not load friends");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadData();
    // Fall back to a slow poll for safety (e.g. realtime publication
    // disabled on the project), but the channel below is the fast
    // path for accept/decline/remove on either side of the pair.
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  // Live updates from the friendships table - instant rather than
  // 30 s polling. Filtering by the current user's id is done on the
  // RLS layer (see schema.sql); we just refresh on any change.
  useEffect(() => {
    if (!user || !supabase) return;
    const ch = supabase
      .channel(`friendships:${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "friendships" }, () => {
        log("friendships change received");
        loadData();
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user, loadData]);

  const searchTimer = useRef(null);
  const handleSearch = useCallback((q) => {
    setSearch(q);
    if (!q.trim() || !user) { setSearchResults([]); setSearching(false); return; }
    setSearching(true);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      try {
        const results = await searchUsers(q.trim(), user.id);
        setSearchResults(results);
      } catch { setSearchResults([]); }
      finally { setSearching(false); }
    }, 400);
  }, [user]);

  const friendIds = new Set(friends.map((f) => f.id));
  const incomingIds = new Set((pending.incoming || []).map((r) => r.id));

  const handleAdd = useCallback(async (friendId) => {
    if (!user) return;
    setAddError(null);
    try {
      await sendFriendRequest(user.id, friendId);
      setSentIds((prev) => new Set([...prev, friendId]));
      setTimeout(() => loadData(), 1000);
    } catch (e) {
      log("handleAdd error:", e);
      setAddError("Could not send request");
    }
  }, [user, loadData]);

  const handleAccept = useCallback(async (requestId) => {
    try { await acceptFriendRequest(requestId); } catch {}
    loadData();
  }, [loadData]);

  const handleDecline = useCallback(async (requestId) => {
    try { await declineFriendRequest(requestId); } catch {}
    loadData();
  }, [loadData]);

  const handleRemove = useCallback(async (friendshipId) => {
    try { await removeFriend(friendshipId); } catch {}
    loadData();
  }, [loadData]);

  const isLoggedIn = !!user && isOnline();

  const challengeFriend = useCallback(() => {
    navigate("/create-challenge");
  }, [navigate]);

  if (isLobbyRoute) return null;

  const getUserStatus = (userId) => {
    if (friendIds.has(userId)) return "friends";
    if (sentIds.has(userId)) return "requested";
    if (incomingIds.has(userId)) return "incoming";
    return "none";
  };

  return (
    <div className="hidden 2xl:flex w-[260px] shrink-0 flex-col gap-5 border-l border-white/[0.03] px-5 py-5 sticky top-16 h-[calc(100vh-4rem)] overflow-y-auto">

      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="font-headline text-sm font-bold uppercase tracking-widest text-on-surface-variant/30">Friends</h3>
            {loading && (
              <div className="w-3 h-3 border border-primary/30 border-t-primary rounded-full animate-spin" />
            )}
          </div>
          {isLoggedIn && (
            <button onClick={() => setShowSearch(!showSearch)}
              className="text-[10px] text-on-surface-variant/30 hover:text-primary transition-colors">
              {showSearch ? "Close" : "+ Add"}
            </button>
          )}
        </div>

        {loadError && (
          <p className="text-[10px] text-error/60 mb-2 text-center">{loadError} - <button onClick={loadData} className="underline hover:text-error transition-colors">retry</button></p>
        )}

        {/* Search */}
        {showSearch && isLoggedIn && (
          <div className="mb-3 space-y-1.5">
            <input value={search} onChange={(e) => handleSearch(e.target.value)} placeholder="Search by username..."
              autoFocus
              className="w-full bg-surface-low border border-white/[0.06] px-2.5 py-1.5 text-[12px] text-on-surface placeholder:text-on-surface-variant/20 outline-none focus:border-primary/40" />
            {addError && <p className="text-[10px] text-error/70">{addError}</p>}
            {searchResults.length > 0 && (
              <div className="space-y-1">
                {searchResults.map((u) => {
                  const status = getUserStatus(u.id);
                  return (
                    <div key={u.id} className="flex items-center justify-between py-1.5 px-2 bg-surface-low/50 border border-white/[0.02] hover:bg-surface-high/30 transition-colors">
                      <Link to={`/u/${u.username}`} className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity">
                        <Avatar url={u.avatar_url} name={u.display_name || u.username} size="w-6 h-6" />
                        <div className="min-w-0">
                          <span className="text-[12px] font-bold text-on-surface-variant/60 block truncate leading-tight">{u.display_name || u.username}</span>
                          <span className="text-[9px] text-on-surface-variant/25">@{u.username}</span>
                        </div>
                      </Link>
                      <div className="shrink-0 ml-1">
                        {status === "friends" && (
                          <span className="text-[9px] text-emerald-400 font-bold">Friends</span>
                        )}
                        {status === "requested" && (
                          <span className="text-[9px] text-on-surface-variant/30 font-bold">Requested</span>
                        )}
                        {status === "incoming" && (
                          <span className="text-[9px] text-primary font-bold">Wants you</span>
                        )}
                        {status === "none" && (
                          <button onClick={() => handleAdd(u.id)}
                            className="px-2 py-0.5 text-[9px] font-bold bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
                            Add
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {search && !searching && searchResults.length === 0 && (
              <p className="text-[10px] text-on-surface-variant/20">No users found</p>
            )}
            {searching && <p className="text-[10px] text-on-surface-variant/20">Searching...</p>}
          </div>
        )}

        {/* Pending incoming requests */}
        {(pending.incoming || []).length > 0 && (
          <div className="mb-3">
            <span className="text-[10px] text-primary/60 font-bold block mb-1.5">
              {pending.incoming.length} Friend Request{pending.incoming.length > 1 ? "s" : ""}
            </span>
            <div className="space-y-1">
              {pending.incoming.map((r) => (
                <div key={r.requestId} className="py-2 px-2.5 bg-primary/5 border border-primary/10">
                  <Link to={`/u/${r.username}`} className="flex items-center gap-2 mb-1.5 hover:opacity-80 transition-opacity">
                    <Avatar url={r.avatar_url} name={r.display_name || r.username} size="w-7 h-7" />
                    <div className="min-w-0">
                      <span className="text-[12px] font-bold text-on-surface-variant/70 block truncate leading-tight">{r.display_name || r.username}</span>
                      <span className="text-[9px] text-on-surface-variant/30">@{r.username}</span>
                    </div>
                  </Link>
                  <div className="flex gap-1.5">
                    <button onClick={() => handleAccept(r.requestId)}
                      className="flex-1 py-1.5 text-[10px] font-bold bg-primary text-on-primary hover:bg-primary-dim transition-colors text-center">
                      Accept
                    </button>
                    <button onClick={() => handleDecline(r.requestId)}
                      className="flex-1 py-1.5 text-[10px] font-bold bg-surface-low text-on-surface-variant/40 hover:text-error transition-colors text-center">
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Friends list */}
        {loading && friends.length === 0 && !loadError ? (
          <div className="flex justify-center py-6">
            <div className="w-4 h-4 border-2 border-primary/20 border-t-primary/60 rounded-full animate-spin" />
          </div>
        ) : friends.length > 0 ? (
          <div className="space-y-1">
            {friends.map((f) => (
              <div key={f.friendshipId} className="flex items-center justify-between py-2 px-2.5 bg-surface-low/50 border border-white/[0.02] hover:bg-surface-high/30 transition-colors group">
                <Link to={`/u/${f.username}`} className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity">
                  <Avatar url={f.avatar_url} name={f.display_name || f.username} />
                  <div className="min-w-0">
                    <span className="font-headline text-[13px] font-bold text-on-surface-variant/60 block leading-tight truncate">{f.display_name || f.username}</span>
                    {f.username && <span className="text-[10px] text-on-surface-variant/25">@{f.username}</span>}
                  </div>
                </Link>
                <div className="flex gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <button onClick={() => challengeFriend(f.display_name || f.username)}
                    aria-label={`Play with ${f.display_name || f.username}`}
                    className="flex items-center gap-1 text-[10px] font-headline font-bold uppercase tracking-wide text-primary/60 hover:text-primary transition-colors">
                    <svg width="9" height="9" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                      <path d="M3 2 L10 6 L3 10 Z" />
                    </svg>
                    Play
                  </button>
                  <button onClick={() => handleRemove(f.friendshipId)}
                    aria-label={`Remove ${f.display_name || f.username}`}
                    className="text-[10px] text-on-surface-variant/20 hover:text-error transition-colors">
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                      <path d="M3 3 L9 9 M9 3 L3 9" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : isLoggedIn ? (
          <div className="text-center py-4">
            <p className="text-[11px] text-on-surface-variant/25 mb-2">No friends yet</p>
            {!showSearch && (
              <button onClick={() => setShowSearch(true)}
                className="text-[11px] text-primary/50 hover:text-primary transition-colors">Search for players</button>
            )}
          </div>
        ) : (
          <div className="text-center py-4">
            <p className="text-[11px] text-on-surface-variant/25">Sign in to add friends</p>
          </div>
        )}
      </div>
    </div>
  );
}
