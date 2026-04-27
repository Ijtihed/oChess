import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import ReactDOM from "react-dom";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { updateProfile, uploadAvatar, getRatings, getRecentGames, signOut } from "../lib/auth";
import { isOnline } from "../lib/supabase";
import { loadPuzzleRating } from "../lib/puzzles";
import { load as loadPrefs } from "../lib/board-prefs";
import SocialPanel from "./SocialPanel";

const HISTORY_KEY = "ochess_puzzle_history";
const STREAK_KEY = "ochess_puzzle_streak";

function getPuzzleStats() {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}");
    let solved = 0, failed = 0;
    for (const v of Object.values(h)) {
      if (v.result === "solved") solved++; else if (v.result === "failed") failed++;
    }
    return { solved, failed, total: Object.keys(h).length };
  } catch { return { solved: 0, failed: 0, total: 0 }; }
}

function getStreak() {
  try { const d = JSON.parse(localStorage.getItem(STREAK_KEY) || "{}"); return { current: d.current || 0, best: d.best || 0 }; }
  catch { return { current: 0, best: 0 }; }
}

const CATEGORY_LABELS = { bullet: "Bullet", blitz: "Blitz", rapid: "Rapid", classical: "Classical" };

const COUNTRIES = [
  { code: "AF", flag: "🇦🇫", name: "Afghanistan" }, { code: "AL", flag: "🇦🇱", name: "Albania" }, { code: "DZ", flag: "🇩🇿", name: "Algeria" },
  { code: "AR", flag: "🇦🇷", name: "Argentina" }, { code: "AU", flag: "🇦🇺", name: "Australia" }, { code: "AT", flag: "🇦🇹", name: "Austria" },
  { code: "BD", flag: "🇧🇩", name: "Bangladesh" }, { code: "BE", flag: "🇧🇪", name: "Belgium" }, { code: "BR", flag: "🇧🇷", name: "Brazil" },
  { code: "BG", flag: "🇧🇬", name: "Bulgaria" }, { code: "CA", flag: "🇨🇦", name: "Canada" }, { code: "CL", flag: "🇨🇱", name: "Chile" },
  { code: "CN", flag: "🇨🇳", name: "China" }, { code: "CO", flag: "🇨🇴", name: "Colombia" }, { code: "HR", flag: "🇭🇷", name: "Croatia" },
  { code: "CZ", flag: "🇨🇿", name: "Czech Republic" }, { code: "DK", flag: "🇩🇰", name: "Denmark" }, { code: "EG", flag: "🇪🇬", name: "Egypt" },
  { code: "EE", flag: "🇪🇪", name: "Estonia" }, { code: "FI", flag: "🇫🇮", name: "Finland" }, { code: "FR", flag: "🇫🇷", name: "France" },
  { code: "DE", flag: "🇩🇪", name: "Germany" }, { code: "GR", flag: "🇬🇷", name: "Greece" }, { code: "HU", flag: "🇭🇺", name: "Hungary" },
  { code: "IS", flag: "🇮🇸", name: "Iceland" }, { code: "IN", flag: "🇮🇳", name: "India" }, { code: "ID", flag: "🇮🇩", name: "Indonesia" },
  { code: "IR", flag: "🇮🇷", name: "Iran" }, { code: "IQ", flag: "🇮🇶", name: "Iraq" }, { code: "IE", flag: "🇮🇪", name: "Ireland" },
  { code: "IL", flag: "🇮🇱", name: "Israel" }, { code: "IT", flag: "🇮🇹", name: "Italy" }, { code: "JP", flag: "🇯🇵", name: "Japan" },
  { code: "KZ", flag: "🇰🇿", name: "Kazakhstan" }, { code: "KE", flag: "🇰🇪", name: "Kenya" }, { code: "KR", flag: "🇰🇷", name: "South Korea" },
  { code: "LV", flag: "🇱🇻", name: "Latvia" }, { code: "LB", flag: "🇱🇧", name: "Lebanon" }, { code: "LT", flag: "🇱🇹", name: "Lithuania" },
  { code: "MY", flag: "🇲🇾", name: "Malaysia" }, { code: "MX", flag: "🇲🇽", name: "Mexico" }, { code: "MA", flag: "🇲🇦", name: "Morocco" },
  { code: "NL", flag: "🇳🇱", name: "Netherlands" }, { code: "NZ", flag: "🇳🇿", name: "New Zealand" }, { code: "NG", flag: "🇳🇬", name: "Nigeria" },
  { code: "NO", flag: "🇳🇴", name: "Norway" }, { code: "PK", flag: "🇵🇰", name: "Pakistan" }, { code: "PE", flag: "🇵🇪", name: "Peru" },
  { code: "PH", flag: "🇵🇭", name: "Philippines" }, { code: "PL", flag: "🇵🇱", name: "Poland" }, { code: "PT", flag: "🇵🇹", name: "Portugal" },
  { code: "RO", flag: "🇷🇴", name: "Romania" }, { code: "RU", flag: "🇷🇺", name: "Russia" }, { code: "SA", flag: "🇸🇦", name: "Saudi Arabia" },
  { code: "RS", flag: "🇷🇸", name: "Serbia" }, { code: "SG", flag: "🇸🇬", name: "Singapore" }, { code: "SK", flag: "🇸🇰", name: "Slovakia" },
  { code: "SI", flag: "🇸🇮", name: "Slovenia" }, { code: "ZA", flag: "🇿🇦", name: "South Africa" }, { code: "ES", flag: "🇪🇸", name: "Spain" },
  { code: "SE", flag: "🇸🇪", name: "Sweden" }, { code: "CH", flag: "🇨🇭", name: "Switzerland" }, { code: "TW", flag: "🇹🇼", name: "Taiwan" },
  { code: "TH", flag: "🇹🇭", name: "Thailand" }, { code: "TN", flag: "🇹🇳", name: "Tunisia" }, { code: "TR", flag: "🇹🇷", name: "Turkey" },
  { code: "UA", flag: "🇺🇦", name: "Ukraine" }, { code: "AE", flag: "🇦🇪", name: "UAE" }, { code: "GB", flag: "🇬🇧", name: "United Kingdom" },
  { code: "US", flag: "🇺🇸", name: "United States" }, { code: "UZ", flag: "🇺🇿", name: "Uzbekistan" }, { code: "VE", flag: "🇻🇪", name: "Venezuela" },
  { code: "VN", flag: "🇻🇳", name: "Vietnam" },
];

function CountrySelect({ value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const btnRef = useRef(null);
  const dropRef = useRef(null);

  const selected = COUNTRIES.find((c) => c.name === value || c.code === value);
  const filtered = query
    ? COUNTRIES.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
    : COUNTRIES;

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (btnRef.current?.contains(e.target)) return;
      if (dropRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [open]);

  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  useEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left, width: r.width });
    }
  }, [open]);

  return (
    <div>
      <span id="profile-country-label" className="text-[10px] text-on-surface-variant/55 block mb-1">Country</span>
      <button ref={btnRef} onClick={() => { if (!disabled) { setOpen(!open); setQuery(""); } }} disabled={disabled}
        aria-labelledby="profile-country-label"
        aria-expanded={open}
        aria-haspopup="listbox"
        className="w-full bg-surface-lowest border border-white/[0.06] px-3 py-2 text-[12px] text-left flex items-center gap-2 disabled:opacity-50 hover:border-primary/40 transition-colors">
        {selected ? (
          <><span>{selected.flag}</span><span className="text-on-surface">{selected.name}</span></>
        ) : (
          <span className="text-on-surface-variant/40">Select country...</span>
        )}
      </button>
      {open && ReactDOM.createPortal(
        // 1000 keeps the dropdown above the page chrome (navbar=50,
        // board picker=60) but below modals (9000+) and the fatal
        // error overlay so a loading screen still covers it.
        <div ref={dropRef} style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, zIndex: 1000 }}
          className="bg-surface-container border border-white/[0.08] shadow-2xl max-h-[260px] flex flex-col">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search..."
            autoFocus
            className="w-full bg-surface-low border-b border-white/[0.06] px-3 py-2 text-[12px] text-on-surface placeholder:text-on-surface-variant/20 outline-none shrink-0" />
          <div className="overflow-y-auto flex-1">
            {filtered.length > 0 ? filtered.map((c) => (
              <button key={c.code} onClick={() => { onChange(c.name); setOpen(false); setQuery(""); }}
                className={`w-full text-left px-3 py-2 text-[12px] flex items-center gap-2 hover:bg-surface-high transition-colors ${value === c.name ? "bg-primary/10 text-primary" : "text-on-surface-variant/70"}`}>
                <span>{c.flag}</span><span>{c.name}</span>
              </button>
            )) : (
              <p className="px-3 py-2 text-[11px] text-on-surface-variant/25">No results</p>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export default function Profile() {
  const navigate = useNavigate();
  const { user: authUser, profile, refreshProfile } = useAuth();
  const isLoggedIn = !!authUser;
  const userName = profile?.display_name || profile?.username || authUser?.email?.split("@")[0] || "Guest";

  const [ratings, setRatings] = useState([]);
  const [recentGames, setRecentGames] = useState([]);
  const [editing, setEditing] = useState(false);
  const [formData, setFormData] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [copiedLink, setCopiedLink] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState(null);
  const avatarFileRef = useRef(null);

  const handleAvatarChange = useCallback(async (file) => {
    if (!authUser || !file) return;
    setAvatarUploading(true);
    setAvatarError(null);
    try {
      await uploadAvatar(authUser.id, file);
      await refreshProfile(authUser.id);
    } catch (err) {
      setAvatarError(err.message || "Couldn't upload that image");
      setTimeout(() => setAvatarError(null), 5000);
    } finally {
      setAvatarUploading(false);
      if (avatarFileRef.current) avatarFileRef.current.value = "";
    }
  }, [authUser, refreshProfile]);

  // Puzzle stats/rating/streak all live in localStorage. They were
  // previously memoized on mount (and so frozen until route remount),
  // which meant solving puzzles in the same session never updated
  // the profile. We track a refresh tick that bumps on focus / tab
  // visibility and re-read on every render to keep the UI honest.
  const [puzzleRefreshKey, setPuzzleRefreshKey] = useState(0);
  useEffect(() => {
    const refresh = () => setPuzzleRefreshKey((k) => k + 1);
    const onVis = () => { if (!document.hidden) refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const puzzleRating = useMemo(() => loadPuzzleRating(), [puzzleRefreshKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const puzzleStats = useMemo(() => getPuzzleStats(), [puzzleRefreshKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const streak = useMemo(() => getStreak(), [puzzleRefreshKey]);

  useEffect(() => {
    if (!authUser || !isOnline()) return;
    const timeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
    timeout(getRatings(authUser.id).catch(() => []), 5000).then((r) => setRatings(r || []));
    timeout(getRecentGames(authUser.id, 20).catch(() => []), 5000).then((g) => setRecentGames(g || []));
  }, [authUser]);

  useEffect(() => {
    if (profile) {
      setFormData({
        display_name: profile.display_name || "",
        username: profile.username || "",
        bio: profile.bio || "",
        country: profile.country || "",
        lichess_username: profile.lichess_username || "",
        chesscom_username: profile.chesscom_username || "",
      });
    }
  }, [profile]);

  const handleSave = useCallback(async () => {
    if (!authUser) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      await updateProfile(authUser.id, {
        display_name: formData.display_name || null,
        username: formData.username || null,
        bio: formData.bio || null,
        country: formData.country || null,
        lichess_username: formData.lichess_username || null,
        chesscom_username: formData.chesscom_username || null,
      });
      setSaving(false);
      setSaveMsg("Saved!");
      setEditing(false);
      setTimeout(() => setSaveMsg(null), 3000);
      refreshProfile(authUser.id);
    } catch (err) {
      setSaving(false);
      setSaveMsg(err.message || "Failed to save");
      setTimeout(() => setSaveMsg(null), 5000);
    }
  }, [authUser, formData, refreshProfile]);

  const handleLogout = useCallback(async () => {
    try { await signOut(); } catch {}
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("sb-")) localStorage.removeItem(key);
    }
    window.location.href = "/";
  }, []);

  const boardPrefs = loadPrefs();

  if (!authUser) {
    return (
      <div className="flex min-h-[calc(100dvh-4rem)]">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h1 className="font-headline text-2xl font-extrabold tracking-tighter text-on-surface-variant/55 mb-3">Not signed in</h1>
            <p className="text-[13px] text-on-surface-variant/55 mb-4">Sign in to view your profile</p>
            <Link to="/" className="btn btn-primary px-5 py-2 text-xs inline-block">Home</Link>
          </div>
        </div>
        <SocialPanel />
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100dvh-4rem)]">
      <div className="flex-1 min-w-0 px-4 sm:px-6 xl:pl-16 xl:pr-6 py-6 sm:py-10">
        {/* Header */}
        <div className="anim-fade-up flex items-center gap-4 sm:gap-5 mb-6" style={{ "--delay": "0.05s" }}>
          <div className="relative w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-surface-high flex items-center justify-center shrink-0 group">
            {/*
              Avatar fallback chain — must mirror what App.jsx feeds
              the navbar so the picture is consistent across reloads.
              For Google sign-ups, `handle_new_user` should populate
              `profiles.avatar_url` via the trigger, but on accounts
              created before that trigger ran, the metadata is the
              only source. Keep both branches.
            */}
            {(profile?.avatar_url || authUser?.user_metadata?.avatar_url || authUser?.user_metadata?.picture) ? (
              <img
                src={profile?.avatar_url || authUser?.user_metadata?.avatar_url || authUser?.user_metadata?.picture}
                alt=""
                className="w-full h-full rounded-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="font-headline text-2xl sm:text-3xl font-bold text-on-surface-variant/70 uppercase">
                {userName[0]}
              </span>
            )}
            {isLoggedIn && isOnline() && (
              <>
                <input ref={avatarFileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => handleAvatarChange(e.target.files?.[0])} />
                <button onClick={() => avatarFileRef.current?.click()} disabled={avatarUploading}
                  className="absolute inset-0 rounded-full flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity disabled:opacity-100"
                  aria-label="Change avatar">
                  {avatarUploading ? (
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <span className="text-[9px] font-headline font-bold uppercase tracking-widest text-white">Change</span>
                  )}
                </button>
              </>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-headline text-2xl sm:text-3xl font-extrabold tracking-tighter text-primary truncate">{userName}</h1>
            <p className="text-[12px] text-on-surface-variant/40">
              {isLoggedIn ? (
                profile?.username
                  ? <Link to={`/u/${profile.username}`} className="hover:text-primary transition-colors">@{profile.username}</Link>
                  : authUser.email
              ) : "Guest account"}
              {profile?.country && (() => { const c = COUNTRIES.find((x) => x.name === profile.country); return ` · ${c?.flag || ""} ${profile.country}`; })()}
            </p>
            {avatarError && <p className="text-[11px] text-error mt-1">{avatarError}</p>}
            {profile?.bio && <p className="text-[12px] text-on-surface-variant/50 mt-1 line-clamp-2">{profile.bio}</p>}
            {(profile?.lichess_username || profile?.chesscom_username) && (
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
          <div className="flex gap-2 shrink-0">
            {isLoggedIn && activeTab === "settings" && (
              <button onClick={() => setEditing(!editing)}
                className={`px-4 py-2 font-headline text-[10px] font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${editing ? "bg-primary text-on-primary" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/50 hover:text-primary"}`}>
                {editing ? "Cancel" : "Edit"}
              </button>
            )}
            <a href="/logout"
              className="px-4 py-2 bg-surface-low border border-white/[0.04] font-headline text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/40 hover:text-error hover:border-error/20 transition-colors active:scale-[0.96] inline-block">
              {isLoggedIn ? "Log Out" : "Sign Out"}
            </a>
          </div>
        </div>

        {/* Profile link
            Reserves vertical space whether or not `profile` has hydrated.
            Without this, the row vanishes during the brief window between
            getSession() restoring the auth user and getProfile() returning
            the username, which the user perceives as "the profile link
            disappears on reload". A faded placeholder keeps the layout
            stable and signals that the row is still loading. */}
        {isLoggedIn && (
          <div className="flex items-center gap-2 mb-4 px-1 min-h-[24px]">
            {profile?.username ? (
              <>
                <span className="text-[11px] text-on-surface-variant/25 font-mono select-all">{window.location.origin}/u/{profile.username}</span>
                <button onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/u/${profile.username}`); setCopiedLink(true); setTimeout(() => setCopiedLink(false), 2000); }}
                  className={`px-2.5 py-1 font-headline text-[9px] font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${copiedLink ? "bg-emerald-500/20 text-emerald-400" : "bg-surface-low border border-white/[0.04] text-on-surface-variant/40 hover:text-primary"}`}>
                  {copiedLink ? "Copied!" : "Copy Link"}
                </button>
              </>
            ) : (
              <span className="text-[11px] text-on-surface-variant/15 font-mono select-none" aria-hidden="true">
                {window.location.origin}/u/loading…
              </span>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-white/[0.04] pb-2">
          {["overview", "games", "settings"].map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 font-headline text-[11px] font-bold uppercase tracking-wide transition-colors ${activeTab === tab ? "text-primary border-b-2 border-primary" : "text-on-surface-variant/40 hover:text-on-surface-variant/70"}`}>
              {tab}
            </button>
          ))}
        </div>

        {/* ── Overview Tab ── */}
        {activeTab === "overview" && (
          <div className="space-y-6">
            {/* Game Ratings */}
            <div className="anim-fade-up" style={{ "--delay": "0.08s" }}>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Ratings</h2>
              {ratings.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {ratings.map((r) => (
                    <div key={r.category} className="p-4 bg-surface-low border border-white/[0.04]">
                      <span className="font-headline text-2xl font-extrabold text-primary block">{Math.round(r.rating)}</span>
                      <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/35">{CATEGORY_LABELS[r.category] || r.category}</span>
                      <div className="text-[9px] text-on-surface-variant/20 mt-1">
                        {r.games_played}G · {r.wins}W · {r.losses}L · {r.draws}D
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-5 bg-surface-low border border-white/[0.04] text-center">
                  <span className="text-sm text-on-surface-variant/55">Play rated games to see your ratings</span>
                  <div className="mt-3">
                    <button onClick={() => navigate("/play")} className="px-4 py-2 bg-primary text-on-primary font-headline text-xs font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors">Play Now</button>
                  </div>
                </div>
              )}
            </div>

            {/* Puzzle Stats */}
            <div className="anim-fade-up" style={{ "--delay": "0.14s" }}>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Puzzles</h2>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                <div className="p-4 bg-surface-low border border-white/[0.04]">
                  <span className="font-headline text-2xl font-extrabold text-primary block">{puzzleRating.rating}</span>
                  <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/35">Rating</span>
                </div>
                {[
                  { label: "Solved", value: puzzleStats.solved, color: "text-emerald-400" },
                  { label: "Failed", value: puzzleStats.failed, color: "text-error" },
                  { label: "Total", value: puzzleStats.total, color: "text-primary" },
                  { label: "Best Streak", value: streak.best, color: "text-primary" },
                ].map((s) => (
                  <div key={s.label} className="p-4 bg-surface-low border border-white/[0.04]">
                    <span className={`font-headline text-2xl font-extrabold block ${s.color}`}>{s.value}</span>
                    <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/35">{s.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Games Tab ── */}
        {activeTab === "games" && (
          <div className="anim-fade-up" style={{ "--delay": "0.05s" }}>
            <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Recent Games</h2>
            {recentGames.length > 0 ? (
              <div className="space-y-1">
                {recentGames.map((g) => {
                  const isWhite = g.white_id === authUser?.id;
                  const won = (isWhite && g.result === "1-0") || (!isWhite && g.result === "0-1");
                  const lost = (isWhite && g.result === "0-1") || (!isWhite && g.result === "1-0");
                  return (
                    <button key={g.id} onClick={() => navigate("/analysis", { state: { pgn: g.pgn } })}
                      className="w-full text-left px-4 py-3 bg-surface-low border border-white/[0.03] hover:bg-surface-high/40 hover:border-primary/15 transition-colors flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] font-mono text-on-surface-variant/70 truncate block">
                          {g.white_name || "?"} <span className="text-on-surface-variant/25">vs</span> {g.black_name || "?"}
                        </span>
                        <span className="text-[10px] text-on-surface-variant/30">
                          {g.variant !== "standard" && `${g.variant} · `}{g.time_control || "Unlimited"} · {g.result_reason}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-[11px] font-mono font-bold ${won ? "text-emerald-400" : lost ? "text-error" : "text-on-surface-variant/40"}`}>
                          {g.result}
                        </span>
                        {(isWhite ? g.white_rating_change : g.black_rating_change) != null && (
                          <span className={`text-[10px] font-mono ${(isWhite ? g.white_rating_change : g.black_rating_change) >= 0 ? "text-emerald-400" : "text-error"}`}>
                            {(isWhite ? g.white_rating_change : g.black_rating_change) >= 0 ? "+" : ""}{Math.round(isWhite ? g.white_rating_change : g.black_rating_change)}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="p-8 bg-surface-low border border-white/[0.04] text-center">
                <span className="text-sm text-on-surface-variant/25">No games yet</span>
              </div>
            )}
          </div>
        )}

        {/* ── Settings Tab ── */}
        {activeTab === "settings" && (
          <div className="space-y-6 max-w-lg">
            {/* Profile info */}
            <div className="anim-fade-up" style={{ "--delay": "0.05s" }}>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Profile</h2>
              <div className="bg-surface-low border border-white/[0.04] p-4 space-y-3">
                {[
                  { key: "display_name", label: "Display Name", placeholder: "Your name" },
                  { key: "username", label: "Username", placeholder: "unique_username" },
                  { key: "bio", label: "Bio", placeholder: "A short bio...", textarea: true },
                ].map(({ key, label, placeholder, textarea }) => {
                  const fieldId = `profile-${key}`;
                  return (
                    <div key={key}>
                      <label htmlFor={fieldId} className="text-[10px] text-on-surface-variant/55 block mb-1">{label}</label>
                      {textarea ? (
                        <textarea id={fieldId} value={formData[key] || ""} onChange={(e) => setFormData({ ...formData, [key]: e.target.value })} placeholder={placeholder} rows={2}
                          disabled={!editing}
                          className="w-full bg-surface-lowest border border-white/[0.06] px-3 py-2 text-[12px] text-on-surface placeholder:text-on-surface-variant/40 outline-none focus:border-primary/40 resize-none disabled:opacity-50" />
                      ) : (
                        <input id={fieldId} value={formData[key] || ""} onChange={(e) => setFormData({ ...formData, [key]: e.target.value })} placeholder={placeholder}
                          disabled={!editing}
                          className="w-full bg-surface-lowest border border-white/[0.06] px-3 py-2 text-[12px] text-on-surface placeholder:text-on-surface-variant/40 outline-none focus:border-primary/40 disabled:opacity-50" />
                      )}
                    </div>
                  );
                })}
                <CountrySelect value={formData.country || ""} onChange={(v) => setFormData({ ...formData, country: v })} disabled={!editing} />
              </div>
            </div>

            {/* Linked accounts */}
            <div className="anim-fade-up" style={{ "--delay": "0.1s" }}>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Linked Accounts</h2>
              <div className="bg-surface-low border border-white/[0.04] p-4 space-y-3">
                <div>
                  <label htmlFor="profile-lichess" className="text-[10px] text-on-surface-variant/55 block mb-1">Lichess Username</label>
                  <input id="profile-lichess" value={formData.lichess_username || ""} onChange={(e) => setFormData({ ...formData, lichess_username: e.target.value })} placeholder="your_lichess_name"
                    disabled={!editing} autoComplete="off"
                    className="w-full bg-surface-lowest border border-white/[0.06] px-3 py-2 text-[12px] text-on-surface placeholder:text-on-surface-variant/40 outline-none focus:border-primary/40 disabled:opacity-50" />
                </div>
                <div>
                  <label htmlFor="profile-chesscom" className="text-[10px] text-on-surface-variant/55 block mb-1">Chess.com Username</label>
                  <input id="profile-chesscom" value={formData.chesscom_username || ""} onChange={(e) => setFormData({ ...formData, chesscom_username: e.target.value })} placeholder="your_chesscom_name"
                    disabled={!editing} autoComplete="off"
                    className="w-full bg-surface-lowest border border-white/[0.06] px-3 py-2 text-[12px] text-on-surface placeholder:text-on-surface-variant/40 outline-none focus:border-primary/40 disabled:opacity-50" />
                </div>
              </div>
            </div>

            {/* Board preferences (read-only display) */}
            <div className="anim-fade-up" style={{ "--delay": "0.15s" }}>
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Board Preferences</h2>
              <div className="bg-surface-low border border-white/[0.04] p-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <span className="text-[10px] text-on-surface-variant/30 block mb-1">Piece Set</span>
                    <span className="text-[12px] text-on-surface-variant/60">{boardPrefs.pieceSet}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-on-surface-variant/30 block mb-1">Board Theme</span>
                    <span className="text-[12px] text-on-surface-variant/60">{boardPrefs.boardTheme}</span>
                  </div>
                </div>
                <p className="text-[10px] text-on-surface-variant/55 mt-2">Change board appearance from the settings icon in the navbar.</p>
              </div>
            </div>

            {/* Save */}
            {editing && (
              <div className="flex items-center gap-3">
                <button onClick={handleSave} disabled={saving}
                  className="px-6 py-2.5 bg-primary text-on-primary font-headline text-xs font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors active:scale-[0.96] disabled:opacity-50">
                  {saving ? "Saving..." : "Save Changes"}
                </button>
                {saveMsg && <span className={`text-[11px] ${saveMsg === "Saved!" ? "text-emerald-400" : "text-error"}`}>{saveMsg}</span>}
              </div>
            )}

            {/* Account info */}
            {isLoggedIn && (
              <div className="anim-fade-up" style={{ "--delay": "0.2s" }}>
                <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant/30 mb-3">Account</h2>
                <div className="bg-surface-low border border-white/[0.04] p-4 space-y-2">
                  <div className="flex justify-between text-[12px]">
                    <span className="text-on-surface-variant/30">Email</span>
                    <span className="text-on-surface-variant/60">{authUser.email}</span>
                  </div>
                  <div className="flex justify-between text-[12px]">
                    <span className="text-on-surface-variant/30">Member since</span>
                    <span className="text-on-surface-variant/60">{profile?.created_at ? new Date(profile.created_at).toLocaleDateString() : "—"}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <SocialPanel />
    </div>
  );
}
