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

  // The RAF loop should only run while there are LIVE
  // projectiles. Idling at 60fps consumes ~0.5-1% CPU on every
  // page that mounts the hook, even when nothing's animating.
  // We start the loop on the first fireProjectile and stop it
  // when the live list drains to zero.
  const rafRef = useRef(0);
  const mountedRef = useRef(true);
  const tickRef = useRef(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const startTick = useCallback(() => {
    if (rafRef.current) return; // already running
    function tick() {
      if (!mountedRef.current) return;
      const now = performance.now();
      const live = liveRef.current;
      let mutated = false;
      const next = [];
      for (const p of live) {
        const age = now - p.startedAt;
        if (age >= p.ttl) {
          mutated = true;
          continue;
        }
        p.progress = Math.min(1, age / p.ttl);
        p.age = age;
        next.push(p);
      }
      if (mutated || next.length !== live.length) {
        liveRef.current = next;
        setSnapshot(next.slice());
      }
      // Stop the loop when nothing's left to animate. Will
      // restart on the next fireProjectile.
      if (next.length === 0) {
        rafRef.current = 0;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    tickRef.current = tick;
    rafRef.current = requestAnimationFrame(tick);
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
    // Kick the RAF loop awake if it's idle.
    startTick();
  }, [startTick]);

  const clearProjectiles = useCallback(() => {
    liveRef.current = [];
    setSnapshot([]);
  }, []);

  return { projectiles: snapshot, fireProjectile, clearProjectiles };
}
