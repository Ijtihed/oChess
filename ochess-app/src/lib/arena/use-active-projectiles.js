/**
 * Per-room projectile timeline for the arena visual overlay.
 *
 * The iframe runtime's paint loop accepts a `projectiles` field
 * on each SCENE message. Each entry describes ONE in-flight
 * projectile - kind, from-square, to-square, normalized
 * progress in [0,1]. The runtime calls the variant's matching
 * projectile draw function with the interpolated position.
 *
 * This hook owns the timeline:
 *   - Fire one projectile via fireProjectile(from, to, kind, durationMs).
 *   - The hook spins a requestAnimationFrame loop, recomputes
 *     `progress` per frame, drops entries whose age exceeds ttl.
 *   - Returns the active list as a stable array (referentially
 *     stable across frames where nothing changed; new array
 *     when the list mutates).
 *
 * Both clients fire projectiles independently from the move
 * stream they observe. Determinism: progress is a function of
 * (now - startedAt) which both clients compute identically
 * (within their RAF cadence). Tiny visual drift between clients
 * is acceptable - this is cosmetic, not gameplay.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_DURATION_MS = 350;

/**
 * @returns {{
 *   projectiles: Array<{ kind: string, from: string, to: string, progress: number, age: number, ttl: number }>,
 *   fireProjectile: (from: string, to: string, kind?: string, durationMs?: number) => void,
 *   clearProjectiles: () => void,
 * }}
 */
export function useActiveProjectiles() {
  // Internal mutable list - we don't want a setState per RAF
  // tick (that would re-render the entire arena 60 times/sec).
  // Instead, we maintain an internal ref and ALSO publish a
  // snapshot via setState that only changes when the LIST
  // membership changes (entries added/removed). The progress
  // updates happen in the SCENE-build closure, not via React.
  const liveRef = useRef([]);
  const [snapshot, setSnapshot] = useState([]);

  // RAF loop that updates progress + drops expired entries.
  useEffect(() => {
    let raf = 0;
    let mounted = true;

    function tick() {
      if (!mounted) return;
      const now = performance.now();
      const live = liveRef.current;
      let mutated = false;
      // Recompute each entry's progress; drop expired.
      const next = [];
      for (const p of live) {
        const age = now - p.startedAt;
        if (age >= p.ttl) {
          mutated = true;
          continue;
        }
        // We mutate the entry's progress in place - it's
        // owned by this hook and consumed by the SCENE
        // build, so safe.
        p.progress = Math.min(1, age / p.ttl);
        p.age = age;
        next.push(p);
      }
      if (mutated || next.length !== live.length) {
        liveRef.current = next;
        // Re-snapshot ONLY when membership changed.
        setSnapshot(next.slice());
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    return () => {
      mounted = false;
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const fireProjectile = useCallback((from, to, kind = "default", durationMs = DEFAULT_DURATION_MS) => {
    if (typeof from !== "string" || typeof to !== "string" || from.length !== 2 || to.length !== 2) {
      return;
    }
    const entry = {
      kind: String(kind || "default"),
      from,
      to,
      progress: 0,
      age: 0,
      ttl: Math.max(50, Math.min(2000, durationMs)),
      startedAt: performance.now(),
    };
    liveRef.current = [...liveRef.current, entry];
    setSnapshot(liveRef.current.slice());
  }, []);

  const clearProjectiles = useCallback(() => {
    liveRef.current = [];
    setSnapshot([]);
  }, []);

  return { projectiles: snapshot, fireProjectile, clearProjectiles };
}
