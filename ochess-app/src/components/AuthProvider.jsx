import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "../lib/supabase";
import { getProfile } from "../lib/auth";
import { syncPuzzleProgressFromServer } from "../lib/puzzle-sync";
import { makeLogger } from "../lib/log";

const { log: alog, warn: awarn } = makeLogger("auth");

const AuthContext = createContext({ user: null, profile: null, loading: true, refreshProfile: async () => {} });

export function useAuth() {
  return useContext(AuthContext);
}

/**
 * Auth context for the whole app.
 *
 * Bootstrap order matters here. On a cold reload we must:
 *
 *   1. Read the locally-persisted session synchronously so the very
 *      first paint already knows whether the user is signed in. This
 *      avoids a flash of the "Sign In" button in the navbar before the
 *      auth event fires.
 *
 *   2. Subscribe to auth events so subsequent sign-in / sign-out / token
 *      refreshes propagate without a page reload.
 *
 *   3. Release the `loading` gate as soon as we know the user state,
 *      WITHOUT waiting for the profile fetch. The profile is enrichment
 *      (display name, avatar, bio) - the navbar / routes can render
 *      meaningfully with just the auth user, falling back to OAuth
 *      metadata until the profile row arrives.
 *
 * The safety timeout exists only to unblock a totally broken Supabase
 * client; under normal conditions we never wait for it because
 * getSession() resolves from localStorage in ~ms.
 */
export default function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const refreshProfile = useCallback(async (userId) => {
    if (!userId || !supabase) return;
    try {
      const p = await getProfile(userId);
      if (mountedRef.current) setProfile(p);
    } catch {
      /* swallow - UI keeps the previous profile */
    }
  }, []);

  // Internal helper: load the profile and (best-effort) sync puzzles for a
  // signed-in user. Decoupled from the loading gate.
  const hydrateProfile = useCallback(async (userId) => {
    if (!userId || !supabase) return;
    try {
      const p = await getProfile(userId);
      if (mountedRef.current) setProfile(p);
    } catch (e) {
      awarn("getProfile failed:", e);
    }
    syncPuzzleProgressFromServer(userId).catch(() => {});
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!supabase) {
      alog("no supabase client, going offline");
      setLoading(false);
      return () => { mountedRef.current = false; };
    }

    let resolved = false;
    const done = () => {
      if (resolved || !mountedRef.current) return;
      resolved = true;
      setLoading(false);
      alog("ready");
    };

    // 1) Synchronous bootstrap - getSession() resolves from
    //    localStorage in milliseconds. This populates `user` before the
    //    listener has a chance to emit, eliminating the flash where the
    //    navbar briefly shows the "Sign In" button on a fresh page load.
    supabase.auth.getSession()
      .then(({ data }) => {
        const u = data?.session?.user || null;
        if (!mountedRef.current) return;
        if (u) {
          alog("bootstrap: session restored for", u.id);
          setUser(u);
          // Profile + puzzle sync happen in the background; we don't
          // hold up the loading gate for them.
          hydrateProfile(u.id);
        } else {
          alog("bootstrap: no stored session");
        }
        done();
      })
      .catch((e) => {
        awarn("getSession failed:", e);
        done();
      });

    // 2) Long-lived listener for sign-in / sign-out / token refresh.
    //    INITIAL_SESSION may also fire here; it's idempotent with the
    //    bootstrap path since both call setUser with the same value.
    let subscription = null;
    try {
      const result = supabase.auth.onAuthStateChange(async (event, session) => {
        const u = session?.user || null;
        alog("event:", event, "user:", u?.id || "none");
        if (!mountedRef.current) return;

        // Ignore TOKEN_REFRESHED with the same user id - it doesn't
        // change anything the UI cares about and re-fetching the
        // profile every refresh is wasteful.
        if (event === "TOKEN_REFRESHED" && u?.id === user?.id) {
          done();
          return;
        }

        setUser(u);

        if ((event === "INITIAL_SESSION" || event === "SIGNED_IN") && u) {
          hydrateProfile(u.id);
        } else if (event === "SIGNED_OUT") {
          setProfile(null);
        } else if (event === "USER_UPDATED" && u) {
          hydrateProfile(u.id);
        }

        done();
      });
      subscription = result?.data?.subscription;
    } catch (e) {
      awarn("listener failed:", e);
      done();
    }

    // 3) Generous safety timeout - only triggers if both getSession()
    //    AND the listener never resolve. 8 s is long enough that we
    //    don't pre-empt a slow real response on poor networks, but
    //    short enough that a totally broken auth client doesn't hang
    //    the splash forever.
    const timeout = setTimeout(() => {
      if (resolved) return;
      awarn("safety timeout (8s) - forcing ready");
      done();
    }, 8000);

    return () => {
      mountedRef.current = false;
      clearTimeout(timeout);
      try { subscription?.unsubscribe(); } catch { /* fine */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AuthContext.Provider value={{ user, profile, loading, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}
