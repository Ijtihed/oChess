import { useState } from "react";

const NAV_LINKS = [
  { id: "play",     label: "Play" },
  { id: "puzzles",  label: "Puzzles" },
  { id: "variants", label: "Variants" },
  { id: "analysis", label: "Analysis" },
  { id: "study",    label: "Study" },
  { id: "bots",     label: "Bots" },
  { id: "review",   label: "Anki" },
];

export default function Navbar({ activePage, onNavigate, user, onAuthClick }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleNav = (id) => {
    onNavigate(id);
    setMobileOpen(false);
  };

  const isLoggedIn = !!user;
  const showSignIn = !user || user.guest;

  return (
    <nav className="fixed top-0 w-full z-50 bg-surface-lowest/80 backdrop-blur-xl">
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
              <div className="w-7 h-7 rounded-full bg-surface-high flex items-center justify-center">
                <span className="font-headline text-[10px] font-bold text-on-surface-variant uppercase">
                  {user.name?.[0] || "U"}
                </span>
              </div>
              <span className="font-headline text-[11px] font-bold text-on-surface-variant/70">
                {user.name}
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
              className="md:hidden w-8 h-8 rounded-full bg-surface-high flex items-center justify-center active:scale-90 transition-transform"
            >
              <span className="font-headline text-[10px] font-bold text-on-surface-variant uppercase">
                {user.name?.[0] || "U"}
              </span>
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
