/**
 * Client-side cached read of the caller's profiles.crazy_arena_lab
 * flag.
 *
 * The flag gates dev-facing affordances (currently: the
 * ArenaVisualDebugPanel, which surfaces internal sandbox draw
 * errors with stack traces). End users should never see these
 * surfaces; only operators / contributors who flipped the flag
 * on themselves via SQL should.
 *
 * Module-level cache so multiple components mounting the hook
 * in the same session share one DB read. Cache is per-page-load -
 * if you flip the flag mid-session you need to refresh.
 */

import { useEffect, useState } from "react";
import { supabase } from "../supabase";

let cached = null;
let cachePromise = null;

async function fetchLabFlag() {
  if (cached !== null) return cached;
  if (cachePromise) return cachePromise;
  if (!supabase) {
    cached = false;
    return false;
  }
  cachePromise = (async () => {
    try {
      const { data, error } = await supabase.rpc("get_crazy_arena_lab");
      if (error) {
        // Fail closed: if we can't read the flag, don't grant
        // lab privileges. Typical cause is the user not being
        // authenticated, in which case false is the right
        // answer anyway.
        cached = false;
        return false;
      }
      cached = !!data;
      return cached;
    } catch {
      cached = false;
      return false;
    } finally {
      cachePromise = null;
    }
  })();
  return cachePromise;
}

/**
 * @returns {boolean} true iff the current user has the lab flag.
 *   Returns false during the initial fetch (one-tick delay) so
 *   debug surfaces don't briefly flash for non-lab users.
 */
export function useLabFlag() {
  const [enabled, setEnabled] = useState(() => cached === true);
  useEffect(() => {
    let cancelled = false;
    fetchLabFlag().then((v) => {
      if (!cancelled) setEnabled(v);
    });
    return () => { cancelled = true; };
  }, []);
  return enabled;
}
