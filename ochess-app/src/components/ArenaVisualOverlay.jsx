/**
 * ArenaVisualOverlay - the sandboxed iframe that paints the
 * AI-generated visuals over the existing chess board.
 *
 * Design rationale: see DESIGN_SHIP_3.md. tldr: the iframe
 * runs with sandbox="allow-scripts" only (no allow-same-origin)
 * so it has an opaque origin and CAN'T access the parent DOM,
 * cookies, localStorage, or fetch external URLs. We talk to it
 * via postMessage with a versioned protocol.
 *
 * Lifecycle:
 *
 *   1. Mount. Build the srcdoc string from RUNTIME_SOURCE.
 *      iframe loads, runs the runtime <script>.
 *   2. iframe sends READY (we set isReady = true).
 *   3. We send INIT with the validated draw sources + seed.
 *      iframe compiles them, sends READY again (or INIT_ERROR).
 *   4. On every position change, we send a SCENE message
 *      describing the current board state. iframe paints.
 *   5. iframe sends DRAW_ERROR / SLOT_DISABLED / SANDBOX_HALTED
 *      messages back. We forward to the parent via callbacks.
 *
 * The component is a no-op (renders nothing) when:
 *   - props.compiledDraws is empty (no AI-emitted visuals)
 *   - props.disabled is true (kill switch / lobby fallback)
 *
 * Position is what the engine considers canonical (FEN +
 * crazyState). The overlay reads from it but never writes
 * back; ALL game state lives in the parent React tree.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { RUNTIME_SOURCE, PROTOCOL_VERSION } from "../lib/arena/visual-sandbox/runtime-source";

// Module-level so the iframe element gets a STABLE style prop.
// A fresh `{ background: "transparent" }` object on every parent
// render makes React think the prop changed and re-evaluates;
// not a re-mount, but it adds churn to the reconciler.
const IFRAME_STYLE = { background: "transparent" };

/**
 * @param {Object} props
 * @param {Object|null} props.compiledDraws  Draw sources keyed by slot.
 *   Shape: { slots: {"q.aura": "function __draw__(...){...}"}, projectiles: {...}, overlays: [...], brains: {...} }
 *   Each value is the FULL function declaration string, post-validation,
 *   post-loop-guard injection.
 * @param {string} props.seed                 Match-seeded RNG seed (e.g. roomId).
 * @param {Object} props.position             Engine Position object.
 * @param {string} props.orientation          "white" | "black".
 * @param {Array}  [props.projectiles]        [{ kind, from, to, progress, age, ttl }, ...]
 * @param {Object} [props.lastCast]           { from, to, abilityId } | null
 * @param {boolean}[props.disabled]           When true, render nothing (kill switch).
 * @param {(err) => void} [props.onDrawError]
 * @param {(slot, reason) => void} [props.onSlotDisabled]
 * @param {(reason) => void} [props.onSandboxHalted]
 */
export default function ArenaVisualOverlay({
  compiledDraws,
  seed,
  position,
  orientation = "white",
  projectiles = [],
  lastCast = null,
  disabled = false,
  onDrawError,
  onSlotDisabled,
  onSandboxHalted,
}) {
  const iframeRef = useRef(null);
  const [isReady, setIsReady] = useState(false);
  const sentInitRef = useRef(false);

  // Pin the latest event callbacks in refs so the message-
  // handler effect doesn't have to depend on them. Parents
  // typically pass inline arrows, which produce a fresh
  // identity every render - having those in the effect deps
  // re-attached the handler on every parent render and
  // (depending on render frequency) added measurable churn.
  // Refs let us treat them as "always read the latest" without
  // triggering any effect re-run.
  const onDrawErrorRef = useRef(onDrawError);
  const onSlotDisabledRef = useRef(onSlotDisabled);
  const onSandboxHaltedRef = useRef(onSandboxHalted);
  useEffect(() => { onDrawErrorRef.current = onDrawError; }, [onDrawError]);
  useEffect(() => { onSlotDisabledRef.current = onSlotDisabled; }, [onSlotDisabled]);
  useEffect(() => { onSandboxHaltedRef.current = onSandboxHalted; }, [onSandboxHalted]);

  // Stable srcdoc (don't change between mounts, the runtime
  // doesn't need any environment-specific data baked in).
  const srcdoc = useMemo(() => RUNTIME_SOURCE, []);

  // Has any draw to render at all?
  const hasDraws = useMemo(() => {
    if (!compiledDraws || typeof compiledDraws !== "object") return false;
    if (compiledDraws.slots && Object.keys(compiledDraws.slots).length > 0) return true;
    if (compiledDraws.projectiles && Object.keys(compiledDraws.projectiles).length > 0) return true;
    if (Array.isArray(compiledDraws.overlays) && compiledDraws.overlays.length > 0) return true;
    if (compiledDraws.brains && Object.keys(compiledDraws.brains).length > 0) return true;
    return false;
  }, [compiledDraws]);

  const shouldMount = !disabled && hasDraws;

  // Listen for messages from the iframe. Effect deps deliberately
  // EXCLUDE the callback props - we read them via refs above so
  // that identity flips on inline-arrow parents don't re-attach
  // the listener every render.
  useEffect(() => {
    if (!shouldMount) return undefined;
    function handler(ev) {
      if (!ev.data || typeof ev.data !== "object") return;
      // We don't filter ev.source here because a malicious page
      // can't reach into the iframe (opaque origin, no
      // allow-same-origin). The risk surface is the iframe
      // sending us a malformed message, which we defend against
      // by validating msg.type below.
      const msg = ev.data;
      switch (msg.type) {
        case "READY":
          setIsReady(true);
          break;
        case "INIT_ERROR": {
          const cb = onDrawErrorRef.current;
          if (typeof cb === "function") cb({ type: "INIT_ERROR", message: msg.message });
          break;
        }
        case "DRAW_ERROR": {
          const cb = onDrawErrorRef.current;
          if (typeof cb === "function") cb(msg);
          break;
        }
        case "SLOT_DISABLED": {
          const cb = onSlotDisabledRef.current;
          if (typeof cb === "function") cb(msg.slot, msg.reason);
          break;
        }
        case "SANDBOX_HALTED": {
          const cb = onSandboxHaltedRef.current;
          if (typeof cb === "function") cb(msg.reason);
          break;
        }
        case "PAINT_DONE":
          // Currently unused, but useful for perf telemetry later.
          break;
        default:
          break;
      }
    }
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [shouldMount]);

  // When the iframe announces READY, push INIT once.
  useEffect(() => {
    if (!shouldMount || !isReady || sentInitRef.current) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    sentInitRef.current = true;
    win.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "INIT",
      seed,
      drawSources: compiledDraws,
    }, "*");
  }, [shouldMount, isReady, compiledDraws, seed]);

  // Reset INIT-sent flag if compiledDraws changes (e.g. round
  // transition with a new variant).
  useEffect(() => {
    sentInitRef.current = false;
    setIsReady(false);
  }, [compiledDraws, seed]);

  // Per-position SCENE dispatch. Throttled to RAF cadence; we
  // also send when position changes synchronously.
  useEffect(() => {
    if (!shouldMount || !isReady) return undefined;
    const win = iframeRef.current?.contentWindow;
    if (!win) return undefined;

    let raf = 0;
    let mounted = true;

    function pushScene() {
      if (!mounted) return;
      const scene = buildScene(position, orientation, projectiles, lastCast);
      try {
        win.postMessage({ protocolVersion: PROTOCOL_VERSION, type: "SCENE", scene }, "*");
      } catch { /* iframe gone */ }
      raf = requestAnimationFrame(pushScene);
    }
    pushScene();

    return () => {
      mounted = false;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [shouldMount, isReady, position, orientation, projectiles, lastCast]);

  if (!shouldMount) return null;

  return (
    <iframe
      ref={iframeRef}
      title="arena visual overlay"
      sandbox="allow-scripts"
      srcDoc={srcdoc}
      // No pointer events: clicks pass through to the chess
      // board underneath.
      className="absolute inset-0 w-full h-full pointer-events-none z-[2] border-0"
      // The iframe itself has a transparent background; the
      // canvas inside paints over it. Style literal is hoisted
      // (see top of file) so it stays referentially stable
      // across parent re-renders.
      style={IFRAME_STYLE}
    />
  );
}

/**
 * Build the SCENE message body from the current Position.
 * Pure function so it's easy to unit-test.
 */
function buildScene(position, orientation, projectiles, lastCast) {
  const pieces = [];
  for (let i = 0; i < 64; i++) {
    const pc = position?.board?.[i];
    if (!pc) continue;
    const file = i % 8;
    const rank = (i - file) / 8;
    pieces.push({
      square: String.fromCharCode(97 + file) + String.fromCharCode(49 + rank),
      type: pc.type,
      color: pc.color,
    });
  }
  const marks = position?.crazyState?.effects || {};
  return {
    ply: position?.history?.length || 0,
    t: typeof performance !== "undefined" ? performance.now() : 0,
    boardPx: 480,        // overridden at paint time using devicePixelRatio
    orientation,
    pieces,
    projectiles,
    marks,
    lastCast,
  };
}
