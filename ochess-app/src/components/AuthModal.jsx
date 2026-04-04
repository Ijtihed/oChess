import { useState } from "react";

export default function AuthModal({ open, onClose, onGuest, onLogin }) {
  const [tab, setTab] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");

  if (!open) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (tab === "signup" && username) {
      onLogin({ name: username, guest: false });
    } else if (tab === "signin" && email) {
      const name = email.split("@")[0];
      onLogin({ name, guest: false });
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div className="modal-backdrop-enter absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div
        className="modal-sheet-enter relative w-full sm:max-w-sm sm:mx-4 bg-surface-container border-t sm:border border-white/[0.06] p-6 sm:p-7 rounded-t-xl sm:rounded-none max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 text-on-surface-variant/40 hover:text-primary transition-colors active:scale-90"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>

        <h2 className="font-headline text-xl font-extrabold tracking-tighter text-primary mb-1">
          oChess
        </h2>
        <p className="text-[11px] text-on-surface-variant/50 mb-6">
          Play, learn, compete.
        </p>

        <div className="flex gap-1 mb-5 border-b border-outline-variant/10 pb-3">
          {[
            { id: "signin", label: "Sign In" },
            { id: "signup", label: "Create Account" },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`font-headline text-xs font-bold uppercase tracking-wide transition-colors px-3 py-2 ${
                tab === t.id ? "text-primary" : "text-on-surface-variant/40 hover:text-on-surface-variant"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {tab === "signup" && (
            <input
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-surface-low border-b border-outline-variant/20 focus:border-primary px-3 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/30 outline-none transition-colors"
            />
          )}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-surface-low border-b border-outline-variant/20 focus:border-primary px-3 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/30 outline-none transition-colors"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-surface-low border-b border-outline-variant/20 focus:border-primary px-3 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/30 outline-none transition-colors"
          />
          <button
            type="submit"
            className="w-full bg-primary text-on-primary py-3 font-headline text-xs font-bold uppercase tracking-wide hover:bg-primary-dim transition-colors mt-2 active:scale-[0.98]"
          >
            {tab === "signin" ? "Sign In" : "Create Account"}
          </button>
        </form>

        <div className="flex items-center gap-3 my-5">
          <div className="flex-1 h-px bg-outline-variant/10" />
          <span className="text-[10px] text-on-surface-variant/30 uppercase tracking-widest">or</span>
          <div className="flex-1 h-px bg-outline-variant/10" />
        </div>

        <button
          onClick={onGuest}
          className="w-full border border-white/[0.06] bg-surface-low py-3 font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant hover:text-primary hover:bg-surface-high transition-colors active:scale-[0.98]"
        >
          Play as Guest
        </button>

        <p className="text-[10px] text-on-surface-variant/25 mt-4 leading-relaxed">
          Guest accounts can play online and against bots. Create an account to save games, track ratings, and unlock all features.
        </p>
      </div>
    </div>
  );
}
