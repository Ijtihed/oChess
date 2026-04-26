import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { getProfile } from "../lib/auth";
import { syncPuzzleProgressFromServer } from "../lib/puzzle-sync";
import { makeLogger } from "../lib/log";

const { log: alog, warn: awarn } = makeLogger("auth");

const AuthContext = createContext({ user: null, profile: null, loading: true, refreshProfile: async () => {} });

export function useAuth() {
  return useContext(AuthContext);
}

export default function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  /** Re-fetch and update the profile in context (call after updateProfile). */
  const refreshProfile = useCallback(async (userId) => {
    if (!userId) return;
    try { setProfile(await getProfile(userId)); } catch {}
  }, []);

  useEffect(() => {
    if (!supabase) {
      alog("no supabase client, going offline");
      setLoading(false);
      return;
    }

    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; setLoading(false); alog("ready"); } };

    // Safety timeout — if onAuthStateChange never fires for any reason,
    // unblock the UI rather than leaving the user stuck on the splash.
    const timeout = setTimeout(() => { awarn("safety timeout (3s) — forcing ready"); done(); }, 3000);

    let subscription = null;
    try {
      const result = supabase.auth.onAuthStateChange(async (event, session) => {
        alog("event:", event, "user:", session?.user?.id || "none");
        const u = session?.user || null;
        setUser(u);

        if (event === "INITIAL_SESSION") {
          if (u) {
            alog("session restored for", u.id);
            try { setProfile(await getProfile(u.id)); } catch {}
            // Merge local puzzle state with the server row — picks
            // whichever side has played more games and takes the
            // higher streak. Safe to fire-and-forget.
            syncPuzzleProgressFromServer(u.id).catch(() => {});
          } else {
            alog("no stored session — user is logged out");
          }
        } else if (event === "SIGNED_IN") {
          alog("signed in:", u?.id);
          if (u) {
            try { setProfile(await getProfile(u.id)); } catch {}
            syncPuzzleProgressFromServer(u.id).catch(() => {});
          }
        } else if (event === "SIGNED_OUT") {
          alog("signed out");
          setProfile(null);
        }
        // Always release the loading gate after handling any auth event.
        // INITIAL_SESSION is the typical path on cold boot, but if a tab
        // is reopened with a refreshed token Supabase may emit a
        // SIGNED_IN / TOKEN_REFRESHED first — leaving us stuck on the
        // splash if we only treated INITIAL_SESSION as "ready".
        clearTimeout(timeout);
        done();
      });
      subscription = result?.data?.subscription;
    } catch (e) {
      awarn("listener failed:", e);
      clearTimeout(timeout);
      done();
    }

    return () => {
      clearTimeout(timeout);
      try { subscription?.unsubscribe(); } catch {}
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user, profile, loading, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}
