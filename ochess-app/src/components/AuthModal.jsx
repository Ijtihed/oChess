import { useState, useEffect } from "react";
import { signUp, signIn, signInWithGoogle, signOut } from "../lib/auth";
import { isOnline } from "../lib/supabase";

export default function AuthModal({ open, onClose, onGuest, onLogin }) {
  const [tab, setTab] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Lock body scroll while open and close on Escape so the modal
  // behaves like a real overlay (and never leaves the user with a
  // double-scrolling page underneath).
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (!isOnline()) {
        onGuest?.();
        return;
      }
      if (tab === "signup") {
        if (!username.trim()) throw new Error("Username is required");
        if (password.length < 6) throw new Error("Password must be at least 6 characters");
        await signUp(email, password, username.trim());
        setError(null);
        onLogin?.();
      } else {
        await signIn(email, password);
        onLogin?.();
      }
    } catch (err) {
      const msg = err.message || "Something went wrong";
      if (tab === "signin" && (msg.includes("Invalid login") || msg.includes("invalid") || msg.includes("not found") || msg.includes("credentials"))) {
        setError("No account with that email. Create one below.");
        setTab("signup");
        setUsername(email.split("@")[0]);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setError(null);
    try {
      if (!isOnline()) { onGuest?.(); return; }
      await signInWithGoogle();
    } catch (err) {
      setError(err.message || "Google sign-in failed");
    }
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="modal-backdrop-enter absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div className="modal-sheet-enter relative w-full sm:max-w-sm sm:mx-4 bg-surface-container border-t sm:border border-white/[0.06] p-6 sm:p-7 rounded-t-xl sm:rounded-none max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose}
          className="absolute top-4 right-4 p-2 text-on-surface-variant/40 hover:text-primary transition-colors active:scale-90"
          aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>

        <h2 className="font-headline text-xl font-extrabold tracking-tighter text-primary mb-1">oChess</h2>
        <p className="text-[11px] text-on-surface-variant/50 mb-6">Play, learn, compete.</p>

        {!isOnline() && (
          <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-400 leading-relaxed">
            Online features are not configured yet. You can play as a guest with full access to bots, puzzles, analysis, and variants.
          </div>
        )}

        <div className="flex gap-1 mb-5 border-b border-outline-variant/10 pb-3">
          {[{ id: "signin", label: "Sign In" }, { id: "signup", label: "Create Account" }].map((t) => (
            <button key={t.id} onClick={() => { setTab(t.id); setError(null); }}
              className={`font-headline text-xs font-bold uppercase tracking-wide transition-colors px-3 py-2 ${tab === t.id ? "text-primary" : "text-on-surface-variant/40 hover:text-on-surface-variant"}`}>
              {t.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {tab === "signup" && (
            <input type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-surface-low border-b border-outline-variant/20 focus:border-primary px-3 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/30 outline-none transition-colors" />
          )}
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required
            className="w-full bg-surface-low border-b border-outline-variant/20 focus:border-primary px-3 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/30 outline-none transition-colors" />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
            className="w-full bg-surface-low border-b border-outline-variant/20 focus:border-primary px-3 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/30 outline-none transition-colors" />
          {error && <p className="text-[11px] text-error">{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full bg-primary text-on-primary py-3 font-headline text-xs font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors mt-2 active:scale-[0.98] disabled:opacity-50">
            {loading ? "..." : tab === "signin" ? "Sign In" : "Create Account"}
          </button>
        </form>

        <div className="flex items-center gap-3 my-5">
          <div className="flex-1 h-px bg-outline-variant/10" />
          <span className="text-[10px] text-on-surface-variant/30 uppercase tracking-widest">or</span>
          <div className="flex-1 h-px bg-outline-variant/10" />
        </div>

        <div className="space-y-2">
          <button onClick={handleGoogle}
            className="w-full border border-white/[0.06] bg-surface-low py-3 font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.98] flex items-center justify-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Continue with Google
          </button>

          <button onClick={() => { onGuest?.(); onClose?.(); }}
            className="w-full border border-white/[0.06] bg-surface-low py-3 font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.98]">
            Play as Guest
          </button>
        </div>

        <p className="text-[10px] text-on-surface-variant/25 mt-4 leading-relaxed">
          Guest accounts can play bots, puzzles, analysis, and variants. Create an account to save games, track ratings, play online, and unlock all features.
        </p>
      </div>
    </div>
  );
}
