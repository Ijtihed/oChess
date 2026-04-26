import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { searchUsers } from "../lib/friends";
import { isOnline } from "../lib/supabase";

const NAV_LINKS = [
  { id: "home",     label: "Home" },
  { id: "play",     label: "Play" },
  { id: "puzzles",  label: "Puzzles" },
  { id: "variants", label: "Variants" },
  { id: "analysis", label: "Analysis" },
  { id: "study",    label: "Study" },
  { id: "review",   label: "Anki" },
];

export default function Navbar({ activePage, onNavigate, user, onAuthClick }) {
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const searchRef = useRef(null);
  const searchTimer = useRef(null);

  const handleNav = (id) => {
    onNavigate(id);
    setMobileOpen(false);
    setSearchOpen(false);
  };

  const handleSearchInput = useCallback((q) => {
    setSearchQuery(q);
    if (!q.trim() || !isOnline()) { setSearchResults([]); return; }
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      try {
        const results = await searchUsers(q.trim(), user?.id || "none");
        setSearchResults(results);
      } catch { setSearchResults([]); }
    }, 350);
  }, [user]);

  useEffect(() => {
    if (!searchOpen) return;
    const handler = (e) => { if (searchRef.current && !searchRef.current.contains(e.target)) { setSearchOpen(false); setSearchQuery(""); setSearchResults([]); } };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [searchOpen]);

  // Close the mobile menu when the user taps anywhere outside of the
  // navbar element itself (the menu lives inside <nav>, so any pointer
  // event landing on the page below should dismiss it).
  const navRef = useRef(null);
  useEffect(() => {
    if (!mobileOpen) return;
    const handler = (e) => {
      if (navRef.current && !navRef.current.contains(e.target)) setMobileOpen(false);
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [mobileOpen]);

  const isLoggedIn = !!user;
  const showSignIn = !user || user.guest;

  return (
    <nav ref={navRef} className="fixed top-0 w-full z-50 bg-surface-lowest/80 backdrop-blur-xl">
      <div className="max-w-[1440px] mx-auto flex items-center justify-between px-5 sm:px-6 md:px-10 h-16">
        {/* Logo */}
        <button
          onClick={() => handleNav("home")}
          className="font-headline text-[1.7rem] sm:text-[2.1rem] font-extrabold tracking-tighter text-primary select-none hover:opacity-80 transition-opacity py-2 px-1"
        >
          oChess
        </button>

        {/* Desktop nav links */}
        <div className="hidden md:flex items-center gap-1">
          {NAV_LINKS.map((link) => (
            <button
              key={link.id}
              onClick={() => handleNav(link.id)}
              className={`font-headline text-[11px] font-bold uppercase tracking-wide transition-colors duration-200 px-3 py-2.5 ${
                activePage === link.id
                  ? "text-primary"
                  : "text-on-surface-variant/60 hover:text-primary"
              }`}
            >
              {link.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div ref={searchRef} className="hidden md:block relative">
          {searchOpen ? (
            <div>
              <input value={searchQuery} onChange={(e) => handleSearchInput(e.target.value)} placeholder="Search players..."
                autoFocus
                className="w-48 bg-surface-low border border-white/[0.08] px-3 py-1.5 text-[12px] text-on-surface placeholder:text-on-surface-variant/30 outline-none focus:border-primary/40" />
              {searchResults.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-surface-container border border-white/[0.08] shadow-xl z-50 max-h-[240px] overflow-y-auto">
                  {searchResults.map((u) => (
                    <button key={u.id} onClick={() => { navigate(`/u/${u.username}`); setSearchOpen(false); setSearchQuery(""); setSearchResults([]); }}
                      className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-surface-high transition-colors">
                      {u.avatar_url ? (
                        <img src={u.avatar_url} alt="" className="w-6 h-6 rounded-full object-cover" referrerPolicy="no-referrer" />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-surface-high flex items-center justify-center">
                          <span className="text-[8px] font-bold text-on-surface-variant/50 uppercase">{(u.display_name || u.username)?.[0]}</span>
                        </div>
                      )}
                      <div className="min-w-0">
                        <span className="text-[12px] font-bold text-on-surface-variant/70 block truncate">{u.display_name || u.username}</span>
                        <span className="text-[10px] text-on-surface-variant/30">@{u.username}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button onClick={() => setSearchOpen(true)}
              className="p-2 text-on-surface-variant/40 hover:text-primary transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
              </svg>
            </button>
          )}
        </div>

        {/* Right side */}
        <div className="flex items-center gap-2">
          {showSignIn ? (
            <button
              onClick={onAuthClick}
              className="hidden md:inline-flex px-5 py-2 bg-primary text-on-primary font-headline text-[11px] font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors duration-200"
            >
              Sign In
            </button>
          ) : (
            <button
              onClick={() => handleNav("profile")}
              className={`hidden md:flex items-center gap-2 py-2 px-3 transition-colors ${
                activePage === "profile" ? "bg-surface-high/40" : "hover:bg-surface-high/30"
              }`}
            >
              {user.avatar ? (
                <img src={user.avatar} alt="" className="w-7 h-7 rounded-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <div className="w-7 h-7 rounded-full bg-surface-high flex items-center justify-center">
                  <span className="font-headline text-[10px] font-bold text-on-surface-variant uppercase">{user.name?.[0] || "U"}</span>
                </div>
              )}
              <span className="font-headline text-[11px] font-bold text-on-surface-variant/70">
                {user.name?.split(" ")[0]}
              </span>
            </button>
          )}

          {/* Mobile: sign-in chip or avatar */}
          {showSignIn ? (
            <button
              onClick={onAuthClick}
              className="md:hidden px-3 py-1.5 bg-primary text-on-primary font-headline text-[10px] font-bold uppercase tracking-wide active:scale-95 transition-transform"
            >
              Sign In
            </button>
          ) : (
            <button
              onClick={() => handleNav("profile")}
              className="md:hidden w-8 h-8 rounded-full bg-surface-high flex items-center justify-center active:scale-90 transition-transform overflow-hidden"
            >
              {user.avatar ? (
                <img src={user.avatar} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <span className="font-headline text-[10px] font-bold text-on-surface-variant uppercase">{user.name?.[0] || "U"}</span>
              )}
            </button>
          )}

          {/* Hamburger */}
          <button
            className="md:hidden text-on-surface-variant hover:text-primary transition-colors p-2 -mr-1 active:scale-90"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle menu"
          >
            <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
              {mobileOpen ? (
                <path d="M4 4l12 12M16 4L4 16" />
              ) : (
                <>
                  <path d="M3 5h14" />
                  <path d="M3 10h14" />
                  <path d="M3 15h14" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="menu-enter md:hidden bg-surface-lowest/95 backdrop-blur-xl border-t border-outline-variant/10 px-5 pb-5 pt-3">
          <div className="grid grid-cols-2 gap-1">
            {NAV_LINKS.map((link) => (
              <button
                key={link.id}
                onClick={() => handleNav(link.id)}
                className={`text-left font-headline text-sm font-bold uppercase tracking-wide transition-colors py-3 px-3 active:scale-95 ${
                  activePage === link.id
                    ? "text-primary bg-surface-high/30"
                    : "text-on-surface-variant hover:text-primary"
                }`}
              >
                {link.label}
              </button>
            ))}
          </div>
          {isLoggedIn && (
            <button
              onClick={() => handleNav("profile")}
              className={`w-full mt-2 text-left font-headline text-sm font-bold uppercase tracking-wide py-3 px-3 transition-colors active:scale-95 ${
                activePage === "profile"
                  ? "text-primary bg-surface-high/30"
                  : "text-on-surface-variant hover:text-primary"
              }`}
            >
              Profile
            </button>
          )}
        </div>
      )}
    </nav>
  );
}
