import { useState, useEffect, useId, useRef } from "react";
import { signUp, signIn, signInWithGoogle, signOut } from "../lib/auth";
import { isOnline } from "../lib/supabase";

/**
 * Username rules:
 * - 3 to 24 characters
 * - lowercase letters, digits, and underscores only
 * - must start with a letter
 *
 * Mirrors what the Supabase trigger generates for OAuth users so a
 * manually-chosen username can't conflict with the auto-generated
 * shape later.
 */
export const USERNAME_REGEX = /^[a-z][a-z0-9_]{2,23}$/;

export function validateUsername(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "Username is required";
  if (trimmed.length < 3) return "Username must be at least 3 characters";
  if (trimmed.length > 24) return "Username must be 24 characters or fewer";
  if (!/^[a-z]/.test(trimmed)) return "Username must start with a lowercase letter";
  if (!USERNAME_REGEX.test(trimmed)) return "Use lowercase letters, numbers, and underscores only";
  return null;
}

export default function AuthModal({ open, onClose, onGuest, onLogin }) {
  const [tab, setTab] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  const usernameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const sheetRef = useRef(null);
  const previouslyFocusedRef = useRef(null);

  // Lock body scroll while open, close on Escape, and trap Tab focus
  // inside the modal so keyboard users can't tab to the navbar / page
  // chrome while the dialog is up. Restores focus to whatever the
  // user was on before opening.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Move focus into the modal on the next paint so the autofocused
    // first field wins (or the close button if no field is rendered).
    const t = setTimeout(() => {
      const sheet = sheetRef.current;
      if (!sheet) return;
      const first = sheet.querySelector("input, button, [tabindex]:not([tabindex='-1'])");
      first?.focus?.();
    }, 0);

    const focusables = () => {
      const sheet = sheetRef.current;
      if (!sheet) return [];
      return Array.from(sheet.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ));
    };

    const onKey = (e) => {
      if (e.key === "Escape") { onClose?.(); return; }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
      // Return focus to the trigger that opened us, if it still exists.
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === "function" && document.contains(prev)) {
        try { prev.focus(); } catch {}
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setLoading(true);
    try {
      if (!isOnline()) {
        onGuest?.();
        return;
      }
      if (tab === "signup") {
        const usernameError = validateUsername(username);
        const passwordError = password.length < 6 ? "Password must be at least 6 characters" : null;
        if (usernameError || passwordError) {
          setFieldErrors({ username: usernameError, password: passwordError });
          setLoading(false);
          return;
        }
        await signUp(email, password, username.trim().toLowerCase());
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
    <div className="fixed inset-0 z-[9998] flex items-end sm:items-center justify-center" onClick={onClose}
         role="dialog" aria-modal="true" aria-labelledby={`${emailId}-title`}>
      <div className="modal-backdrop-enter absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div ref={sheetRef}
        className="modal-sheet-enter relative w-full sm:max-w-sm sm:mx-4 bg-surface-container border-t sm:border border-white/[0.06] p-6 sm:p-7 rounded-t-xl sm:rounded-none max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose}
          className="absolute top-4 right-4 p-2 text-on-surface-variant/40 hover:text-primary transition-colors active:scale-90"
          aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>

        <h2 id={`${emailId}-title`} className="font-headline text-xl font-extrabold tracking-tighter text-primary mb-1">oChess</h2>
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
            <div>
              <label htmlFor={usernameId} className="sr-only">Username</label>
              <input id={usernameId} type="text" placeholder="Username" value={username}
                onChange={(e) => { setUsername(e.target.value.toLowerCase()); if (fieldErrors.username) setFieldErrors((p) => ({ ...p, username: null })); }}
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
                aria-invalid={!!fieldErrors.username}
                aria-describedby={fieldErrors.username ? `${usernameId}-err` : undefined}
                className={`w-full bg-surface-low border-b px-3 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/30 outline-none transition-colors ${fieldErrors.username ? "border-error" : "border-outline-variant/20 focus:border-primary"}`} />
              {fieldErrors.username && <p id={`${usernameId}-err`} className="text-[11px] text-error mt-1">{fieldErrors.username}</p>}
            </div>
          )}
          <div>
            <label htmlFor={emailId} className="sr-only">Email</label>
            <input id={emailId} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required
              autoComplete="email"
              className="w-full bg-surface-low border-b border-outline-variant/20 focus:border-primary px-3 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/30 outline-none transition-colors" />
          </div>
          <div>
            <label htmlFor={passwordId} className="sr-only">Password</label>
            <input id={passwordId} type="password" placeholder="Password" value={password}
              onChange={(e) => { setPassword(e.target.value); if (fieldErrors.password) setFieldErrors((p) => ({ ...p, password: null })); }}
              required minLength={6}
              autoComplete={tab === "signup" ? "new-password" : "current-password"}
              aria-invalid={!!fieldErrors.password}
              aria-describedby={fieldErrors.password ? `${passwordId}-err` : undefined}
              className={`w-full bg-surface-low border-b px-3 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/30 outline-none transition-colors ${fieldErrors.password ? "border-error" : "border-outline-variant/20 focus:border-primary"}`} />
            {fieldErrors.password && <p id={`${passwordId}-err`} className="text-[11px] text-error mt-1">{fieldErrors.password}</p>}
          </div>
          {error && <p className="text-[11px] text-error">{error}</p>}
          <button type="submit" disabled={loading}
            className="btn btn-primary w-full py-3 text-xs mt-2">
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
            className="btn btn-secondary w-full py-3 text-xs flex items-center justify-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Continue with Google
          </button>

          <button onClick={() => { onGuest?.(); onClose?.(); }}
            className="btn btn-secondary w-full py-3 text-xs">
            Play as Guest
          </button>
        </div>

        <p className="text-[10px] text-on-surface-variant/55 mt-4 leading-relaxed">
          Guest accounts can play bots, puzzles, analysis, and variants. Create an account to save games, track ratings, play online, and unlock all features.
        </p>
      </div>
    </div>
  );
}
