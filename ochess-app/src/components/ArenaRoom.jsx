import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import SocialPanel from "./SocialPanel";
import InteractiveBoard from "./InteractiveBoard";
import PlayerBar, { getCaptured } from "./PlayerBar";
import {
  playMoveSound,
  playError,
  playGameStart,
  playVictory,
  playDefeat,
  playDraw,
  playLowTime,
  playChatNotify,
  playOfferNotify,
  playAbilityCast,
} from "../lib/sounds";
import {
  getRoom,
  joinRoom,
  updateRoom,
  deleteRoom,
  subscribeRoom,
  subscribeMoves,
  appendMove,
  advanceRound,
  loadMoves,
  recordRoundGame,
  createRoom,
  openChatChannel,
} from "../lib/arena/service";
import { moderateChat } from "../lib/chat";
import { resolveRules, vanillaRules } from "../lib/arena/rules";
import { Position } from "../lib/arena/position";
import { generateLegalMoves } from "../lib/arena/move-gen";
import { applyMove } from "../lib/arena/apply-move";
import { checkGameStatus } from "../lib/arena/win-check";
import { pickRandomMoveAsync } from "../lib/arena/random-bot";
import { presetById } from "../lib/arena/presets";
import { VANILLA_FEN } from "../lib/arena/schema";
import { generateArenaRules, isAIRulesAvailable } from "../lib/arena/ai-rules";
import { describeRules } from "../lib/arena/rule-preview";
import { translateValidatorErrors } from "../lib/arena/error-messages";
import RulePreview from "./RulePreview";
import ArenaAbilityPanel from "./ArenaAbilityPanel";
import ArenaVisualOverlay from "./ArenaVisualOverlay";
import ArenaVisualDebugPanel from "./ArenaVisualDebugPanel";
import { compileVisuals } from "../lib/arena/visual-sandbox/compile-draws";
import { DEMO_VISUALS } from "../lib/arena/visual-sandbox/demo-draws";
import { isVisualsKilled } from "../lib/arena/visuals-kill-switch";
import { recordVisualError } from "../lib/arena/visuals-audit";
import { pushVisualError } from "../lib/arena/visuals-error-buffer";
import { useActiveProjectiles } from "../lib/arena/use-active-projectiles";
import { useLabFlag } from "../lib/arena/use-lab-flag";
import { repairVisualsForRules } from "../lib/arena/visual-repair";
import {
  colorFor,
  colorPairFor,
  buildRoundEntry,
  appendRound,
  nextStatusAfterRound,
  finalizeMatch,
  roundLabelFor,
} from "../lib/arena/orchestrator";
import {
  initRoundClock,
  initTiebreakClock,
  clockSnapshot,
  commitMove as commitClockMove,
  pauseClock,
} from "../lib/arena/clock";

/**
 * ArenaRoom - mounted at /arena/<roomId>.
 *
 * Phase 1 implements three states end-to-end:
 *
 *   1. waiting_for_joiner / prompting
 *      - Creator sees a share-link banner + the rules they
 *        picked.
 *      - Joiner sees the creator's rules + their own preset
 *        picker.
 *      - When the joiner stamps `rules_joiner` we advance to
 *        `warmup_round_1`.
 *
 *   2. warmup_round_<n>
 *      - 30-second clock per side, both running in parallel.
 *      - Board mounted under the round's rules; user plays
 *        random-AI to get a feel for the variant.
 *      - When the clock hits zero (or the user clicks Ready),
 *        flip to round_<n>.
 *
 *   3. round_1 / round_2 / tiebreak / done
 *      - Phase 1 stops at a "Ready to play" placeholder. The
 *        full 1v1 + tie-break + results screens land in the
 *        next slice.
 *
 * Realtime: a single postgres_changes subscription on the
 * arena_rooms row keeps both clients in lockstep with the
 * orchestrator state. The first client to advance the room
 * status wins; the other reacts on the next UPDATE event.
 */
export default function ArenaRoom({ roomId }) {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [room, setRoom] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Realtime channel health. We start in "connecting" so the
  // first SUBSCRIBED event flips us to healthy; if we never get
  // SUBSCRIBED or we get CHANNEL_ERROR / TIMED_OUT, we fall
  // back to fast polling AND surface a small reconnecting toast.
  const [channelHealth, setChannelHealth] = useState("connecting");

  // Initial load + realtime subscription. The subscription is
  // cheap so we hold it open for the lifetime of the
  // component; navigating away unmounts and unsubs.
  useEffect(() => {
    if (!roomId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const result = await getRoom(roomId);
      if (cancelled) return;
      if (!result.ok || !result.room) {
        setError(result.error || "Room not found.");
        setLoading(false);
        return;
      }
      setRoom(result.room);
      setLoading(false);
    })();
    const unsub = subscribeRoom(
      roomId,
      (next) => {
        if (cancelled) return;
        setRoom((prev) => ({ ...(prev || {}), ...next }));
      },
      (status) => {
        if (cancelled) return;
        // Map Supabase realtime channel status into the three
        // states the UI cares about: healthy (SUBSCRIBED),
        // reconnecting (everything else that isn't terminal),
        // or closed.
        if (status === "SUBSCRIBED") setChannelHealth("healthy");
        else if (status === "CLOSED") setChannelHealth("closed");
        else setChannelHealth("reconnecting");
      },
    );
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [roomId]);

  // Adaptive backup polling. When realtime is healthy we poll
  // sparingly (30s) just to recover from any silent message
  // drop on long-lived rooms; when realtime is degraded we poll
  // aggressively (5s) so the UI still converges. The previous
  // version polled every 5s unconditionally, generating ~12
  // reads per minute per client even when realtime was fine.
  useEffect(() => {
    if (!roomId) return undefined;
    let cancelled = false;
    const intervalMs = channelHealth === "healthy" ? 30_000 : 5_000;
    const poll = setInterval(async () => {
      if (cancelled) return;
      const r = await getRoom(roomId);
      if (cancelled || !r.ok || !r.room) return;
      setRoom((prev) => {
        if (prev?.updated_at === r.room.updated_at && prev?.status === r.room.status) {
          return prev;
        }
        return { ...(prev || {}), ...r.room };
      });
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [roomId, channelHealth]);

  // Refetch on tab focus / visibility return. If the user
  // switched tabs or backgrounded the browser long enough for
  // the realtime channel to time out, a refocus shouldn't
  // require waiting for the next 5s poll tick.
  useEffect(() => {
    if (!roomId) return undefined;
    let cancelled = false;
    const refresh = async () => {
      const r = await getRoom(roomId);
      if (cancelled || !r.ok || !r.room) return;
      setRoom((prev) => ({ ...(prev || {}), ...r.room }));
    };
    const onFocus = () => { refresh(); };
    const onVis = () => { if (!document.hidden) refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [roomId]);

  if (authLoading || loading) {
    return <ArenaLoading />;
  }

  if (error || !room) {
    return <ArenaError message={error || "Room not found."} onBack={() => navigate("/arena")} />;
  }

  if (!user || user.guest) {
    return <ArenaError message="Sign in to join arena rooms." onBack={() => navigate("/arena")} />;
  }

  // Identity + role.
  const role = user.id === room.creator_id ? "creator"
    : user.id === room.joiner_id ? "joiner"
    : null;

  // Board-bearing states (warmup / round / tiebreak) render
  // their own full-bleed game shell that mirrors the Online
  // play surface (top bar, padded board column, sized
  // sidebar). For those we skip the page header + outer
  // padding entirely so RoundPlay / Warmup / SpectatorRound's
  // shells are flush with the navbar. Lobby + match-results
  // keep the relaxed page padding for breathing room.
  const isBoardState = room.status === "warmup_round_1"
    || room.status === "warmup_round_2"
    || room.status === "round_1"
    || room.status === "round_2"
    || room.status === "tiebreak";

  if (isBoardState || (room.status === "done" && false /* keep done on the relaxed shell */)) {
    return (
      <div className="flex">
        <div className="flex-1 min-w-0">
          <ChannelHealthToast health={channelHealth} />
          <RoomBody
            room={room}
            setRoom={setRoom}
            role={role}
            user={user}
            roomId={roomId}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex">
      <div className="flex-1 min-w-0 max-w-[1400px] xl:max-w-[1500px] 2xl:max-w-[1600px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10 min-h-[calc(100dvh-4rem)]">
        <ChannelHealthToast health={channelHealth} />
        <header className="anim-fade-up mb-3 sm:mb-5" style={{ "--delay": "0.05s" }}>
          <button onClick={() => navigate("/arena")}
            className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40 hover:text-primary transition-colors flex items-center gap-1 mb-1">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            All rooms
          </button>
          <h1 className="font-headline text-xl sm:text-2xl font-extrabold tracking-tighter text-primary leading-tight">
            Arena room
          </h1>
          <p className="text-[12px] text-on-surface-variant/55 mt-1">
            Share the URL with your opponent &middot; status: <span className="text-on-surface-variant/85 font-bold">{formatRoomStatusInline(room.status)}</span>
          </p>
        </header>

        <RoomBody
          room={room}
          setRoom={setRoom}
          role={role}
          user={user}
          roomId={roomId}
        />
      </div>
      <SocialPanel />
    </div>
  );
}

/**
 * Tiny fixed-bottom toast that surfaces realtime-channel issues.
 * Hidden when the channel is healthy. The poll fallback already
 * keeps the UI working - this is just so users understand when
 * "wait, why is the opponent's move taking so long?" is actually
 * just a flaky connection on their side.
 */
// Crazy Arena Ship #2.5: minimal status-badge overlay that paints
// the active marks on each square as plain text (e.g. "frost 3",
// "burn 2"). DELIBERATELY BARE - the AI will draw real visuals in
// Ship #3, this exists only so humans can SEE that an effect is
// active during testing. Remove this whole component when Ship #3
// lands.
function CrazyStateBadges({ position, orientation }) {
  const effects = position?.crazyState?.effects;
  if (!effects || Object.keys(effects).length === 0) return null;
  const flipped = orientation === "black";
  return (
    <div className="absolute inset-0 pointer-events-none z-[3]">
      {Object.entries(effects).map(([sq, marks]) => {
        if (!Array.isArray(marks) || marks.length === 0) return null;
        const file = sq.charCodeAt(0) - 97; // a..h -> 0..7
        const rank = parseInt(sq[1], 10) - 1; // 1..8 -> 0..7
        const left = flipped ? (7 - file) : file;
        const top = flipped ? rank : (7 - rank);
        const label = marks.map((m) => {
          const dur = Number.isFinite(m.duration) ? ` ${m.duration}` : "";
          const tag = (m.tag || "?").slice(0, 9);
          return `${tag}${dur}`;
        }).join(" ");
        return (
          <span
            key={sq}
            className="absolute font-mono text-[8px] font-bold uppercase text-white/95 whitespace-nowrap"
            style={{
              left: `${(left / 8) * 100}%`,
              top: `${(top / 8) * 100}%`,
              width: `${100 / 8}%`,
              height: `${100 / 8}%`,
              padding: "1px 2px",
              textShadow: "0 0 2px rgba(0,0,0,0.85), 0 0 4px rgba(0,0,0,0.65)",
            }}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

// Crazy Arena Ship #2.5: small dismissible toast that appears
// when the engine throws a VariantError. Auto-clears after the
// timeout in the parent's setState. Deliberately ugly so we
// don't forget to clean it up in Ship #3 once visuals land and
// most variant errors become impossible.
/**
 * Read the Ship #3 visual-overlay feature flag from localStorage.
 *
 *   "off"   - render nothing extra (default; current Ship #2 UX)
 *   "demo"  - render the hand-coded DEMO_VISUALS (auras + vignette)
 *             so you can verify the iframe sandbox + paint loop
 *             work end-to-end before AI integration lands.
 *   "ai"    - render whatever the variant's AI-emitted visuals
 *             produced (wired up in Phase 4).
 *
 * Set via DevTools console:
 *   localStorage.setItem("arena_visuals_mode", "demo")
 *
 * Reading from localStorage means you can turn it on without a
 * redeploy. Stored as a small string so the read cost is trivial.
 */
/**
 * Resolve the effective visuals mode for the current user/room.
 *
 * Default policy (the "AI-prompted chess" vision): every arena
 * room renders AI-emitted visuals when the variant has any.
 * Users can opt out per-room via the debug panel, or globally
 * by setting localStorage.arena_visuals_mode = "off".
 *
 * Localstorage values:
 *   - unset       -> "ai" (default; visuals on whenever a variant has them)
 *   - "ai"        -> AI-emitted visuals from rulesDiff.visuals
 *   - "demo"      -> hand-coded DEMO_VISUALS (test mode)
 *   - "off"       -> render nothing extra
 *
 * Per-room override: arena_visuals_off:<roomId> = "1" forces
 * "off" for that single room. The debug panel sets this when
 * the user clicks "disable visuals" in response to bad draws.
 */
function readVisualsMode(roomId) {
  try {
    if (roomId && localStorage.getItem(`arena_visuals_off:${roomId}`) === "1") return "off";
    const v = localStorage.getItem("arena_visuals_mode");
    if (v === "demo" || v === "ai" || v === "off") return v;
  } catch { /* ignore */ }
  return "ai";
}

function useArenaVisualsMode(roomId) {
  const [mode, setMode] = useState(() => readVisualsMode(roomId));
  // Refresh on the same custom event our prefs system uses, so
  // toggling the flag picks up immediately without a page reload.
  useEffect(() => {
    function handler() {
      setMode(readVisualsMode(roomId));
    }
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [roomId]);
  // Server-side kill switch (ai_settings.disable_drawn_visuals).
  // Polls the cached value once on mount; if the operator flipped
  // it, force mode=off across the whole component tree.
  const [killed, setKilled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    isVisualsKilled().then((k) => { if (!cancelled) setKilled(k); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return killed ? "off" : mode;
}

/**
 * Compile the visuals to render into the sandbox. Returns the
 * compiled-source object the iframe accepts via INIT.drawSources,
 * or null when no visuals should render.
 *
 * Memoized on the visuals input so the iframe doesn't re-compile
 * every render. The iframe ALSO resets its INIT-sent flag when
 * compiledDraws changes, so re-emit costs one re-INIT per change.
 */
function useCompiledArenaVisuals(mode, rulesDiff) {
  // Re-memoize ONLY when the visuals BLOCK changes shape, not
  // when the surrounding rulesDiff object identity flips. The
  // realtime-postgres replay produces fresh object references
  // for every UPDATE even when content is identical; without
  // this stabilization, ArenaVisualOverlay's compiledDraws
  // prop changes every realtime tick, which triggers its INIT
  // reset effect, which cascades into a render loop with the
  // iframe's READY message. React error #185.
  const visualsKey = useMemo(() => {
    if (mode !== "ai") return mode; // demo and off don't need a key
    // Include the whole rules diff, not just rulesDiff.visuals:
    // the repair pass derives visuals from abilities when
    // visuals are missing, so ability changes must invalidate
    // this memo too.
    try { return JSON.stringify(rulesDiff || null); }
    catch { return "null"; }
  }, [mode, rulesDiff]);

  return useMemo(() => {
    if (mode === "off") return null;
    if (mode === "demo") return compileVisuals(DEMO_VISUALS).compiled;
    if (mode === "ai") {
      // Production path: render whatever the variant declares.
      // When the variant declares nothing, return null so the
      // overlay component short-circuits and we don't even
      // mount the iframe (saves ~1MB of inline source +
      // postMessage chatter for vanilla-ish variants).
      const repairedRules = repairVisualsForRules(rulesDiff);
      const v = repairedRules?.visuals;
      if (v && typeof v === "object") {
        const compiled = compileVisuals(v);
        if (compiled.errors?.length > 0 && typeof console !== "undefined") {
          console.warn("[arena-visuals] dropped invalid visual draws", compiled.errors);
        }
        return compiled.compiled;
      }
      if (typeof console !== "undefined" && rulesDiff && mode === "ai") {
        console.warn("[arena-visuals] variant has no rules.visuals block; overlay will not mount", {
          variant: rulesDiff?.name,
        });
      }
      return null;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, visualsKey]);
}

/**
 * Merge a base highlightSquares object (used by InteractiveBoard
 * for last-move tints, premove indicators, etc) with:
 *   - abilitySquares: the AbilityPanel's hover-highlight squares
 *     (amber tint so the user can find their casters)
 *   - castFlash: a brief pulse on the most recent ability cast's
 *     caster + target squares (red/orange tint, cleared after
 *     ~700ms by the parent state). This is the "something just
 *     happened!" feedback the user was missing.
 *
 * Pure function; all inputs may be empty/null.
 */
function mergeHighlight(base, abilitySquares, castFlash) {
  let out = base ? { ...base } : {};
  if (Array.isArray(abilitySquares) && abilitySquares.length > 0) {
    for (const sq of abilitySquares) {
      out[sq] = { ...(out[sq] || {}), backgroundColor: "rgba(251,191,36,0.32)" };
    }
  }
  if (castFlash && castFlash.from && castFlash.to) {
    // CSS keyframes named in the project's tailwind / globals
    // would let us pulse properly, but to keep this self-
    // contained we use a strong red tint that the existing
    // last-move-clearing effect will replace 700ms later.
    // Visually distinct from green/red move/capture highlights.
    out[castFlash.from] = {
      ...(out[castFlash.from] || {}),
      boxShadow: "inset 0 0 0 4px rgba(251,191,36,0.85)",
      backgroundColor: "rgba(251,191,36,0.25)",
    };
    if (castFlash.to !== castFlash.from) {
      out[castFlash.to] = {
        ...(out[castFlash.to] || {}),
        boxShadow: "inset 0 0 0 4px rgba(239,68,68,0.85)",
        backgroundColor: "rgba(239,68,68,0.30)",
      };
    }
  }
  return out;
}

function ArenaInputModeToggle({ mode, onChange, disabled }) {
  const isAbility = mode === "ability";
  return (
    <div className="mb-2 p-2 bg-surface-low border border-white/[0.04]">
      <div className="grid grid-cols-2 gap-1">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange("move")}
          className={`px-3 py-2 text-[10px] font-headline font-bold uppercase tracking-widest border transition-colors ${
            !isAbility
              ? "bg-primary/18 border-primary/35 text-primary"
              : "bg-surface-container border-white/[0.05] text-on-surface-variant/45 hover:text-on-surface"
          }`}
        >
          Move
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange("ability")}
          className={`px-3 py-2 text-[10px] font-headline font-bold uppercase tracking-widest border transition-colors ${
            isAbility
              ? "bg-amber-500/18 border-amber-500/40 text-amber-300"
              : "bg-surface-container border-white/[0.05] text-on-surface-variant/45 hover:text-amber-300"
          }`}
        >
          Ability
        </button>
      </div>
      <p className="mt-1.5 text-[10px] text-on-surface-variant/45 leading-snug">
        {isAbility
          ? "Ability mode: left-click a caster, then left-click a red target. Dragging is disabled."
          : "Move mode: drag or left-click pieces normally. Abilities are hidden until you switch modes."}
      </p>
    </div>
  );
}

function CastingBanner({ selectedAbility, onCancel }) {
  if (!selectedAbility) return null;
  return (
    <div className="mb-2 px-3 py-2 bg-amber-500/15 border border-amber-500/35 text-amber-100 flex items-center justify-between gap-3">
      <div>
        <div className="font-headline text-[11px] font-bold uppercase tracking-widest text-amber-300">
          Casting {selectedAbility.label || selectedAbility.abilityId}
        </div>
        <div className="text-[11px] text-amber-100/70">
          Click one of your highlighted casters, then click a red target.
        </div>
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="text-[10px] uppercase tracking-widest text-amber-200/70 hover:text-amber-100"
      >
        Cancel
      </button>
    </div>
  );
}

/**
 * Look up an ability descriptor on a resolved rules object by
 * the piece-type that owns it and the ability id. Tries
 * byColor first (asymmetric), falls back to symmetric pieces.
 *
 * Used by the ability-cast sound dispatcher: the move object
 * carries `casterType` + `abilityId`, and we need the full
 * descriptor (specifically `effect.kind`) to pick the right
 * sound.
 */
function findAbilityInRules(rules, pieceType, abilityId, color) {
  if (!rules || !pieceType || !abilityId) return null;
  if (color) {
    const arr = rules.byColor?.[color]?.[pieceType]?.abilities;
    if (Array.isArray(arr)) {
      const m = arr.find((a) => a?.id === abilityId);
      if (m) return m;
    }
  }
  const arr2 = rules.pieces?.[pieceType]?.abilities;
  if (Array.isArray(arr2)) {
    return arr2.find((a) => a?.id === abilityId) || null;
  }
  return null;
}

function VariantErrorToast({ message, onDismiss }) {
  if (!message) return null;
  return (
    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[4] pointer-events-auto px-3 py-2 bg-red-500/95 text-white text-[11px] font-mono font-bold border border-red-300/40 max-w-[80%] truncate shadow-lg">
      <button onClick={onDismiss} className="cursor-pointer">{message}</button>
    </div>
  );
}

function ChannelHealthToast({ health }) {
  if (health === "healthy" || health === "connecting") return null;
  const label = health === "closed" ? "Disconnected" : "Reconnecting\u2026";
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 bg-amber-500/15 border border-amber-500/30 text-amber-200 text-[11px] font-headline font-bold uppercase tracking-widest shadow-lg">
      {label}
    </div>
  );
}

/**
 * Human-readable room status. Mirrors the lobby formatter in
 * ArenaPage so the header pill doesn't show raw enum values
 * like "warmup_round_1".
 */
function formatRoomStatusInline(status) {
  switch (status) {
    case "waiting_for_joiner": return "Waiting for opponent";
    case "prompting": return "Picking rules";
    case "warmup_round_1": return "Warmup \u00b7 round 1";
    case "warmup_round_2": return "Warmup \u00b7 round 2";
    case "round_1": return "Round 1";
    case "round_2": return "Round 2";
    case "tiebreak": return "Tie-break";
    case "done": return "Match complete";
    case "abandoned": return "Abandoned";
    default: return status;
  }
}

// ── Body dispatch ──────────────────────────────────────────

function RoomBody({ room, setRoom, role, user, roomId }) {
  // Spectator (not creator and not joiner). The share-link UX
  // assumes the link recipient is the intended joiner; we
  // gate access to the open seat behind an explicit "Join"
  // click so a stranger who knows the URL can't auto-claim.
  // If the seat is already filled, the user gets a read-only
  // spectator view of whatever state the room is in.
  if (!role) {
    if (room.joiner_id) {
      return <SpectatorView room={room} setRoom={setRoom} user={user} roomId={roomId} />;
    }
    return <ClaimJoinerSeat room={room} setRoom={setRoom} user={user} roomId={roomId} />;
  }

  // Lobby states.
  if (room.status === "waiting_for_joiner" || room.status === "prompting") {
    return (
      <Lobby
        room={room}
        setRoom={setRoom}
        role={role}
        user={user}
        roomId={roomId}
      />
    );
  }

  // Warmup states.
  //
  // Both warmup_round_1 and warmup_round_2 hit this branch and
  // return the same component type, which means React would
  // re-use the Warmup instance across rounds without the key
  // below. That caused per-round local state (practice
  // position, in-flight bot move, secondsLeft) to leak from
  // round 1's warmup into round 2's. Keying off status forces a
  // fresh mount so the new round starts clean: position back to
  // the rule's startingFen, bot move aborted, timer back to
  // WARMUP_DURATION_S.
  if (room.status === "warmup_round_1" || room.status === "warmup_round_2") {
    return (
      <Warmup
        key={room.status}
        room={room}
        setRoom={setRoom}
        role={role}
        roomId={roomId}
      />
    );
  }

  // Round play (rounds 1, 2, tie-break).
  //
  // Same React-instance-reuse hazard as warmup. round_2 ->
  // tiebreak in particular skips the warmup intermediate (no
  // tiebreak warmup), so without the key the previous round's
  // localPosition, localPly, premove, moves[], confirmRemove,
  // and clock-tick state would all bleed across. Keying off the
  // status guarantees the new round starts from the room's
  // freshly-initialised round_state with empty local state and
  // a clean clock.
  if (room.status === "round_1" || room.status === "round_2" || room.status === "tiebreak") {
    return (
      <RoundPlay
        key={room.status}
        room={room}
        setRoom={setRoom}
        role={role}
        user={user}
        roomId={roomId}
      />
    );
  }

  // Match results.
  if (room.status === "done") {
    return (
      <MatchResults
        room={room}
        setRoom={setRoom}
        role={role}
        user={user}
      />
    );
  }

  // Defensive fallback for an unknown status. Should never
  // happen unless the DB picks up a value the UI doesn't
  // know yet.
  return (
    <div className="anim-fade-up p-6 bg-surface-low border border-white/[0.04]">
      <p className="text-[13px] text-on-surface-variant/55">
        Unknown room status: <span className="font-mono text-error">{room.status}</span>.
      </p>
    </div>
  );
}

// ── Spectator -> auto-claim joiner ─────────────────────────

function ClaimJoinerSeat({ room, setRoom, user, roomId }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  const onClaim = useCallback(async () => {
    setPending(true);
    setError(null);
    const result = await joinRoom({
      roomId,
      joinerId: user.id,
      joinerName: user.name || null,
    });
    setPending(false);
    if (!result.ok || !result.room) {
      // RLS rejection / race. If RLS rejected because the seat
      // was filled, surface that specifically. Otherwise show
      // the raw error.
      setError(result.error || "Couldn't join the room.");
      return;
    }
    // Push the freshly-updated row into the parent state right
    // away so the next render dispatches into the Lobby. We
    // can't rely on realtime for this transition because the
    // joiner's subscription was opened BEFORE the join, and the
    // race between the UPDATE landing and the channel signaling
    // SUBSCRIBED would leave the user staring at "Loading\u2026
    // opening the lobby" forever in the worst case.
    setRoom?.((prev) => ({ ...(prev || {}), ...result.room }));
  }, [roomId, user, setRoom]);

  if (room.joiner_id) {
    return (
      <div className="anim-fade-up p-6 bg-surface-low border border-white/[0.04]">
        <h2 className="font-headline text-base font-bold text-primary mb-1">Room is full</h2>
        <p className="text-[12px] text-on-surface-variant/55">
          Two players are already in this arena. Ask the host for a new link.
        </p>
      </div>
    );
  }

  return (
    <div className="anim-fade-up p-6 bg-surface-low border border-primary/20 space-y-4">
      <div>
        <h2 className="font-headline text-base font-bold text-primary mb-1">Join this room?</h2>
        <p className="text-[12px] text-on-surface-variant/55 leading-relaxed">
          {room.creator_name || "The host"} is waiting for an opponent.
          Click join to claim the second seat.
        </p>
      </div>
      <button onClick={onClaim} disabled={pending}
        className="btn btn-primary w-full py-3 text-sm">
        {pending ? "Loading\u2026 joining" : "Join room"}
      </button>
      {error && (
        <p className="text-[12px] text-error">{error}</p>
      )}
    </div>
  );
}

// ── Lobby (rule pickers + share link) ──────────────────────

function Lobby({ room, setRoom, role, user, roomId }) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState(null);
  const cancelTimerRef = useRef(null);
  useEffect(() => () => {
    if (cancelTimerRef.current) clearTimeout(cancelTimerRef.current);
  }, []);

  const myRules = role === "creator" ? room.rules_creator : room.rules_joiner;
  const oppRules = role === "creator" ? room.rules_joiner : room.rules_creator;
  const oppName = role === "creator" ? room.joiner_name : room.creator_name;
  const youName = role === "creator" ? room.creator_name : room.joiner_name;

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/arena/${roomId}`;
  }, [roomId]);

  const onCopyShare = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard might not be available (insecure context, etc.).
      // Fall back silently - the URL is also visible in the input.
    }
  }, [shareUrl]);

  // When the joiner commits AI-generated rules. Mirrors the
  // creator's commit-on-create flow but happens here in the
  // lobby because the joiner doesn't pick rules until they've
  // landed in the room.
  //
  // Status decision uses ONLY the truthiness of rules_creator on
  // the latest room snapshot, never the pre-merge state. The
  // previous version pushed status=prompting whenever joiner_id
  // was set, which on a normally-set-up room kept it stuck at
  // 'prompting' even when the creator's rules were missing - the
  // dead-end branch in RuleSummary then showed the "weren't
  // saved correctly" copy with no recovery affordance.
  const onCommitJoinerRules = useCallback(async (rules) => {
    const patch = { rules_joiner: rules };
    // Only advance to warmup if the room ALREADY has
    // rules_creator stamped. We never invent a status that
    // would skip the creator's rules.
    if (room.rules_creator) {
      patch.status = "warmup_round_1";
    } else if (room.status === "waiting_for_joiner") {
      // Defensive: shouldn't happen post-fix to joinRoom (which
      // bumps to prompting on join), but if we somehow arrive
      // here with the open-seat status, normalize it.
      patch.status = "prompting";
    }
    const result = await updateRoom(roomId, patch);
    if (result?.ok && result.room) {
      setRoom?.((prev) => ({ ...(prev || {}), ...result.room }));
    }
  }, [room.rules_creator, room.status, roomId, setRoom]);

  // Recovery path for the creator if rules_creator never made
  // it onto the row. Same handler shape as
  // onCommitJoinerRules but writes the creator's slot. Will
  // also advance to warmup if the joiner's rules are already
  // committed.
  const onCommitCreatorRules = useCallback(async (rules) => {
    const patch = { rules_creator: rules };
    if (room.rules_joiner) {
      patch.status = "warmup_round_1";
    } else if (room.joiner_id && room.status === "waiting_for_joiner") {
      patch.status = "prompting";
    }
    const result = await updateRoom(roomId, patch);
    if (result?.ok && result.room) {
      setRoom?.((prev) => ({ ...(prev || {}), ...result.room }));
    }
  }, [room.rules_joiner, room.joiner_id, room.status, roomId, setRoom]);

  // Creator-only: cancel the room and bounce back to /arena.
  // Only allowed while no joiner has claimed the second seat;
  // once both sides are in, neither can unilaterally delete.
  const canCancel = role === "creator" && !room.joiner_id;
  const onCancel = useCallback(async () => {
    if (!canCancel) return;
    if (!confirmCancel) {
      setConfirmCancel(true);
      if (cancelTimerRef.current) clearTimeout(cancelTimerRef.current);
      cancelTimerRef.current = setTimeout(() => setConfirmCancel(false), 4000);
      return;
    }
    if (cancelTimerRef.current) clearTimeout(cancelTimerRef.current);
    setConfirmCancel(false);
    setCancelPending(true);
    setCancelError(null);
    const result = await deleteRoom(roomId);
    setCancelPending(false);
    if (!result?.ok) {
      setCancelError(result?.error || "Couldn't cancel the room.");
      return;
    }
    navigate("/arena");
  }, [canCancel, confirmCancel, roomId, navigate]);

  return (
    <div className="grid gap-4 sm:gap-6 xl:grid-cols-[1fr_320px] anim-fade-up">
      <div className="space-y-3 sm:space-y-4">
        <div className="p-4 sm:p-5 bg-surface-low border border-white/[0.04] space-y-3">
          <h2 className="font-headline text-sm font-bold uppercase tracking-widest text-on-surface-variant/45">
            Your rules
          </h2>
          {myRules ? (
            <RuleSummary rules={myRules} />
          ) : role === "joiner" ? (
            <JoinerRulePrompt onCommit={onCommitJoinerRules} />
          ) : (
            // Creator's rules are normally committed at room-
            // creation time, so this branch only fires if the
            // creator landed here without rules (rare: the
            // INSERT succeeded but rules_creator was null because
            // a stale realtime payload overwrote it, or a bad
            // initial deploy). Surface the same prompt panel the
            // joiner uses so the creator can recover without
            // having to cancel + re-create the room.
            <JoinerRulePrompt onCommit={onCommitCreatorRules} />
          )}
        </div>

        <div className="p-4 sm:p-5 bg-surface-low border border-white/[0.04] space-y-3">
          <h2 className="font-headline text-sm font-bold uppercase tracking-widest text-on-surface-variant/45">
            Opponent&apos;s rules
          </h2>
          {oppRules ? (
            <RuleSummary rules={oppRules} />
          ) : (
            <p className="text-[12px] text-on-surface-variant/45">
              {oppName ? `${oppName} is designing the variant\u2026` : "Waiting for opponent\u2026"}
            </p>
          )}
        </div>
      </div>

      {/* Right rail: identity + share link. */}
      <div className="space-y-4">
        <div className="p-5 bg-surface-container border border-primary/20 space-y-2">
          <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-primary/60">
            Share link
          </h3>
          <input
            value={shareUrl}
            readOnly
            onFocus={(e) => e.target.select()}
            className="w-full bg-surface-low border border-white/[0.06] px-3 py-2 text-[12px] font-mono text-on-surface-variant/65 outline-none focus:border-primary/40"
          />
          <button onClick={onCopyShare}
            className={`btn w-full py-2 text-[11px] ${copied ? "bg-emerald-500/15 border border-emerald-500/20 text-emerald-400" : "btn-secondary"}`}>
            {copied ? "Copied" : "Copy link"}
          </button>
          <p className="text-[10px] text-on-surface-variant/35 leading-snug">
            Send this to your opponent. They must be signed in to join.
          </p>
        </div>

        <div className="p-5 bg-surface-low border border-white/[0.04] space-y-2">
          <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">
            Players
          </h3>
          <p className="text-[12px] text-on-surface-variant/65">
            <span className="text-on-surface-variant/40">You ({role}):</span> {youName || user.name || "you"}
          </p>
          <p className="text-[12px] text-on-surface-variant/65">
            <span className="text-on-surface-variant/40">Opponent:</span> {oppName || (room.joiner_id ? "joined" : "waiting\u2026")}
          </p>
        </div>

        {/* Color assignment hint. The orchestrator pairs the
            rule designer with Black so the opponent gets the
            slight first-move advantage to compensate for the
            designer knowing their own variant. Surface that
            here so players don't get a surprise when round 1
            starts. */}
        <div className="p-5 bg-surface-low border border-white/[0.04] space-y-1.5">
          <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">
            Round colors
          </h3>
          <p className="text-[11px] text-on-surface-variant/65 leading-snug">
            <span className="text-on-surface-variant/40">Round 1:</span> you play{" "}
            <span className="text-on-surface-variant/85 font-bold">{role === "creator" ? "Black" : "White"}</span>
            {role === "creator" && <span className="text-on-surface-variant/35"> (you wrote the rules)</span>}
          </p>
          <p className="text-[11px] text-on-surface-variant/65 leading-snug">
            <span className="text-on-surface-variant/40">Round 2:</span> you play{" "}
            <span className="text-on-surface-variant/85 font-bold">{role === "creator" ? "White" : "Black"}</span>
          </p>
          <p className="text-[10px] text-on-surface-variant/35 leading-snug pt-0.5">
            Tie-break (if 1-1) plays vanilla chess at 1+0.
          </p>
        </div>

        {/* Cancel-room: creator-only, only available while no
            opponent has claimed the second seat. Two-step
            confirm matches the destructive-action pattern used
            in /review (overflow menu Remove / Reset). */}
        {canCancel && (
          <div className="p-4 bg-surface-low border border-white/[0.04] space-y-2">
            <button onClick={onCancel}
              disabled={cancelPending}
              title={confirmCancel ? "Tap to permanently cancel this room" : "Cancel this room"}
              className={`w-full px-3 py-2 font-headline text-[10px] font-bold uppercase tracking-widest border transition-colors ${
                confirmCancel
                  ? "bg-error/15 border-error/30 text-error animate-pulse"
                  : "bg-surface-container border-white/[0.04] text-on-surface-variant/45 hover:text-error hover:border-error/20"
              }`}>
              {cancelPending
                ? "Loading\u2026 cancelling"
                : confirmCancel
                  ? "Tap to confirm"
                  : "Cancel room"}
            </button>
            {cancelError && (
              <p className="text-[11px] text-error leading-snug">{cancelError}</p>
            )}
            <p className="text-[10px] text-on-surface-variant/35 leading-snug">
              Removes the room before anyone joins. After your opponent joins you can&apos;t cancel solo.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Joiner's "design my round" panel. Mirrors the creator's
 * CreatePanel UX from /arena: free-form prompt -> Generate ->
 * preview -> Commit. One commit per room (per spec) - once
 * the joiner clicks Commit, no more regeneration.
 *
 * Uses the same generateArenaRules() wrapper so rate limiting
 * and validator errors flow through identically. Keeps the
 * preview rendering consistent with /arena's CreatePanel via
 * the shared RulePreview / describeRules pair.
 */
const JOINER_PROMPT_IDEAS = [
  { label: "Kings in middle", prompt: "Both kings start in the middle of the board, surrounded by their pieces." },
  { label: "Atomic chess", prompt: "Captures explode and destroy adjacent non-pawn pieces. Kings cannot capture." },
  { label: "Race to back rank", prompt: "First king to reach the opposite back rank wins. No checkmate needed." },
  { label: "Three captures wins", prompt: "First player to capture three enemy pieces wins immediately." },
  { label: "Knights leap twice", prompt: "Knights can leap to a normal knight square OR another knight-hop further out." },
  { label: "Pawns sideways too", prompt: "Pawns can also move sideways one square without capturing." },
];

/**
 * Friendly translation of validator errors for the joiner's
 * rule-prompt panel. Mirrors the FriendlyValidatorErrors
 * component on the create panel - separate function so the
 * two can drift independently if needed (different copy
 * tone, etc.) without requiring a cross-file refactor.
 */
function FriendlyJoinerValidatorErrors({ errors }) {
  const [showDetails, setShowDetails] = useState(false);
  const friendly = useMemo(() => translateValidatorErrors(errors), [errors]);
  return (
    <div className="px-3 py-2.5 bg-amber-500/10 border border-amber-500/20 space-y-2">
      <p className="text-[12px] text-amber-200/85 leading-relaxed font-headline font-bold">
        {friendly.headline}
      </p>
      <p className="text-[11px] text-amber-200/60 leading-snug">
        {friendly.hint}
      </p>
      {friendly.raw.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="text-[10px] uppercase tracking-widest text-amber-200/45 hover:text-amber-200/80 transition-colors"
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>
          {showDetails && (
            <ul className="mt-1.5 text-[10px] text-amber-200/40 leading-snug space-y-0.5 font-mono">
              {friendly.raw.slice(0, 5).map((e, i) => (
                <li key={i}>&middot; {e}</li>
              ))}
              {friendly.raw.length > 5 && (
                <li className="italic">&hellip; and {friendly.raw.length - 5} more</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function JoinerPromptIdeas({ onPick, disabled }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {JOINER_PROMPT_IDEAS.map((idea) => (
        <button
          key={idea.label}
          type="button"
          disabled={disabled}
          onClick={() => onPick(idea.prompt)}
          className="px-2.5 py-1 text-[10px] font-headline font-bold uppercase tracking-widest border border-white/[0.06] text-on-surface-variant/55 hover:text-primary hover:border-primary/30 disabled:opacity-30 transition-colors"
        >
          {idea.label}
        </button>
      ))}
    </div>
  );
}

function JoinerRulePrompt({ onCommit }) {
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(null);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState(null);
  const [validatorErrors, setValidatorErrors] = useState(null);
  const [cooldownSec, setCooldownSec] = useState(0);
  const aiAvailable = isAIRulesAvailable();

  useEffect(() => {
    if (cooldownSec <= 0) return undefined;
    const t = setTimeout(() => setCooldownSec((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldownSec]);

  const resolvedRules = useMemo(() => {
    if (!generated?.rules) return null;
    try { return resolveRules(generated.rules); }
    catch { return null; }
  }, [generated]);
  const description = useMemo(
    () => resolvedRules ? describeRules(resolvedRules) : null,
    [resolvedRules],
  );

  const onGenerate = useCallback(async () => {
    if (!aiAvailable) {
      setError("AI rule generator isn't available.");
      return;
    }
    if (!prompt.trim()) {
      setError("Type a description first.");
      return;
    }
    setGenerating(true);
    setError(null);
    setValidatorErrors(null);
    try {
      const result = await generateArenaRules(prompt);
      if (!result.ok) {
        setError(result.error || "AI couldn't produce rules.");
        if (result.validatorErrors) setValidatorErrors(result.validatorErrors);
        if (result.rateLimited && result.retryAfterSeconds) {
          setCooldownSec(Math.ceil(Number(result.retryAfterSeconds)) || 0);
        }
        return;
      }
      setGenerated({ rules: result.rules, model: result.model });
    } catch (e) {
      setError(e?.message || "AI request failed.");
    } finally {
      setGenerating(false);
    }
  }, [aiAvailable, prompt]);

  const onCommit_ = useCallback(async () => {
    if (!generated?.rules) return;
    setCommitting(true);
    setError(null);
    try {
      await onCommit(generated.rules);
    } catch (e) {
      setError(e?.message || "Couldn't save your rules.");
    } finally {
      setCommitting(false);
    }
  }, [generated, onCommit]);

  if (!aiAvailable) {
    return (
      <p className="text-[12px] text-error leading-relaxed">
        AI rule generation isn&apos;t configured. The Edge Function (arena_rules) needs to be deployed.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant/40 block mb-1.5">
          Describe your variant
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. Bishops can also leap one square. Knights move twice per turn."
          rows={4}
          maxLength={2000}
          disabled={generating || committing}
          className="w-full bg-surface-container border border-white/[0.06] px-3 py-2 text-[13px] text-on-surface placeholder:text-on-surface-variant/30 outline-none focus:border-primary/40 resize-none"
        />
        <p className="mt-1 text-[10px] text-on-surface-variant/30">
          {prompt.length} / 2000
        </p>
        <JoinerPromptIdeas onPick={(text) => setPrompt(text)} disabled={generating || committing} />
      </div>
      <button onClick={onGenerate}
        disabled={generating || cooldownSec > 0 || committing || !prompt.trim()}
        className="btn btn-secondary w-full py-2.5 text-xs">
        {generating
          ? "Loading\u2026 asking AI"
          : cooldownSec > 0
            ? `Wait ${cooldownSec}s`
            : generated ? "Regenerate" : "Generate rules"}
      </button>

      {description && (
        <RulePreview description={description} model={generated?.model} />
      )}

      {error && (
        <p className="text-[12px] text-error leading-relaxed">{error}</p>
      )}
      {validatorErrors && validatorErrors.length > 0 && (
        <FriendlyJoinerValidatorErrors errors={validatorErrors} />
      )}

      {generated && (
        <button onClick={onCommit_}
          disabled={committing}
          className="btn btn-primary w-full py-3 text-sm">
          {committing ? "Loading\u2026 saving" : "Lock in these rules"}
        </button>
      )}
    </div>
  );
}

/**
 * Compact rule summary for an already-committed rule diff.
 * Tries to surface the preset label first (Phase 1 had hand-
 * curated presets); falls back to the AI-generated rule's name
 * + describe-based change list. Used in the lobby +
 * round-play side panels so both players see what each round
 * actually changes.
 */
function RuleSummary({ rules, compact }) {
  const preset = rules?.presetId ? presetById(rules.presetId) : null;
  const [expanded, setExpanded] = useState(false);
  const resolved = useMemo(() => {
    if (!rules) return null;
    try { return resolveRules(rules); }
    catch { return null; }
  }, [rules]);
  const description = useMemo(
    () => resolved ? describeRules(resolved) : null,
    [resolved],
  );
  const name = preset?.label || rules?.name || description?.name || "Custom rules";
  const blurb = preset?.summary || description?.description || rules?.description || "Custom variant rules.";

  if (compact) {
    return (
      <div className="px-3 py-2.5 bg-surface-container border border-white/[0.04]">
        <span className="font-headline text-[13px] font-bold text-primary block mb-0.5">{name}</span>
        <span className="text-[11px] text-on-surface-variant/55 leading-snug">{blurb}</span>
      </div>
    );
  }

  // Default to a tighter 3-change preview so the lobby panels
  // don't stretch to 8+ lines on rich variants. The full list
  // is one click away.
  const changes = description?.changes || [];
  const visibleCount = expanded ? changes.length : Math.min(3, changes.length);

  return (
    <div className="px-3 py-3 bg-surface-container border border-white/[0.04] space-y-2">
      <div>
        <span className="font-headline text-[13px] font-bold text-primary block mb-0.5">{name}</span>
        <span className="text-[11px] text-on-surface-variant/55 leading-snug">{blurb}</span>
      </div>
      {changes.length > 0 && (
        <ul className="text-[11px] text-on-surface-variant/65 leading-snug space-y-0.5 pt-1 border-t border-white/[0.04]">
          {changes.slice(0, visibleCount).map((c, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-primary/60 shrink-0">&middot;</span>
              <span>{c.detail}</span>
            </li>
          ))}
          {!expanded && changes.length > 3 && (
            <li>
              <button onClick={() => setExpanded(true)}
                className="text-[10px] uppercase tracking-widest text-primary/65 hover:text-primary transition-colors mt-0.5">
                +{changes.length - 3} more changes
              </button>
            </li>
          )}
          {expanded && changes.length > 3 && (
            <li>
              <button onClick={() => setExpanded(false)}
                className="text-[10px] uppercase tracking-widest text-primary/65 hover:text-primary transition-colors mt-0.5">
                Show less
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

// ── Warmup ─────────────────────────────────────────────────

// 30s wasn't long enough for users to feel out a brand-new
// variant - they'd still be processing the rule modifier when
// the timer expired. 60s gives time to actually try a couple
// of moves, see how the variant changes things, and react.
const WARMUP_DURATION_S = 60;

function Warmup({ room, setRoom, role, roomId }) {
  const round = room.status === "warmup_round_1" ? 1 : 2;
  const rulesDiff = round === 1 ? room.rules_creator : room.rules_joiner;
  // Round 1: creator plays Black under their own rules
  // (because the rule designer plays Black per the spec). The
  // joiner plays White. Round 2 is the mirror.
  const myColor = round === 1
    ? (role === "creator" ? "b" : "w")
    : (role === "creator" ? "w" : "b");

  // Stable key for the rules so we re-resolve only when the
  // ACTUAL rules change. Without this, every realtime UPDATE
  // produces a fresh `rulesDiff` object reference (Postgres
  // re-parses jsonb on each row replay), the useMemo dep
  // changes, `rules` becomes a new identity, and the
  // rules-effect below resets the warmup timer back to the
  // full duration. Symptom: warmup loops at 30s forever.
  const rulesKey = useMemo(() => {
    try { return JSON.stringify(rulesDiff || { extends: "vanilla" }); }
    catch { return "vanilla"; }
  }, [rulesDiff]);

  const rules = useMemo(() => {
    try { return resolveRules(rulesDiff || { extends: "vanilla" }); }
    catch { return resolveRules({ extends: "vanilla" }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesKey]);

  const [position, setPosition] = useState(() => Position.fromFen(rules.startingFen || VANILLA_FEN));
  const [highlight, setHighlight] = useState({});
  const [secondsLeft, setSecondsLeft] = useState(WARMUP_DURATION_S);
  // Ship #3 visual overlay (sandboxed iframe). No-op unless the
  // localStorage feature flag is set; see useArenaVisualsMode.
  const visualsMode = useArenaVisualsMode(roomId);
  const compiledVisuals = useCompiledArenaVisuals(visualsMode, rulesDiff);
  // In-flight projectile timeline. Each ability cast pushes one
  // entry; the hook auto-decays them over their TTL. The
  // overlay's iframe runtime renders projectile draws as they
  // fly from caster to target.
  const { projectiles, fireProjectile } = useActiveProjectiles();
  // Lab flag for the debug panel.
  const isLabUser = useLabFlag();
  // Ability-panel hover highlight. When the user hovers a row in
  // the AbilityPanel, the panel calls back with the squares that
  // hold castable pieces; we paint those squares amber on the
  // board so the user can find their casters at a glance.
  const [abilityHighlight, setAbilityHighlight] = useState([]);
  const [inputMode, setInputMode] = useState("move");
  const [selectedAbility, setSelectedAbility] = useState(null);
  // Cast flash: when an ability fires, the caster's square and
  // target square pulse briefly so the user gets a visual signal
  // that something happened. Auto-clears after 700ms.
  const [castFlash, setCastFlash] = useState(null); // { from, to } | null
  useEffect(() => {
    if (!castFlash) return undefined;
    const t = setTimeout(() => setCastFlash(null), 700);
    return () => clearTimeout(t);
  }, [castFlash]);
  // Crazy Arena Ship #2.5: stash the most recent VariantError
  // message so the warmup UI can surface a small toast. Clears
  // automatically after a few seconds via the effect below.
  const [variantError, setVariantError] = useState(null);
  useEffect(() => {
    if (!variantError) return undefined;
    const t = setTimeout(() => setVariantError(null), 4000);
    return () => clearTimeout(t);
  }, [variantError]);

  // Hydrate `ready` from the room row so a reload mid-warmup
  // doesn't lose the flag. If this user already pushed
  // readiness for the current round before reloading, the DB
  // remembers it and we re-mount with the same state.
  const myReadyKey = role === "creator" ? "warmup_creator_ready" : "warmup_joiner_ready";
  const initialReady = (room.round_state || {})[myReadyKey] === round;
  const [ready, setReady] = useState(initialReady);
  const abortRef = useRef(null);
  // Track whether we've already pushed our readiness flag so
  // the persistence effect doesn't fire on every parent room
  // update. Pre-armed when the DB already has our flag (reload
  // case) so we don't redundantly re-write.
  const readinessSyncedRef = useRef(initialReady);

  // Reset board if rules CHANGE (round 1 -> round 2). Keys off
  // the JSON of the rules diff so a no-op realtime echo of the
  // same rules doesn't wipe the timer. Round transitions clear
  // ready / readinessSyncedRef because the new round's flags
  // are scoped to the new round value.
  useEffect(() => {
    setPosition(Position.fromFen(rules.startingFen || VANILLA_FEN));
    setHighlight({});
    setSecondsLeft(WARMUP_DURATION_S);
    setReady(false);
    readinessSyncedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesKey]);

  // Tick the warmup timer once a second.
  useEffect(() => {
    if (secondsLeft <= 0) return undefined;
    const t = setTimeout(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  // When my clock hits zero, mark ready. (Or when I click
  // ready manually.)
  useEffect(() => {
    if (secondsLeft <= 0 && !ready) setReady(true);
  }, [secondsLeft, ready]);

  // Persist my readiness to the room row exactly once when
  // `ready` flips to true. The previous version had
  // `room.round_state` in the deps, which made this effect
  // re-fire on every realtime UPDATE and pushed a redundant
  // patch each time - a sync loop with the opponent's clients.
  // Now we use a ref guard so we write once, and we read the
  // current room.round_state at write-time (not via deps) to
  // merge cleanly.
  useEffect(() => {
    if (!ready) return;
    if (readinessSyncedRef.current) return;
    readinessSyncedRef.current = true;
    const flagKey = role === "creator" ? "warmup_creator_ready" : "warmup_joiner_ready";
    const round_state = { ...(room.round_state || {}), [flagKey]: round };
    (async () => {
      const result = await updateRoom(roomId, { round_state });
      // Push the freshly-updated row into parent state so the
      // opponent-ready check fires immediately on this side.
      if (result?.ok && result.room && setRoom) {
        setRoom((prev) => ({ ...(prev || {}), ...result.room }));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, role, round]);

  // Opponent ready flag from the room row. Reads from the
  // latest snapshot on every render - this DOES depend on
  // round_state so it picks up realtime updates, but it's a
  // pure derive (no writes) so there's no loop risk.
  const oppReady = useMemo(() => {
    const flagKey = role === "creator" ? "warmup_joiner_ready" : "warmup_creator_ready";
    return (room.round_state || {})[flagKey] === round;
  }, [room.round_state, role, round]);

  // When BOTH are ready, advance status to round_<n> AND
  // initialize the round state (clock + starting fen). First
  // client to win this race transitions; the other reacts via
  // realtime. Use a ref so the advance happens at most once
  // per warmup round.
  const advancedRef = useRef(false);
  useEffect(() => {
    if (!ready || !oppReady) return;
    if (advancedRef.current) return;
    const nextStatus = round === 1 ? "round_1" : "round_2";
    if (room.status === nextStatus) return;
    advancedRef.current = true;
    (async () => {
      // Initialize the round's playing state - which side moves
      // first determined by the round's color assignment, clock
      // budget by round type. Living in round_state means a
      // refresh / late-joiner picks up the same starting point.
      //
      // We REPLACE round_state wholesale (no spread) so leftover
      // warmup-only fields (warmup_creator_ready, etc.) don't
      // leak into the round. The round needs exactly: round
      // number, starting fen, ply counter, fresh clock,
      // started-at timestamp - nothing else from the warmup
      // phase is meaningful here.
      //
      // Also wipe crazy_state in the same write. Whatever the
      // user did during the bot-vs-bot warmup (used a fireball,
      // burnt a square) lives in crazy_state and would otherwise
      // carry into the real round - so we hand the user a board
      // with full ability charges, no cooldowns, no marks. The
      // engine treats crazy_state = null as "fresh".
      const startingFen = rules.startingFen || VANILLA_FEN;
      const startingPos = Position.fromFen(startingFen);
      const colorPair = colorPairFor(round);
      const firstMover = colorPair.creator === startingPos.turn ? "creator" : "joiner";
      const round_state = {
        round: round,
        fen: startingFen,
        plyCount: 0,
        clock: initRoundClock(firstMover),
        startedAt: new Date().toISOString(),
      };
      const result = await updateRoom(roomId, {
        status: nextStatus,
        round_state,
        crazy_state: null,
      });
      if (result?.ok && result.room && setRoom) {
        setRoom((prev) => ({ ...(prev || {}), ...result.room }));
      }
    })();
  }, [ready, oppReady, round, room.status, room.round_state, roomId, setRoom, rules]);

  // Per-square legal-move enumerator wired to the VARIANT
  // rules, fed to InteractiveBoard so its dot-hint affordance
  // shows the right squares for "no castling" / "reverse
  // pawns" / etc. Without this the board would default to
  // chess.js's standard-rules hints, which are wildly wrong
  // for any variant. The shape matches the one chess.js
  // produces (`{ to, captured?, promotion? }`) so the board
  // doesn't need to special-case anything.
  const legalMovesProvider = useCallback((square) => {
    if (position.turn !== myColor) return [];
    return generateLegalMoves(position, rules)
      .filter((m) => m.from === square)
      .filter((m) => inputMode === "ability" ? m.kind === "ability" : m.kind !== "ability")
      .filter((m) => inputMode !== "ability" || !selectedAbility || (
        m.abilityId === selectedAbility.abilityId && m.casterType === selectedAbility.pieceType
      ))
      .map((m) => ({
        to: m.to,
        promotion: m.promotion,
        // Mark capture moves so the board renders the larger
        // capture-ring rather than the central dot. We have
        // to look at the destination square because the
        // engine doesn't pre-stamp the captured piece on
        // pseudo-moves the way chess.js does.
        captured: !!position.pieceAt(m.to) || !!m.enPassant,
        // Ship #2.5: forward ability metadata so the board
        // renders ability targets distinctly and `onMove` can
        // dispatch the cast through applyAbilityMove. We also
        // pass casterType so the sound-dispatcher can find the
        // ability spec without re-walking the rules.
        ...(m.kind === "ability"
          ? { kind: "ability", abilityId: m.abilityId, casterType: m.casterType }
          : {}),
      }));
  }, [position, rules, myColor, inputMode, selectedAbility]);

  // When the user makes a legal move, apply it then ask the
  // bot for a reply. The async bot respects an abort signal
  // so unmounting / advancing past warmup doesn't fire a
  // ghost move.
  const onUserMove = useCallback((move) => {
    const myTurn = position.turn === myColor;
    if (!myTurn) return false;
    let next;
    try {
      next = applyMove(position, move, rules);
    } catch (e) {
      // Ship #2.5: a VariantError means the engine could not
      // resolve a structurally-legal move (e.g. malformed
      // ability descriptor reaching off-board mid-cast). The
      // warmup is a practice mode against a random bot; we
      // surface the issue to the user but keep the warmup
      // running so they can keep practicing. The live PvP
      // path treats VariantError as match-cancelling.
      if (e?.name === "VariantError") {
        setVariantError(e.message || "Variant error");
      } else {
        playError();
      }
      return false;
    }
    // Ship #2.5: ability casts get a thematic sound dispatched
    // from the ability spec itself (capture / mark / spawn /
    // etc), not the generic move sound. Plain moves fall back
    // to the standard sound.
    if (move.kind === "ability") {
      const ab = findAbilityInRules(rules, move.casterType, move.abilityId, myColor);
      playAbilityCast(ab);
      setCastFlash({ from: move.from, to: move.to, abilityId: move.abilityId });
      // If the variant has a projectile draw matching this
      // ability id, animate it flying from caster to target.
      // The iframe runtime no-ops gracefully when the kind
      // doesn't match a registered projectile draw.
      fireProjectile(move.from, move.to, move.abilityId, 900);
    } else {
      playMoveSound({ flags: move.captured ? "c" : "n" });
    }
    setPosition(next);
    setHighlight({
      [move.from]: { backgroundColor: "rgba(255,255,255,0.07)" },
      [move.to]:   { backgroundColor: "rgba(255,255,255,0.11)" },
    });
    return true;
  }, [position, myColor, rules]);

  // Bot reply when it's the bot's turn.
  useEffect(() => {
    const status = checkGameStatus(position, rules);
    if (status.ended) return undefined;
    if (position.turn === myColor) return undefined;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let cancelled = false;
    pickRandomMoveAsync(position, rules, { signal: ctrl.signal })
      .then((mv) => {
        if (cancelled || !mv) return;
        try {
          const next = applyMove(position, mv, rules);
          playMoveSound({ flags: "n" });
          setPosition(next);
          setHighlight({
            [mv.from]: { backgroundColor: "rgba(255,255,255,0.06)" },
            [mv.to]:   { backgroundColor: "rgba(255,255,255,0.10)" },
          });
        } catch { /* ignore */ }
      })
      .catch(() => { /* aborted */ });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [position, rules, myColor]);

  const orientation = myColor === "b" ? "black" : "white";

  // Same shell as RoundPlay so the warmup -> round transition
  // doesn't visually jump. Top bar advertises the warmup, the
  // board has a "Practice bot" PlayerBar above + your bar
  // below (no clock - warmup uses a session timer instead).
  return (
    <div className="min-h-[calc(100dvh-4rem)] bg-surface flex flex-col">
      <div className="w-full bg-surface-lowest/80 backdrop-blur-xl border-b border-white/[0.04] px-4 sm:px-6 h-12 flex items-center justify-between shrink-0 z-10">
        <button onClick={() => {/* warmup is uncancellable but back-arrow keeps the visual */}} className="flex items-center gap-2 text-on-surface-variant/50 py-2 pr-3 cursor-default">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
          <span className="font-headline text-lg font-extrabold tracking-tighter text-primary">oChess</span>
        </button>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/30">
            Warmup &middot; Round {round} &middot; {WARMUP_DURATION_S}s prep
          </span>
          <span className="text-[10px] font-headline font-bold uppercase tracking-wide px-2 py-0.5 bg-amber-500/15 text-amber-400 tabular-nums">
            {secondsLeft}s
          </span>
        </div>
      </div>

      <div className="flex-1 flex">
        <div className="flex-1 min-w-0 flex flex-col xl:flex-row px-4 sm:px-6 md:px-10 xl:px-6 py-3 sm:py-4 gap-4 xl:gap-6 w-full mx-auto max-w-[1400px] xl:max-w-[1500px] 2xl:max-w-[1600px]">
          <div className="flex-1 flex flex-col items-center xl:items-start max-w-[760px] xl:max-w-[920px] 2xl:max-w-[1040px]">
            <PlayerBar
              name="Practice bot"
              pieceColor={myColor === "w" ? "b" : "w"}
              active={position.turn !== myColor && !ready}
            />
            <ArenaInputModeToggle
              mode={inputMode}
              onChange={(mode) => {
                setInputMode(mode);
                if (mode === "move") setSelectedAbility(null);
              }}
              disabled={ready}
            />
            <CastingBanner
              selectedAbility={inputMode === "ability" ? selectedAbility : null}
              onCancel={() => {
                setSelectedAbility(null);
                setInputMode("move");
              }}
            />
            <div className="w-full mx-auto relative" style={{ maxWidth: "min(100%, calc(100dvh - 11rem))" }}>
              <InteractiveBoard
                fen={position.toFen()}
                onMove={onUserMove}
                orientation={orientation}
                playerColor={myColor}
                interactive={position.turn === myColor && !ready}
                dragEnabled={inputMode !== "ability"}
                selectionKey={inputMode}
                highlightSquares={mergeHighlight(highlight, abilityHighlight, castFlash)}
                legalMovesProvider={legalMovesProvider}
              />
              {/* Ship #3 visual overlay (sandboxed iframe). No-op
                  unless `arena_visuals_mode` localStorage flag is
                  set to "demo" or "ai". */}
              <ArenaVisualOverlay
                compiledDraws={compiledVisuals}
                seed={`${roomId}:warmup:${round}`}
                position={position}
                orientation={orientation}
                projectiles={projectiles}
                lastCast={castFlash}
                disabled={visualsMode === "off"}
                onDrawError={(err) => {
                  pushVisualError(roomId, err);
                  recordVisualError(err, roomId, rules?.name);
                }}
                onSlotDisabled={(slot, reason) => {
                  pushVisualError(roomId, { slot, message: `slot disabled: ${reason}`, ply: position?.history?.length });
                }}
              />
              <ArenaVisualDebugPanel
                roomId={roomId}
                isLabUser={isLabUser}
                onDisableVisuals={() => {
                  try {
                    localStorage.setItem(`arena_visuals_off:${roomId}`, "1");
                    window.dispatchEvent(new Event("storage"));
                  } catch { /* ignore */ }
                }}
              />
              <CrazyStateBadges position={position} orientation={orientation} />
              <VariantErrorToast
                message={variantError}
                onDismiss={() => setVariantError(null)}
              />
            </div>
            <PlayerBar
              name="You (warmup)"
              pieceColor={myColor}
              active={position.turn === myColor && !ready}
              isPlayer
            />
          </div>

          <div className="w-full xl:w-[340px] shrink-0 flex flex-col gap-3">
            <div className="p-3 bg-surface-low border border-white/[0.04] space-y-2 shrink-0">
              <div className="flex items-center justify-between gap-3">
                <span className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">
                  Time left
                </span>
                <span className="font-mono text-2xl font-extrabold tabular-nums text-primary">{secondsLeft}</span>
              </div>
              {!ready ? (
                <button onClick={() => setReady(true)} className="btn btn-primary w-full py-2.5 text-xs">
                  I&apos;m ready
                </button>
              ) : (
                <div className="px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 text-center text-[11px] font-bold text-emerald-300">
                  {oppReady ? "Both ready \u2014 starting\u2026" : "You're ready. Waiting on opponent\u2026"}
                </div>
              )}
              <p className="text-[10px] text-on-surface-variant/40 leading-snug">
                Move freely against a random-move bot. Once both players are ready (or time runs out) the real round starts.
              </p>
            </div>

            <VariantRulesCard rules={rulesDiff} isTiebreak={false} roundLabel={round} />

            <ArenaAbilityPanel
              rules={rules}
              crazyState={position?.crazyState || null}
              playerColor={myColor}
              position={position}
              selectedAbility={selectedAbility}
              onSelectAbility={(ability) => {
                setSelectedAbility(ability);
                setInputMode("ability");
                setAbilityHighlight(ability.casterSquares || []);
              }}
              onHighlight={setAbilityHighlight}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Round / done placeholder (Phase 1 stop) ────────────────

// ── RoundPlay ──────────────────────────────────────────────

/**
 * The actual 1v1 round. Mirrors GameScreen's layout: board on
 * the left, clocks + move list + resign on the right rail.
 *
 * Move sync: each player applies their own move LOCALLY first
 * for instant feedback, then writes the move row to the DB +
 * commits the clock. The opponent's realtime channel sees the
 * INSERT on arena_moves and replays it. The room row's
 * round_state acts as the canonical source of truth (fen +
 * clock + plyCount), so a refresh / reconnect re-paints the
 * exact game state.
 *
 * Round-end paths (any of these advances the room status):
 *   - engine returns ended:true (checkmate / stalemate /
 *     capture-king / first-to-N / race-to-square).
 *   - clock expiry on the to-move side (detected by either
 *     client; first to write wins).
 *   - resign button.
 */
function RoundPlay({ room, setRoom, role, user, roomId }) {
  const navigate = useNavigate();
  const status = room.status;
  const roundLabel = roundLabelFor(status);
  const isTiebreak = status === "tiebreak";

  // Tie-break uses vanilla rules + a 1+0 clock. Rounds 1 / 2
  // resolve their rules from the corresponding rule diff.
  const rulesDiff = isTiebreak
    ? { extends: "vanilla", name: "Tie-break (vanilla)" }
    : (roundLabel === 1 ? room.rules_creator : room.rules_joiner);
  const rulesKey = useMemo(() => {
    try { return JSON.stringify(rulesDiff || { extends: "vanilla" }); }
    catch { return "vanilla"; }
  }, [rulesDiff]);
  const rules = useMemo(() => {
    try { return resolveRules(rulesDiff || { extends: "vanilla" }); }
    catch { return vanillaRules(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesKey]);

  // My color + whose turn it is.
  const myColor = colorFor(role, status);
  const colorPair = colorPairFor(roundLabel === "tiebreak" ? 1 : roundLabel);

  // Board state. The canonical FEN lives in the room's
  // round_state so a late-joiner / rejoin / opponent's move
  // re-renders at the right position. To keep my own moves
  // feeling instant we ALSO keep a local optimistic
  // `localPosition` that wins over the room FEN whenever it's
  // ahead, then snaps back to the room FEN once the DB
  // round-trip lands. Without this, every move waits for
  // appendMove + updateRoom to resolve before the piece
  // visually moves - that's the "kind of slow" the user
  // reported.
  const fenFromRoom = room.round_state?.fen || rules.startingFen || VANILLA_FEN;
  const roomPlyCount = room.round_state?.plyCount || 0;
  const [localPosition, setLocalPosition] = useState(null);
  const [localPly, setLocalPly] = useState(0);

  // When the room catches up (or surpasses) our local
  // optimistic ply, drop the local override.
  useEffect(() => {
    if (localPosition && roomPlyCount >= localPly) {
      setLocalPosition(null);
    }
  }, [roomPlyCount, localPly, localPosition]);

  // Crazy Arena Ship #2: pull crazy_state off the room row so
  // ability charges, cooldowns, and active marks survive
  // reload + realtime sync across both clients. Vanilla games
  // have crazy_state = null which collapses to "no marks, no
  // gating" - the engine treats absence as "abilities are
  // unlimited" which matches Ship #1 behavior.
  const crazyStateFromRoom = room.crazy_state || null;
  const position = useMemo(() => {
    if (localPosition) return localPosition;
    let pos;
    try { pos = Position.fromFen(fenFromRoom); }
    catch { pos = Position.fromFen(VANILLA_FEN); }
    if (crazyStateFromRoom) pos.crazyState = crazyStateFromRoom;
    return pos;
  }, [fenFromRoom, localPosition, crazyStateFromRoom]);

  // Move history for this round. Loaded from arena_moves on
  // mount and kept in sync via realtime + manual appends.
  const [moves, setMoves] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(null); // null = live; number = browsing
  const [highlight, setHighlight] = useState({});
  const [resignError, setResignError] = useState(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [confirmDraw, setConfirmDraw] = useState(false);
  // Crazy Arena Ship #2.5: VariantError surface. In live PvP,
  // a cast that fails to resolve is a serious problem (the
  // variant is malformed in a way the validator missed); we
  // surface a toast and let the user see what happened. The
  // match itself doesn't auto-cancel - that's a Ship #2.5
  // followup if the issue turns out to be common.
  const [variantError, setVariantError] = useState(null);
  useEffect(() => {
    if (!variantError) return undefined;
    const t = setTimeout(() => setVariantError(null), 6000);
    return () => clearTimeout(t);
  }, [variantError]);
  // Hover-highlight from the AbilityPanel (see warmup component
  // for the full rationale).
  const [abilityHighlight, setAbilityHighlight] = useState([]);
  const [inputMode, setInputMode] = useState("move");
  const [selectedAbility, setSelectedAbility] = useState(null);
  // Ship #3 visual overlay (sandboxed iframe). No-op unless the
  // localStorage feature flag is set.
  const visualsMode = useArenaVisualsMode(roomId);
  const compiledVisuals = useCompiledArenaVisuals(visualsMode, rulesDiff);
  // In-flight projectile timeline; see warmup component for
  // full rationale.
  const { projectiles, fireProjectile } = useActiveProjectiles();
  // Lab flag: gates the dev-only debug panel. Non-lab users
  // never see internal sandbox draw errors / stack traces.
  const isLabUser = useLabFlag();
  // Cast flash overlay (see warmup component for full
  // rationale). Auto-clears after 700ms.
  const [castFlash, setCastFlash] = useState(null);
  useEffect(() => {
    if (!castFlash) return undefined;
    const t = setTimeout(() => setCastFlash(null), 700);
    return () => clearTimeout(t);
  }, [castFlash]);
  const confirmTimerRef = useRef(null);
  const drawTimerRef = useRef(null);
  useEffect(() => () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    if (drawTimerRef.current) clearTimeout(drawTimerRef.current);
  }, []);
  // Transient feedback for draw outcomes the offerer wouldn't
  // otherwise notice - same pattern as OnlineGameScreen's
  // offerNotice. Fires when a draw offer is declined or auto-
  // expires. Auto-clears after ~4s.
  const [offerNotice, setOfferNotice] = useState(null);
  const offerNoticeTimerRef = useRef(null);
  const showOfferNotice = useCallback((text) => {
    if (offerNoticeTimerRef.current) clearTimeout(offerNoticeTimerRef.current);
    setOfferNotice(text);
    offerNoticeTimerRef.current = setTimeout(() => setOfferNotice(null), 4000);
  }, []);
  useEffect(() => () => {
    if (offerNoticeTimerRef.current) clearTimeout(offerNoticeTimerRef.current);
  }, []);

  // Initial move-log load + realtime INSERT subscription. The
  // sidebar move list, opponent-move-detection effect, and
  // history scrubber all read from `moves`, so we must keep
  // it live on both sides. Without the realtime subscription
  // ONLY my own moves would appear (queued via setMoves in
  // onUserMove); the opponent's moves would be invisible
  // until the next loadMoves refetch.
  //
  // Merge strategy: dedupe by (round, ply). Realtime INSERTs
  // can race with our optimistic local appends, so we always
  // collapse duplicates by primary key, prefer the version
  // with the richest `san`/`move_from`/`move_to` payload, and
  // re-sort by ply so the move list is monotonic.
  useEffect(() => {
    if (!roomId || !roundLabel) return undefined;
    let cancelled = false;
    const roundKey = roundLabel === "tiebreak" ? 99 : roundLabel;
    (async () => {
      const result = await loadMoves(roomId, roundKey);
      if (cancelled || !result.ok) return;
      setMoves((prev) => mergeMoves(prev, result.moves || []));
    })();
    const unsub = subscribeMoves(roomId, (row) => {
      if (cancelled) return;
      // Filter to the active round; the channel is room-wide.
      const rowRound = Number.isFinite(row?.round) ? row.round : null;
      if (rowRound != null && rowRound !== roundKey) return;
      setMoves((prev) => mergeMoves(prev, [row]));
    });
    return () => {
      cancelled = true;
      try { unsub?.(); } catch { /* ignore */ }
    };
  }, [roomId, roundLabel]);

  // Per-square legal-move enumerator wired to the variant
  // rules. Mirrors the warmup logic. Reads `position` from
  // a ref so the callback identity is stable across realtime
  // pushes - InteractiveBoard memos this through to its
  // useChessboard config, and a fresh identity on every
  // render forces a board re-evaluation that scales with the
  // number of pieces on the board.
  const legalMovesProvider = useCallback((square) => {
    const livePosition = positionRef.current;
    if (livePosition.turn !== myColor) return [];
    return generateLegalMoves(livePosition, rules)
      .filter((m) => m.from === square)
      .filter((m) => inputMode === "ability" ? m.kind === "ability" : m.kind !== "ability")
      .filter((m) => inputMode !== "ability" || !selectedAbility || (
        m.abilityId === selectedAbility.abilityId && m.casterType === selectedAbility.pieceType
      ))
      .map((m) => ({
        to: m.to,
        promotion: m.promotion,
        captured: !!livePosition.pieceAt(m.to) || !!m.enPassant,
        ...(m.kind === "ability"
          ? { kind: "ability", abilityId: m.abilityId, casterType: m.casterType }
          : {}),
      }));
  }, [rules, myColor, inputMode, selectedAbility]);

  // Local clock snapshot for live rendering. Re-renders every
  // 250ms so the seconds visibly count down without burning
  // the main thread on requestAnimationFrame.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (room.round_state?.clock) {
      const id = setInterval(() => setTick((t) => t + 1), 250);
      return () => clearInterval(id);
    }
    return undefined;
  }, [room.round_state?.clock]);

  // Pre-derived clock data (running side, remaining time).
  const clock = room.round_state?.clock;
  const snapshot = useMemo(() => clockSnapshot(clock), [clock, tick]);

  // Local game-status derive. The first client to detect a
  // round-end + write the result wins; the second sees status
  // already advanced via realtime.
  const gameStatus = useMemo(() => checkGameStatus(position, rules), [position, rules]);

  // ── Premove ──
  // When the user drags a piece during the opponent's turn we
  // queue the move as a premove rather than rejecting it. The
  // board displays a blue tint on the queued from/to squares,
  // and a cancel strip appears under the board. As soon as
  // the room ply advances (opponent committed) and it becomes
  // our turn, the queued premove is auto-executed. If the
  // queued move is no longer legal (the piece was captured,
  // the destination is now blocked, etc.) we silently drop it.
  // Cancellation: clicking the board cancels, the Cancel
  // button on the strip cancels, game ending cancels.
  const [premove, setPremove] = useState(null);
  const premoveRef = useRef(null);
  // The premove-execution effect needs to call the latest
  // `onUserMove` without re-creating the effect every render.
  // Stash a ref to the live function and read it inside the
  // effect.
  const onUserMoveRef = useRef(null);

  // Stable refs for the inputs that change frequently (clock
  // ticks every 250ms, room updates on every realtime push).
  // `onUserMove` reads from these inside the closure instead
  // of listing them as deps, so the callback identity stays
  // stable across realtime churn. Without this, the callback
  // is recreated on every tick which forces every consumer
  // (premove effect, InteractiveBoard's onMove memo,
  // legalMovesProvider) to recompute - that's the lag that
  // grows with the round's age.
  const roomRef = useRef(room);
  useEffect(() => { roomRef.current = room; }, [room]);
  const clockRef = useRef(clock);
  useEffect(() => { clockRef.current = clock; }, [clock]);
  const positionRef = useRef(position);
  useEffect(() => { positionRef.current = position; }, [position]);
  const snapshotRef = useRef(snapshot);
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  const gameStatusRef = useRef(gameStatus);
  useEffect(() => { gameStatusRef.current = gameStatus; }, [gameStatus]);

  // Apply a confirmed move locally + write it to the DB. Both
  // sides use this; whoever's turn it is calls it from the
  // board's onMove. The opponent's client sees the room
  // round_state update via realtime and re-derives their
  // position from the new FEN.
  //
  // Optimistic flow: we compute the next position + sound +
  // highlight + move-list entry SYNCHRONOUSLY so the user
  // sees their move land instantly, then fire the DB writes
  // in the background. We don't await them - if they fail
  // the realtime push from the room update will rectify; if
  // the LOCAL apply somehow disagrees with what the DB
  // accepts, the next room update will overwrite localPosition.
  const advanceRoundEndedRef = useRef(false);
  const onUserMove = useCallback((move) => {
    // Read live state from refs so this callback stays stable
    // across realtime / clock-tick churn. Listing position,
    // clock, room.round_state etc. as deps used to recreate
    // the callback identity 4+ times per second - which then
    // re-ran the premove-trigger effect, the InteractiveBoard
    // memo, and the legalMovesProvider memo every time. That
    // amplification is the source of the lag growth.
    const livePosition = positionRef.current;
    const liveSnapshot = snapshotRef.current;
    const liveGameStatus = gameStatusRef.current;
    const liveRoom = roomRef.current;
    const liveClock = clockRef.current;
    if (liveGameStatus.ended) return false;
    // Not my turn? Queue it as a premove instead of rejecting,
    // but only if I'm actually moving one of my own pieces and
    // we're in live mode (history replay is read-only).
    if (livePosition.turn !== myColor) {
      const movingPiece = livePosition.pieceAt(move.from);
      if (!movingPiece || movingPiece.color !== myColor) return false;
      if (liveSnapshot[role]?.expired) return false;
      setPremove({ from: move.from, to: move.to, promotion: move.promotion });
      premoveRef.current = { from: move.from, to: move.to, promotion: move.promotion };
      return false;
    }
    if (liveSnapshot[role]?.expired) return false;
    // Reaching here means it IS my turn; if I had a queued
    // premove, this drag supersedes it (matches Play's
    // behavior of clearing queued state on a real move).
    setPremove(null);
    premoveRef.current = null;
    let next;
    try { next = applyMove(livePosition, move, rules); }
    catch (e) {
      if (e?.name === "VariantError") {
        setVariantError(e.message || "Variant error");
      } else {
        playError();
      }
      return false;
    }

    // Sound + highlight match OnlineGameScreen so the play
    // surface feels identical. Ability casts get a thematic
    // sound dispatched from the ability spec; plain moves use
    // the standard move/capture cue.
    if (move.kind === "ability") {
      const ab = findAbilityInRules(rules, move.casterType, move.abilityId, myColor);
      playAbilityCast(ab);
      setCastFlash({ from: move.from, to: move.to, abilityId: move.abilityId });
      fireProjectile(move.from, move.to, move.abilityId, 900);
    } else {
      playMoveSound({ flags: move.captured ? "c" : "n" });
    }
    setHighlight({
      [move.from]: { backgroundColor: "rgba(255,255,255,0.07)" },
      [move.to]:   { backgroundColor: "rgba(255,255,255,0.11)" },
    });

    const lastHistory = next.history[next.history.length - 1];
    const nextStatus = checkGameStatus(next, rules);
    const newClock = commitClockMove(liveClock, role, { endTurn: !nextStatus.ended });
    const ply = (liveRoom.round_state?.plyCount || 0) + 1;
    const round = roundLabel === "tiebreak" ? 99 : roundLabel;
    const nextRoundState = {
      ...(liveRoom.round_state || {}),
      fen: next.toFen(),
      plyCount: ply,
      clock: newClock,
    };

    // ── Optimistic local apply ──
    setLocalPosition(next);
    setLocalPly(ply);
    setMoves((prev) => mergeMoves(prev, [{
      round,
      ply,
      fen: nextRoundState.fen,
      move_from: move.from,
      move_to: move.to,
      promotion: move.promotion || null,
      san: lastHistory?.san || null,
      ts: new Date().toISOString(),
    }]));

    // ── DB write in the background ──
    // Single atomic RPC: arena_apply_move inserts the move row
    // AND updates round_state in one transaction. If it fails
    // (network blip / row-lock contention), the realtime push
    // from a peer's future move OR a manual refetch will
    // rectify. lastWriteRef chains to the round-end effect so
    // PGN reconstruction sees the final move.
    const writePromise = (async () => {
      try {
        const result = await appendMove({
          roomId,
          round,
          ply,
          fen: nextRoundState.fen,
          move: { ...move, san: lastHistory?.san },
          roundState: nextRoundState,
          // Ship #2: pass crazy_state alongside the FEN so
          // the room row carries the new charges/cooldowns/marks
          // and arena_moves.state_after has a per-ply snapshot
          // for replay scrubbing. appendMove auto-routes to
          // arena_apply_move_v2 when these are present.
          crazyState: next.crazyState || null,
          stateAfter: next.crazyState || null,
        });
        if (result?.ok && result.room && setRoom) {
          setRoom((prev) => ({ ...(prev || {}), ...result.room }));
        } else if (!result?.ok) {
          // eslint-disable-next-line no-console
          console.warn("arena/onUserMove rejected:", result?.error);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("arena/onUserMove writes failed:", e);
      }
    })();
    lastWriteRef.current = writePromise;
    return true;
  }, [myColor, rules, role, roomId, setRoom, roundLabel]);

  // Keep the ref pointing at the latest closure so the
  // premove-trigger effect can call it.
  useEffect(() => { onUserMoveRef.current = onUserMove; }, [onUserMove]);

  // Premove auto-trigger. Runs whenever the position changes
  // (opponent moved → it became my turn). If a premove is
  // queued and still legal in the new position, fire it.
  //
  // Cheap pre-check before the (expensive on variant rules)
  // full move generation: bail out fast when the queued piece
  // is no longer on its `from` square or has changed color.
  // This skips the full `generateLegalMoves` pass on the
  // common case of "the opponent captured my premove piece".
  useEffect(() => {
    if (gameStatus.ended) return;
    const queued = premoveRef.current;
    if (!queued) return;
    if (position.turn !== myColor) return;
    const piece = position.pieceAt(queued.from);
    if (!piece || piece.color !== myColor) {
      setPremove(null);
      premoveRef.current = null;
      return;
    }
    let stillLegal = false;
    try {
      const candidates = generateLegalMoves(position, rules);
      stillLegal = candidates.some(
        (m) => m.from === queued.from
          && m.to === queued.to
          && (queued.promotion ? m.promotion === queued.promotion : !m.promotion),
      );
    } catch { stillLegal = false; }
    if (!stillLegal) {
      setPremove(null);
      premoveRef.current = null;
      return;
    }
    // Small timeout matches Play's ergonomics: gives the
    // opponent's move highlight + sound a beat to land before
    // our piece moves, otherwise the two events feel mashed.
    const id = setTimeout(() => {
      if (!premoveRef.current) return;
      const fn = onUserMoveRef.current;
      if (!fn) return;
      const pm = premoveRef.current;
      setPremove(null);
      premoveRef.current = null;
      // Reuse the standard onUserMove path so the optimistic
      // apply, sound, highlight, and DB writes all happen.
      fn({ from: pm.from, to: pm.to, promotion: pm.promotion });
    }, 80);
    return () => clearTimeout(id);
  }, [position, myColor, rules, gameStatus.ended]);

  // Clear premove when the game ends so the strip + tint
  // don't linger on the post-match position.
  useEffect(() => {
    if (!gameStatus.ended) return;
    if (premoveRef.current) {
      setPremove(null);
      premoveRef.current = null;
    }
  }, [gameStatus.ended]);

  // Most recent in-flight write promise. The round-end effect
  // awaits this before reading the move log so the final move
  // is guaranteed to be persisted in time for PGN building.
  const lastWriteRef = useRef(Promise.resolve());

  // ── Chat: ephemeral broadcast through Supabase Realtime ──
  // Mirrors OnlineGameScreen exactly; messages aren't
  // persisted (closing the tab loses history). Bell sound on
  // incoming, banlist on send via shared moderateChat.
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const chatScrollRef = useRef(null);
  const chatChannelRef = useRef(null);
  useEffect(() => {
    if (!roomId) return undefined;
    const myDisplayName = user?.name || (role === "creator" ? room.creator_name : room.joiner_name) || "Player";
    const myId = user?.id;
    const ch = openChatChannel(roomId, (msg) => {
      if (!msg?.text) return;
      // Drop our own echoes - broadcast.self is already
      // false on the channel but defensive in case it ever
      // changes.
      if (msg.userId && msg.userId === myId) return;
      setChatMessages((prev) => [...prev, msg]);
      playChatNotify();
    });
    chatChannelRef.current = { ch, myId, myDisplayName };
    return () => {
      try { ch.unsubscribe(); } catch { /* ignore */ }
      chatChannelRef.current = null;
    };
  }, [roomId, role, room.creator_name, room.joiner_name, user?.id, user?.name]);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMessages.length]);

  const onSendChat = useCallback(() => {
    const cleaned = moderateChat(chatInput);
    if (!cleaned) {
      setChatInput("");
      return;
    }
    const ctx = chatChannelRef.current;
    if (!ctx) return;
    ctx.ch.send({ userId: ctx.myId, name: ctx.myDisplayName, text: cleaned });
    setChatMessages((prev) => [...prev, { userId: ctx.myId, name: ctx.myDisplayName, text: cleaned, ts: new Date().toISOString() }]);
    setChatInput("");
  }, [chatInput]);

  // Round-end resolver. Runs whenever gameStatus or clock
  // status flips. Whichever client gets here first writes the
  // result + advances status; the second sees status already
  // advanced via realtime and bails.
  useEffect(() => {
    if (advanceRoundEndedRef.current) return;
    // Determine outcome.
    let winnerColor = null;
    let reason = null;
    if (gameStatus.ended) {
      winnerColor = gameStatus.winner;
      reason = gameStatus.reason;
    } else if (snapshot.creator?.expired) {
      winnerColor = colorPair.joiner;
      reason = "creator clock expired";
    } else if (snapshot.joiner?.expired) {
      winnerColor = colorPair.creator;
      reason = "joiner clock expired";
    } else {
      return;
    }
    advanceRoundEndedRef.current = true;
    (async () => {
      // Wait for any in-flight optimistic move write to land
      // so the final move is in arena_moves before we
      // reconstruct PGN below.
      try { await lastWriteRef.current; } catch { /* ignore */ }
      const entry = buildRoundEntry({
        round: roundLabel,
        gameStatus,
        reasonOverride: reason,
        forcedWinnerColor: winnerColor,
        finalFen: position.toFen(),
        plyCount: room.round_state?.plyCount || 0,
        clockSpent: { creator: snapshot.creator?.spentMs, joiner: snapshot.joiner?.spentMs },
      });
      const newMatch = appendRound(room.match_result, entry);
      const nextStatus = nextStatusAfterRound(status, newMatch);
      const finalMatch = nextStatus === "done" ? finalizeMatch(newMatch) : newMatch;
      // Compute the next round_state. For warmup_round_2 we
      // want a clean board ready for the next warmup. For
      // tiebreak we initialize a fresh 1+0 clock + vanilla
      // starting position so the tie-break begins clean. For
      // 'done' we leave the final position visible. Otherwise
      // just pause the existing clock.
      let nextRoundState;
      if (nextStatus === "tiebreak") {
        // Tie-break uses vanilla rules + 1+0 clock. Creator
        // plays Black per the spec; whichever side moves first
        // (white in vanilla) starts the clock.
        const startingPos = Position.fromFen(VANILLA_FEN);
        const tbColors = colorPairFor(1); // tie-break uses round-1 shape
        const firstMover = tbColors.creator === startingPos.turn ? "creator" : "joiner";
        nextRoundState = {
          round: "tiebreak",
          fen: VANILLA_FEN,
          plyCount: 0,
          clock: initTiebreakClock(firstMover),
          startedAt: new Date().toISOString(),
        };
      } else if (nextStatus === "warmup_round_2") {
        // Reset round_state for round 2's warmup. The Warmup
        // component derives its starting fen from the rules
        // again so we just clear the round-1 leftovers.
        nextRoundState = { round: 2 };
      } else {
        nextRoundState = {
          ...(room.round_state || {}),
          clock: pauseClock(room.round_state?.clock),
          fen: position.toFen(),
          endedAt: new Date().toISOString(),
        };
      }
      const result = await advanceRound({
        roomId,
        roundLabel,
        matchResult: finalMatch,
        roundState: nextRoundState,
        nextStatus,
      });
      if (result?.ok && result.room && setRoom) {
        setRoom((prev) => ({ ...(prev || {}), ...result.room }));
      }
      // Only the client whose write was actually applied (i.e.
      // won the row-lock race) records the round to the games
      // table. The losing client's `applied` is false, and we
      // skip recordRoundGame entirely - this prevents the
      // duplicate-rows-per-round bug where both peers wrote.
      if (result?.applied && room.creator_id && room.joiner_id) {
        const creatorInfo = { id: room.creator_id, name: room.creator_name, color: colorPair.creator };
        const joinerInfo  = { id: room.joiner_id,  name: room.joiner_name,  color: colorPair.joiner };
        const pgnLines = (await loadMoves(roomId, roundLabel === "tiebreak" ? 99 : roundLabel)).moves || [];
        const pgn = pgnLines.map((m, i) =>
          (i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${m.san || `${m.move_from}${m.move_to}`}` : (m.san || `${m.move_from}${m.move_to}`))
        ).join(" ");
        recordRoundGame({
          roomId,
          round: entry,
          creator: creatorInfo,
          joiner: joinerInfo,
          pgn,
          rulesDiff,
          timeControl: isTiebreak ? "1+0" : "10+0",
        });
      }
    })();
  }, [gameStatus, snapshot, status, roundLabel, position, room, roomId, setRoom, colorPair, rulesDiff, isTiebreak]);

  // Opponent-move sound + highlight: when a row arrives with
  // a ply we haven't seen, AND it wasn't our own optimistic
  // append, play the sound and highlight the squares. We key
  // off `moves` directly (now synced via subscribeMoves) so
  // we always find the right move row even if it lands
  // before/after the room.round_state update.
  const lastSeenPlyRef = useRef(0);
  useEffect(() => {
    if (!moves || moves.length === 0) return;
    const last = moves[moves.length - 1];
    const ply = last?.ply;
    if (!Number.isFinite(ply) || ply <= lastSeenPlyRef.current) return;
    lastSeenPlyRef.current = ply;
    // Skip the sound when the row corresponds to our own
    // optimistic apply (we already played the sound at the
    // time the user dropped the piece).
    const isOurOptimistic = localPosition && localPly === ply;
    if (isOurOptimistic) return;
    if (last.move_from && last.move_to) {
      setHighlight({
        [last.move_from]: { backgroundColor: "rgba(255,255,255,0.07)" },
        [last.move_to]:   { backgroundColor: "rgba(255,255,255,0.11)" },
      });
    }
    // Ship #2.5: opponent's ability casts get the same thematic
    // sound the caster heard. Look up the ability spec from the
    // rules using the move row's move_kind + ability_id (stored
    // by arena_apply_move_v2). Falls back to the standard move/
    // capture sound for non-ability moves.
    if (last.move_kind === "ability" && last.ability_id) {
      // We don't know the opponent's color directly here, but
      // findAbilityInRules tries both byColor sides.
      const oppColor = myColor === "w" ? "b" : "w";
      // SAN format for ability casts: "Q!fireball→e5". Pull
      // the caster's piece letter so we can look it up.
      const sanFirst = typeof last.san === "string" ? last.san[0] : null;
      const casterType = sanFirst && /[A-Z]/.test(sanFirst) ? sanFirst.toLowerCase() : null;
      const ab = casterType
        ? findAbilityInRules(rules, casterType, last.ability_id, oppColor)
        : null;
      playAbilityCast(ab);
      if (last.move_from && last.move_to) {
        setCastFlash({ from: last.move_from, to: last.move_to, abilityId: last.ability_id });
        fireProjectile(last.move_from, last.move_to, last.ability_id, 900);
      }
    } else {
      const wasCapture = typeof last.san === "string" && last.san.includes("x");
      playMoveSound({ flags: wasCapture ? "c" : "n" });
    }
  }, [moves, localPosition, localPly, rules, myColor]);

  // Round-start ping: play the gentle "game start" sound once
  // per round so the transition from warmup -> round 1, round
  // 1 -> round 2, etc. has an audible cue.
  const roundStartedRef = useRef(null);
  useEffect(() => {
    const key = `${status}:${roundLabel}`;
    if (roundStartedRef.current === key) return;
    if (status === "round_1" || status === "round_2" || status === "tiebreak") {
      roundStartedRef.current = key;
      playGameStart();
    }
  }, [status, roundLabel]);

  // Round-end audio cue: play victory/defeat/draw exactly
  // once when the round resolves. We key on the most recent
  // round entry in match_result so the sound fires after the
  // result is committed.
  const roundEndSoundRef = useRef(null);
  useEffect(() => {
    const rounds = room.match_result?.rounds || [];
    const latest = rounds[rounds.length - 1];
    if (!latest) return;
    const key = `${latest.round}:${latest.endedAt}`;
    if (roundEndSoundRef.current === key) return;
    roundEndSoundRef.current = key;
    if (latest.winner === role) playVictory();
    else if (latest.winner == null) playDraw();
    else playDefeat();
  }, [room.match_result, role]);

  // Low-time alert: my clock dropping under 30s plays the
  // chess.com-style ticking nudge once per round.
  const lowTimeFiredRef = useRef(null);
  useEffect(() => {
    const my = snapshot[role];
    if (!my || my.expired) return;
    const roundKey = `${status}:${roundLabel}`;
    if (lowTimeFiredRef.current === roundKey) return;
    if (my.remainingMs < 30_000 && my.remainingMs > 0) {
      lowTimeFiredRef.current = roundKey;
      playLowTime();
    }
  }, [snapshot, role, status, roundLabel]);

  // Resign action.
  const onResign = useCallback(() => {
    if (!confirmResign) {
      setConfirmResign(true);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmResign(false), 4000);
      return;
    }
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmResign(false);
    advanceRoundEndedRef.current = true;
    (async () => {
      const entry = buildRoundEntry({
        round: roundLabel,
        gameStatus: { ended: true, winner: null, reason: `${role} resigned` },
        reasonOverride: `${role} resigned`,
        forcedWinnerColor: role === "creator" ? colorPair.joiner : colorPair.creator,
        finalFen: position.toFen(),
        plyCount: room.round_state?.plyCount || 0,
      });
      const newMatch = appendRound(room.match_result, entry);
      const nextStatus = nextStatusAfterRound(status, newMatch);
      const finalMatch = nextStatus === "done" ? finalizeMatch(newMatch) : newMatch;
      const round_state = {
        ...(room.round_state || {}),
        clock: pauseClock(room.round_state?.clock),
        endedAt: new Date().toISOString(),
      };
      const result = await advanceRound({
        roomId,
        roundLabel,
        matchResult: finalMatch,
        roundState: round_state,
        nextStatus,
      });
      if (!result?.ok) {
        setResignError(result?.error || "Couldn't resign.");
        advanceRoundEndedRef.current = false;
        return;
      }
      if (result?.room && setRoom) {
        setRoom((prev) => ({ ...(prev || {}), ...result.room }));
      }
    })();
  }, [confirmResign, role, roundLabel, status, position, room, roomId, setRoom, colorPair]);

  // Draw offer flow. State is synced through round_state.drawOffer:
  //   { from: 'creator'|'joiner', round: <roundLabel>, ts, offerPly }
  // Either side can offer; the other side sees the incoming
  // banner and can Accept (round ends as a draw) or Decline
  // (offer cleared). Offers auto-expire 2 plies after they're
  // made (one full move pair) so a player can't camp the offer
  // until they're losing and only then accept it.
  const MAX_DRAW_OFFERS = 3;
  const DRAW_OFFER_TTL_PLIES = 2;
  const drawOffersBySide = room.round_state?.drawOffersUsed || {};
  const myDrawOffersUsed = drawOffersBySide[role] || 0;
  const drawOffer = room.round_state?.drawOffer;
  const currentPly = room.round_state?.plyCount || 0;
  const drawOfferActive = drawOffer && drawOffer.from && drawOffer.round === roundLabel;
  const drawOfferPly = drawOfferActive && Number.isFinite(drawOffer.offerPly) ? drawOffer.offerPly : null;
  const drawOfferIsExpired =
    drawOfferActive && drawOfferPly != null && currentPly >= drawOfferPly + DRAW_OFFER_TTL_PLIES;
  const drawOfferPliesLeft =
    drawOfferActive && drawOfferPly != null
      ? Math.max(0, drawOfferPly + DRAW_OFFER_TTL_PLIES - currentPly)
      : null;
  const incomingDraw =
    drawOfferActive && drawOffer.from !== role && !drawOfferIsExpired;
  const myPendingDrawOffer =
    drawOfferActive && drawOffer.from === role && !drawOfferIsExpired;

  // Audible cue when a draw offer arrives, exactly like Play.
  const lastDrawOfferKeyRef = useRef(null);
  useEffect(() => {
    if (!incomingDraw) {
      lastDrawOfferKeyRef.current = null;
      return;
    }
    const key = `${drawOffer.from}:${drawOffer.round}:${drawOffer.ts || ""}`;
    if (lastDrawOfferKeyRef.current === key) return;
    lastDrawOfferKeyRef.current = key;
    playOfferNotify();
  }, [incomingDraw, drawOffer]);

  const onDrawOffer = useCallback(async () => {
    if (gameStatus.ended) return;
    if (myDrawOffersUsed >= MAX_DRAW_OFFERS) return;
    if (myPendingDrawOffer) return;       // already pending
    if (incomingDraw) return;             // opponent already has an offer out - they decide first
    if (!confirmDraw) {
      setConfirmDraw(true);
      if (drawTimerRef.current) clearTimeout(drawTimerRef.current);
      drawTimerRef.current = setTimeout(() => setConfirmDraw(false), 4000);
      return;
    }
    if (drawTimerRef.current) clearTimeout(drawTimerRef.current);
    setConfirmDraw(false);
    const offerPly = room.round_state?.plyCount || 0;
    const round_state = {
      ...(room.round_state || {}),
      drawOffer: {
        from: role,
        round: roundLabel,
        ts: new Date().toISOString(),
        offerPly,
      },
      drawOffersUsed: { ...drawOffersBySide, [role]: myDrawOffersUsed + 1 },
    };
    const result = await updateRoom(roomId, { round_state });
    if (result?.ok && result.room && setRoom) {
      setRoom((prev) => ({ ...(prev || {}), ...result.room }));
    }
  }, [gameStatus.ended, myDrawOffersUsed, myPendingDrawOffer, incomingDraw, confirmDraw, room.round_state, role, roundLabel, drawOffersBySide, roomId, setRoom]);

  const onDrawDecline = useCallback(async () => {
    if (!incomingDraw) return;
    const round_state = {
      ...(room.round_state || {}),
      drawOffer: null,
      // Mark a one-shot decline ack so the offerer's client can
      // surface a "your draw was declined" toast even though the
      // offer record itself is now null. The offerer reads this
      // by ts + from and clears it after acknowledging.
      drawOfferDeclined: {
        from: role,
        round: roundLabel,
        ts: new Date().toISOString(),
        offeredBy: drawOffer?.from || null,
      },
    };
    const result = await updateRoom(roomId, { round_state });
    if (result?.ok && result.room && setRoom) {
      setRoom((prev) => ({ ...(prev || {}), ...result.room }));
    }
  }, [incomingDraw, room.round_state, roomId, setRoom, role, roundLabel, drawOffer]);

  const onDrawAccept = useCallback(async () => {
    if (!incomingDraw) return;
    // Don't honor a stale offer - if the TTL has elapsed locally,
    // treat the click as a no-op. The expiry effect will clear
    // the offer record from the server side as well.
    if (drawOfferIsExpired) return;
    if (advanceRoundEndedRef.current) return;
    advanceRoundEndedRef.current = true;
    const entry = buildRoundEntry({
      round: roundLabel,
      gameStatus: { ended: true, winner: null, reason: "draw by agreement" },
      reasonOverride: "draw by agreement",
      forcedWinnerColor: null,
      finalFen: position.toFen(),
      plyCount: room.round_state?.plyCount || 0,
    });
    const newMatch = appendRound(room.match_result, entry);
    const nextStatus = nextStatusAfterRound(status, newMatch);
    const finalMatch = nextStatus === "done" ? finalizeMatch(newMatch) : newMatch;
    const round_state = {
      ...(room.round_state || {}),
      drawOffer: null,
      clock: pauseClock(room.round_state?.clock),
      endedAt: new Date().toISOString(),
    };
    const result = await advanceRound({
      roomId,
      roundLabel,
      matchResult: finalMatch,
      roundState: round_state,
      nextStatus,
    });
    if (!result?.ok) {
      advanceRoundEndedRef.current = false;
      return;
    }
    if (result?.room && setRoom) {
      setRoom((prev) => ({ ...(prev || {}), ...result.room }));
    }
  }, [incomingDraw, drawOfferIsExpired, role, roundLabel, status, position, room, roomId, setRoom]);

  // Auto-expire a pending draw offer once the configured TTL has
  // elapsed. Whichever side notices first writes the clear; the
  // other side picks it up via the room sync. Show the offerer a
  // toast so they know their unanswered offer lapsed.
  const announcedDrawEndedRef = useRef(null);
  useEffect(() => {
    if (!drawOfferActive || !drawOfferIsExpired) {
      if (!drawOfferActive) announcedDrawEndedRef.current = null;
      return;
    }
    if (gameStatus.ended) return;
    const key = `${drawOffer.from}:${drawOffer.round}:${drawOffer.ts || drawOfferPly}:expired`;
    if (announcedDrawEndedRef.current === key) return;
    announcedDrawEndedRef.current = key;
    const wasMine = drawOffer.from === role;
    const round_state = {
      ...(room.round_state || {}),
      drawOffer: null,
    };
    updateRoom(roomId, { round_state }).then((result) => {
      if (result?.ok && result.room && setRoom) {
        setRoom((prev) => ({ ...(prev || {}), ...result.room }));
      }
    });
    if (wasMine) {
      showOfferNotice("Your draw offer expired.");
    }
  }, [drawOfferActive, drawOfferIsExpired, drawOffer, drawOfferPly, role, room.round_state, roomId, setRoom, gameStatus.ended, showOfferNotice]);

  // Surface a "draw was declined" toast to the offerer.
  // `drawOfferDeclined` is a one-shot ack the decliner writes into
  // round_state; we read it once and clear it so it doesn't loop.
  const announcedDrawDeclineRef = useRef(null);
  useEffect(() => {
    const ack = room.round_state?.drawOfferDeclined;
    if (!ack || !ack.ts) return;
    if (ack.round !== roundLabel) return;
    if (ack.offeredBy !== role) return;
    if (announcedDrawDeclineRef.current === ack.ts) return;
    announcedDrawDeclineRef.current = ack.ts;
    showOfferNotice("Opponent declined your draw offer.");
    const round_state = {
      ...(room.round_state || {}),
      drawOfferDeclined: null,
    };
    updateRoom(roomId, { round_state }).then((result) => {
      if (result?.ok && result.room && setRoom) {
        setRoom((prev) => ({ ...(prev || {}), ...result.room }));
      }
    });
  }, [room.round_state, roundLabel, role, roomId, setRoom, showOfferNotice]);

  // History replay. When user clicks a move in the move list,
  // we render that historical FEN read-only; click "Live" to
  // return. In live mode the FEN comes from `position` which
  // already prefers `localPosition` (optimistic apply) over
  // `room.round_state.fen`. Without this, the InteractiveBoard
  // would lag the optimistic update by a full DB round-trip
  // even though our turn/legality logic already advanced -
  // that's the source of the "sometimes black can't move" bug
  // (board says white-to-move FEN, position.turn says black).
  const displayFen = useMemo(() => {
    if (historyIndex != null && historyIndex < moves.length - 1) {
      return moves[historyIndex]?.fen || position.toFen();
    }
    return position.toFen();
  }, [historyIndex, moves, position]);
  const liveMode = historyIndex == null;
  const orientation = myColor === "b" ? "black" : "white";
  const myTurn = position.turn === myColor && !gameStatus.ended;

  // Captures math derived from the FEN, identical to the Online
  // play surface so the +material indicator and captured-piece
  // strip read the same. For variants that add or duplicate
  // pieces this becomes approximate, but never wrong-direction.
  const captured = useMemo(() => getCaptured(displayFen), [displayFen]);
  const advForMe = myColor === "w" ? captured.advantage : -captured.advantage;
  const myCapturedPieces = myColor === "w" ? captured.capturedByWhite : captured.capturedByBlack;
  const oppCapturedPieces = myColor === "w" ? captured.capturedByBlack : captured.capturedByWhite;

  // Identity / clock breakdown for the player bars. PlayerBar
  // expects ms remaining + an `active` flag, mirroring what
  // OnlineGameScreen passes; we adapt the arena snapshot shape.
  const oppRoleId = role === "creator" ? "joiner" : "creator";
  const myName = role === "creator" ? room.creator_name : room.joiner_name;
  const oppName = role === "creator" ? room.joiner_name : room.creator_name;
  const myColorLabel = colorPair[role];
  const oppColorLabel = colorPair[oppRoleId];
  const myTime = snapshot[role]?.remainingMs ?? 0;
  const oppTime = snapshot[oppRoleId]?.remainingMs ?? 0;
  const myActive = snapshot.running === role;
  const oppActive = snapshot.running === oppRoleId;

  // Header status pill - matches OnlineGameScreen's chrome:
  // "Your turn" / "Opponent's turn" / "Game over" with the
  // round label tucked alongside.
  const turnLabel = gameStatus.ended
    ? "Round over"
    : myTurn ? "Your move" : `${oppName || "opponent"} to move`;
  const tcLabel = isTiebreak ? "1+0" : "10+0";

  return (
    <div className="min-h-[calc(100dvh-4rem)] bg-surface flex flex-col">
      <div className="w-full bg-surface-lowest/80 backdrop-blur-xl border-b border-white/[0.04] px-4 sm:px-6 h-12 flex items-center justify-between shrink-0 z-10">
        <button onClick={() => navigate("/arena")} className="flex items-center gap-2 text-on-surface-variant/50 hover:text-primary transition-colors py-2 pr-3">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
          <span className="font-headline text-lg font-extrabold tracking-tighter text-primary">oChess</span>
        </button>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/30">
            {isTiebreak ? "Tie-break" : `Round ${roundLabel}`} &middot; vs {oppName || "opponent"} &middot; {tcLabel}
          </span>
          <span className={`text-[10px] font-headline font-bold uppercase tracking-wide px-2 py-0.5 ${
            gameStatus.ended
              ? "bg-surface-high text-on-surface-variant/50"
              : myTurn ? "bg-primary/10 text-primary" : "bg-surface-high text-on-surface-variant/40"
          }`}>{turnLabel}</span>
        </div>
      </div>

      <div className="flex-1 flex">
        <div className="flex-1 min-w-0 flex flex-col xl:flex-row px-4 sm:px-6 md:px-10 xl:px-6 py-3 sm:py-4 gap-4 xl:gap-6 w-full mx-auto max-w-[1400px] xl:max-w-[1500px] 2xl:max-w-[1600px]">
          <div className="flex-1 flex flex-col items-center xl:items-start max-w-[760px] xl:max-w-[920px] 2xl:max-w-[1040px]">
            <PlayerBar
              name={oppName || "Opponent"}
              pieceColor={oppColorLabel}
              captured={oppCapturedPieces}
              advantage={advForMe < 0 ? Math.abs(advForMe) : 0}
              time={oppTime}
              active={oppActive && !gameStatus.ended}
            />
            <ArenaInputModeToggle
              mode={inputMode}
              onChange={(mode) => {
                setInputMode(mode);
                if (mode === "move") setSelectedAbility(null);
              }}
              disabled={!liveMode || gameStatus.ended}
            />
            <CastingBanner
              selectedAbility={inputMode === "ability" ? selectedAbility : null}
              onCancel={() => {
                setSelectedAbility(null);
                setInputMode("move");
              }}
            />
            <div className="w-full mx-auto relative" style={{ maxWidth: "min(100%, calc(100dvh - 11rem))" }}>
              <InteractiveBoard
                fen={displayFen}
                onMove={onUserMove}
                orientation={orientation}
                playerColor={myColor}
                // Live + not-ended: keep the board interactive
                // so the user can drag their own pieces during
                // the opponent's turn to queue a premove.
                // InteractiveBoard's drop handler funnels
                // off-turn drags back to onUserMove which
                // queues them.
                interactive={liveMode && !gameStatus.ended && (inputMode !== "ability" || myTurn)}
                dragEnabled={inputMode !== "ability"}
                selectionKey={inputMode}
                highlightSquares={mergeHighlight(highlight, abilityHighlight, castFlash)}
                legalMovesProvider={legalMovesProvider}
                premoveSquares={premove}
                onBoardClick={() => {
                  // Tap-to-cancel a queued premove.
                  if (premoveRef.current) {
                    setPremove(null);
                    premoveRef.current = null;
                  }
                }}
              />
              {/* Ship #3 visual overlay (sandboxed iframe). */}
              <ArenaVisualOverlay
                compiledDraws={compiledVisuals}
                seed={`${roomId}:${roundLabel}`}
                position={position}
                orientation={orientation}
                projectiles={projectiles}
                lastCast={castFlash}
                disabled={visualsMode === "off"}
                onDrawError={(err) => {
                  pushVisualError(roomId, err);
                  recordVisualError(err, roomId, rules?.name);
                }}
                onSlotDisabled={(slot, reason) => {
                  pushVisualError(roomId, { slot, message: `slot disabled: ${reason}`, ply: position?.history?.length });
                }}
              />
              <ArenaVisualDebugPanel
                roomId={roomId}
                isLabUser={isLabUser}
                onDisableVisuals={() => {
                  try {
                    localStorage.setItem(`arena_visuals_off:${roomId}`, "1");
                    window.dispatchEvent(new Event("storage"));
                  } catch { /* ignore */ }
                }}
              />
              <CrazyStateBadges position={position} orientation={orientation} />
              <VariantErrorToast
                message={variantError}
                onDismiss={() => setVariantError(null)}
              />
            </div>
            {premove && !gameStatus.ended && (
              <div className="w-full mt-1 flex items-center justify-between px-2 py-1.5 bg-blue-900/20 border border-blue-500/15">
                <span className="text-[10px] font-headline font-bold uppercase tracking-wide text-blue-400/70">
                  Premove: {premove.from}{premove.to}
                </span>
                <button onClick={() => { setPremove(null); premoveRef.current = null; }}
                  className="text-[10px] text-blue-400/50 hover:text-blue-300 transition-colors">
                  Cancel
                </button>
              </div>
            )}
            {!liveMode && (
              <button onClick={() => setHistoryIndex(null)}
                className="w-full mt-1 py-2 bg-blue-900/30 border border-blue-500/20 font-headline text-xs font-bold uppercase tracking-wide text-blue-400/80 hover:bg-blue-900/50 transition-colors active:scale-[0.97]">
                Back to live position
              </button>
            )}
            <PlayerBar
              name={myName || user.name || "you"}
              pieceColor={myColorLabel}
              captured={myCapturedPieces}
              advantage={advForMe > 0 ? advForMe : 0}
              time={myTime}
              active={myActive && !gameStatus.ended}
              isPlayer
            />
          </div>

          <div className="w-full xl:w-[340px] shrink-0 flex flex-col gap-3">
            {offerNotice && (
              <div
                role="status"
                aria-live="polite"
                className="anim-fade-up px-3 py-2 bg-surface-low border border-on-surface-variant/20 text-[11px] text-on-surface-variant/85 text-center"
              >
                {offerNotice}
              </div>
            )}
            <ArenaAbilityPanel
              rules={rules}
              crazyState={position?.crazyState || null}
              playerColor={myColor}
              position={position}
              selectedAbility={selectedAbility}
              onSelectAbility={(ability) => {
                setSelectedAbility(ability);
                setInputMode("ability");
                setAbilityHighlight(ability.casterSquares || []);
              }}
              onHighlight={setAbilityHighlight}
            />
            {!gameStatus.ended && (
              <div className="flex gap-2 shrink-0 flex-wrap">
                <button onClick={onDrawOffer}
                  disabled={myDrawOffersUsed >= MAX_DRAW_OFFERS || !!myPendingDrawOffer || !!incomingDraw}
                  className={`py-2.5 px-3 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${
                    myDrawOffersUsed >= MAX_DRAW_OFFERS ? "bg-surface-low/50 border border-white/[0.02] text-on-surface-variant/15"
                    : myPendingDrawOffer ? "bg-amber-500/10 border border-amber-500/15 text-amber-400/60"
                    : confirmDraw ? "bg-amber-500/20 text-amber-400 border border-amber-500/20"
                    : "bg-surface-low border border-white/[0.04] text-on-surface-variant/35 hover:text-amber-400 hover:border-amber-500/15"
                  }`}>
                  {myDrawOffersUsed >= MAX_DRAW_OFFERS
                    ? "No draws left"
                    : myPendingDrawOffer
                      ? `Draw pending\u2026${drawOfferPliesLeft != null ? ` (${drawOfferPliesLeft})` : ""}`
                      : confirmDraw
                        ? "Tap to offer"
                        : `Draw${myDrawOffersUsed > 0 ? ` (${MAX_DRAW_OFFERS - myDrawOffersUsed})` : ""}`}
                </button>
                <button onClick={onResign}
                  className={`flex-1 py-2.5 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${
                    confirmResign
                      ? "bg-error/20 text-error border border-error/20"
                      : "bg-surface-low border border-white/[0.04] text-on-surface-variant/35 hover:text-error hover:border-error/15"
                  }`}>
                  {confirmResign ? "Tap to confirm" : "Resign"}
                </button>
                <button onClick={() => navigate("/arena")} className="py-2.5 px-3 bg-surface-low border border-white/[0.04] font-headline text-xs font-bold uppercase tracking-wide text-on-surface-variant/35 hover:text-primary transition-colors active:scale-[0.96]">Menu</button>
              </div>
            )}
            {resignError && (
              <p className="text-[11px] text-error">{resignError}</p>
            )}

            {incomingDraw && (
              <div className="bg-primary/10 border border-primary/20 p-3">
                <span className="text-[12px] text-primary font-bold block mb-2">Opponent offers a draw</span>
                <div className="flex gap-2">
                  <button onClick={onDrawAccept} className="flex-1 py-2 bg-primary text-on-primary font-headline text-[10px] font-bold uppercase">Accept</button>
                  <button onClick={onDrawDecline} className="flex-1 py-2 bg-surface-low text-on-surface-variant/50 font-headline text-[10px] font-bold uppercase">Decline</button>
                </div>
              </div>
            )}

            <VariantRulesCard rules={rulesDiff} isTiebreak={isTiebreak} roundLabel={roundLabel} />

            <ChatPanel
              messages={chatMessages}
              input={chatInput}
              onInputChange={setChatInput}
              onSend={onSendChat}
              myUserId={user?.id}
              myDisplayName={user?.name || (role === "creator" ? room.creator_name : room.joiner_name) || "you"}
              scrollRef={chatScrollRef}
            />

            <MoveList
              moves={moves}
              activeIndex={historyIndex}
              onJump={setHistoryIndex}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── VariantRulesCard ──────────────────────────────────────
//
// Compact "what's different this round" card that lives in
// the round-play sidebar so players can glance at the variant
// rules without leaving the board. The full rule preview
// already exists (RulePreview / RuleSummary); this is a
// trimmed always-visible version that shows up to 4 changes
// by default and reveals the rest on click.
function VariantRulesCard({ rules, isTiebreak, roundLabel }) {
  const [expanded, setExpanded] = useState(false);
  const resolved = useMemo(() => {
    try { return resolveRules(rules || { extends: "vanilla" }); }
    catch { return null; }
  }, [rules]);
  const description = useMemo(
    () => resolved ? describeRules(resolved) : null,
    [resolved],
  );
  if (!description) return null;

  // Tie-break is always vanilla, so there's nothing to surface.
  // Show a one-line confirmation instead.
  if (isTiebreak) {
    return (
      <div className="bg-surface-container border border-white/[0.04] p-3 shrink-0">
        <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40 mb-1">
          Tie-break rules
        </h3>
        <p className="text-[11px] text-on-surface-variant/55 leading-snug">
          Standard chess. 1 minute on the clock. First to win takes the match.
        </p>
      </div>
    );
  }

  const changes = description.changes || [];
  const visibleCount = expanded ? changes.length : Math.min(4, changes.length);
  const visibleChanges = changes.slice(0, visibleCount);

  return (
    <div className="bg-surface-container border border-white/[0.04] p-3 shrink-0">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">
          Round {roundLabel} rules
        </h3>
        {changes.length > 4 && (
          <button onClick={() => setExpanded((e) => !e)}
            className="text-[10px] uppercase tracking-widest text-primary/70 hover:text-primary transition-colors">
            {expanded ? "Less" : `+${changes.length - 4} more`}
          </button>
        )}
      </div>
      <span className="font-headline text-[12px] font-bold text-primary block leading-tight">
        {description.name || "Custom rules"}
      </span>
      {description.description && (
        <p className="text-[11px] text-on-surface-variant/55 leading-snug mt-1">
          {description.description}
        </p>
      )}
      {visibleChanges.length > 0 && (
        <ul className="text-[11px] text-on-surface-variant/65 leading-snug space-y-0.5 mt-2 pt-2 border-t border-white/[0.04]">
          {visibleChanges.map((c, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-primary/60 shrink-0">&middot;</span>
              <span>{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Merge an incoming list of move rows into the current move
 * state, deduping by (round, ply). Used by the
 * RoundPlay/Spectator components to reconcile realtime
 * arena_moves INSERTs with optimistic local appends and
 * loadMoves refetches.
 *
 * The move with the richer payload wins on conflict (we
 * prefer rows that already have SAN, fen, move_from, move_to
 * stamped over a partial optimistic stub). Result is sorted
 * by (round, ply) ascending so the move-list rendering can
 * iterate without resorting.
 *
 * Pure function - exported (lowercase) so tests can exercise
 * it without importing the whole component.
 */
function mergeMoves(prev, incoming) {
  const byKey = new Map();
  const richness = (m) => (
    (m?.san ? 4 : 0)
    + (m?.fen ? 2 : 0)
    + (m?.move_from && m?.move_to ? 1 : 0)
  );
  const collect = (rows) => {
    for (const r of rows || []) {
      if (!r || r.ply == null) continue;
      const key = `${r.round}:${r.ply}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, r);
      } else if (richness(r) > richness(existing)) {
        byKey.set(key, r);
      }
    }
  };
  collect(prev);
  collect(incoming);
  const out = Array.from(byKey.values());
  out.sort((a, b) => {
    if (a.round !== b.round) return (a.round ?? 0) - (b.round ?? 0);
    return (a.ply ?? 0) - (b.ply ?? 0);
  });
  return out;
}

// ── Sub-components: move list, chat ────────────────────────
//
// Clocks now live inline in PlayerBar so the arena play
// surface matches the regular online game UI. The dedicated
// ClockPanel + ClockRow components were removed - their job
// is fully covered by PlayerBar's embedded ClockDisplay.

/**
 * Tiny ephemeral chat surface that mirrors the one in
 * OnlineGameScreen. Messages live in component state only -
 * closing the tab loses history. Send-on-Enter, 200-char cap
 * via moderateChat in the parent, banned words drop the
 * message silently.
 */
function ChatPanel({ messages, input, onInputChange, onSend, myUserId, myDisplayName, scrollRef }) {
  return (
    <div className="bg-surface-container border border-white/[0.04] shrink-0">
      <div className="p-2 border-b border-white/[0.03]">
        <h2 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">Chat</h2>
      </div>
      <div ref={scrollRef} className="max-h-[140px] overflow-y-auto p-2.5 space-y-1.5">
        {messages.length === 0 && <p className="text-[11px] text-on-surface-variant/20 italic">Say hello...</p>}
        {messages.map((msg, i) => {
          const isMe = msg.userId === myUserId;
          return (
            <p key={i} className={`text-[11px] leading-relaxed break-words ${isMe ? "text-primary/70" : "text-on-surface-variant/60"}`}>
              <span className="font-bold text-[10px]">{isMe ? myDisplayName : (msg.name || "Opponent")}: </span>
              {msg.text}
            </p>
          );
        })}
      </div>
      <div className="flex border-t border-white/[0.03]">
        <input
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && input.trim()) onSend(); }}
          placeholder="Type a message..."
          maxLength={200}
          className="flex-1 bg-transparent px-2.5 py-2 text-[11px] text-on-surface placeholder:text-on-surface-variant/20 outline-none"
        />
        <button onClick={onSend} disabled={!input.trim()}
          className="px-3 text-[10px] font-bold text-primary/50 hover:text-primary transition-colors disabled:opacity-30">
          Send
        </button>
      </div>
    </div>
  );
}

const MoveList = memo(function MoveList({ moves, activeIndex, onJump }) {
  // Pair the moves once per render. Extracted into a memo
  // outside the JSX so the row keys stay stable per move
  // identity rather than per row index - avoids React
  // tearing down + remounting buttons on every append.
  const pairs = useMemo(() => {
    if (!moves || moves.length === 0) return [];
    const out = [];
    for (let i = 0; i < moves.length; i += 2) {
      const w = moves[i];
      const b = moves[i + 1];
      const num = Math.floor(i / 2) + 1;
      out.push({
        num,
        wIdx: i,
        bIdx: i + 1,
        wSan: w?.san || (w ? `${w.move_from}${w.move_to}` : ""),
        bSan: b?.san || (b ? `${b.move_from}${b.move_to}` : ""),
        // Stable key: the (round, ply) of the white move - never
        // changes as more moves are appended.
        key: w ? `${w.round}:${w.ply}` : `idx:${i}`,
      });
    }
    return out;
  }, [moves]);

  // Auto-scroll the move list to the bottom when new moves
  // arrive so the latest move stays visible without the
  // user having to scroll. Only fires on length change to
  // avoid clobbering manual scroll while browsing history.
  const scrollRef = useRef(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [moves?.length]);

  if (!moves || moves.length === 0) {
    return (
      <div className="p-4 bg-surface-low border border-white/[0.04]">
        <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40 mb-2">
          Moves
        </h3>
        <p className="text-[11px] text-on-surface-variant/40">No moves yet.</p>
      </div>
    );
  }
  const lastIdx = moves.length - 1;
  return (
    <div className="p-4 bg-surface-low border border-white/[0.04]">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">
          Moves
        </h3>
        <span className="text-[10px] text-on-surface-variant/20 tabular-nums">{moves.length}</span>
      </div>
      <div ref={scrollRef} className="max-h-[320px] overflow-y-auto pr-1">
        <div className="grid grid-cols-[auto_1fr_1fr] gap-x-2 gap-y-0.5">
          {pairs.map((p) => (
            <div key={p.key} className="contents">
              <span className="text-[11px] text-on-surface-variant/35 tabular-nums text-right pr-1">{p.num}.</span>
              <button
                onClick={() => onJump(p.wIdx === lastIdx ? null : p.wIdx)}
                className={`text-left font-mono text-[12px] px-1 py-0.5 hover:bg-surface-high transition-colors ${
                  activeIndex === p.wIdx ? "bg-primary/15 text-primary" : "text-on-surface-variant/75"
                }`}>
                {p.wSan}
              </button>
              {p.bSan ? (
                <button
                  onClick={() => onJump(p.bIdx === lastIdx ? null : p.bIdx)}
                  className={`text-left font-mono text-[12px] px-1 py-0.5 hover:bg-surface-high transition-colors ${
                    activeIndex === p.bIdx ? "bg-primary/15 text-primary" : "text-on-surface-variant/75"
                  }`}>
                  {p.bSan}
                </button>
              ) : <span />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

// ── Spectator ──────────────────────────────────────────────

/**
 * Read-only viewer for users who land on a /arena/<roomId>
 * link after both seats are filled. Renders the current board
 * + clocks but disables every interactive affordance: no
 * legal-move highlights, no drag, no resign, no commit. The
 * realtime subscription is still active so the board ticks
 * forward as the players move.
 *
 * No spectator chat / cursor / arrows yet - if those become
 * useful we'll add them in a follow-up. Keeping this dumb so
 * the privacy + perf story stays simple.
 */
function SpectatorView({ room }) {
  const status = room.status;
  const isLobby = status === "waiting_for_joiner" || status === "prompting";
  const isWarmup = status === "warmup_round_1" || status === "warmup_round_2";
  const isRound = status === "round_1" || status === "round_2" || status === "tiebreak";
  const isDone = status === "done";

  // Lobby / warmup: just show what's happening. No board.
  if (isLobby || isWarmup) {
    return (
      <div className="anim-fade-up p-5 bg-surface-low border border-white/[0.04] space-y-3">
        <h2 className="font-headline text-base font-bold text-primary">
          {isWarmup ? "Players are warming up" : "Lobby in progress"}
        </h2>
        <p className="text-[12px] text-on-surface-variant/65 leading-relaxed">
          {isWarmup
            ? "Both players are getting a feel for the variant against an AI. The 1v1 starts when they're both ready."
            : "The two players are designing the rules for this match."}
        </p>
        <p className="text-[11px] text-on-surface-variant/40">
          Spectator mode &middot; {room.creator_name || "Host"} vs {room.joiner_name || "Opponent"}
        </p>
      </div>
    );
  }

  if (isDone) {
    // Show the final result without the play-again CTA.
    const result = room.match_result;
    const winnerRole = result?.winner;
    const winnerName = winnerRole === "creator" ? room.creator_name : winnerRole === "joiner" ? room.joiner_name : null;
    return (
      <div className="anim-fade-up p-5 bg-surface-low border border-primary/20 space-y-3">
        <h2 className="font-headline text-base font-bold text-primary">Match complete</h2>
        <p className="text-[13px] text-on-surface-variant/65">
          {winnerName ? `${winnerName} won.` : "The match was drawn."}
        </p>
      </div>
    );
  }

  if (!isRound) return null;

  // Round play - read-only board.
  const roundLabel = roundLabelFor(status);
  const isTiebreak = status === "tiebreak";
  const rulesDiff = isTiebreak
    ? { extends: "vanilla" }
    : (roundLabel === 1 ? room.rules_creator : room.rules_joiner);
  let rules;
  try { rules = resolveRules(rulesDiff || { extends: "vanilla" }); }
  catch { rules = vanillaRules(); }
  const fen = room.round_state?.fen || rules.startingFen || VANILLA_FEN;
  const clock = room.round_state?.clock;
  const colorPair = colorPairFor(roundLabel === "tiebreak" ? 1 : roundLabel);

  return (
    <SpectatorRound
      room={room}
      rules={rules}
      rulesDiff={rulesDiff}
      fen={fen}
      clock={clock}
      colorPair={colorPair}
      isTiebreak={isTiebreak}
      roundLabel={roundLabel}
    />
  );
}

function SpectatorRound({ room, rulesDiff, fen, clock, colorPair, isTiebreak, roundLabel }) {
  // Local tick to drive the live clock countdown without
  // re-rendering the whole parent.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!clock) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [clock]);
  const snapshot = useMemo(() => clockSnapshot(clock), [clock, tick]);
  const navigate = useNavigate();

  // Captures math from FEN matches the live game surface so
  // both player bars get accurate +material indicators.
  const captured = useMemo(() => getCaptured(fen), [fen]);
  const whiteCaptured = captured.capturedByWhite;
  const blackCaptured = captured.capturedByBlack;

  const tcLabel = isTiebreak ? "1+0" : "10+0";
  const whiteRole = colorPair.creator === "w" ? "creator" : "joiner";
  const blackRole = whiteRole === "creator" ? "joiner" : "creator";
  const whiteName = whiteRole === "creator" ? room.creator_name : room.joiner_name;
  const blackName = blackRole === "creator" ? room.creator_name : room.joiner_name;

  // Spectators see the board from White's POV by default.
  return (
    <div className="min-h-[calc(100dvh-4rem)] bg-surface flex flex-col">
      <div className="w-full bg-surface-lowest/80 backdrop-blur-xl border-b border-white/[0.04] px-4 sm:px-6 h-12 flex items-center justify-between shrink-0 z-10">
        <button onClick={() => navigate("/arena")} className="flex items-center gap-2 text-on-surface-variant/50 hover:text-primary transition-colors py-2 pr-3">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
          <span className="font-headline text-lg font-extrabold tracking-tighter text-primary">oChess</span>
        </button>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/30">
            Spectating &middot; {isTiebreak ? "Tie-break" : `Round ${roundLabel}`} &middot; {tcLabel}
          </span>
        </div>
      </div>

      <div className="flex-1 flex">
        <div className="flex-1 min-w-0 flex flex-col xl:flex-row px-4 sm:px-6 md:px-10 xl:px-6 py-3 sm:py-4 gap-4 xl:gap-6 w-full mx-auto max-w-[1400px] xl:max-w-[1500px] 2xl:max-w-[1600px]">
            <div className="flex-1 flex flex-col items-center xl:items-start max-w-[760px] xl:max-w-[920px] 2xl:max-w-[1040px]">
              <PlayerBar
                name={blackName || "Black"}
                pieceColor="b"
                captured={blackCaptured}
                advantage={captured.advantage < 0 ? Math.abs(captured.advantage) : 0}
                time={snapshot[blackRole]?.remainingMs ?? 0}
                active={snapshot.running === blackRole}
              />
              <div className="w-full mx-auto" style={{ maxWidth: "min(100%, calc(100dvh - 11rem))" }}>
                <InteractiveBoard
                  fen={fen}
                  orientation="white"
                  playerColor="w"
                  interactive={false}
                  highlightSquares={{}}
                />
              </div>
              <PlayerBar
                name={whiteName || "White"}
                pieceColor="w"
                captured={whiteCaptured}
                advantage={captured.advantage > 0 ? captured.advantage : 0}
                time={snapshot[whiteRole]?.remainingMs ?? 0}
                active={snapshot.running === whiteRole}
              />
            </div>

            <div className="w-full xl:w-[340px] shrink-0 flex flex-col gap-3">
              <VariantRulesCard rules={rulesDiff} isTiebreak={isTiebreak} roundLabel={roundLabel} />
              <div className="bg-surface-container border border-white/[0.04] p-3 shrink-0">
                <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40 mb-1">
                  Spectator
                </h3>
                <p className="text-[11px] text-on-surface-variant/55 leading-snug">
                  Read-only view of a live arena match. Refresh to bail.
                </p>
              </div>
            </div>
        </div>
      </div>
    </div>
  );
}

// ── MatchResults ───────────────────────────────────────────

function MatchResults({ room, setRoom, role, user }) {
  const navigate = useNavigate();
  const [pendingPlayAgain, setPendingPlayAgain] = useState(false);
  const [error, setError] = useState(null);
  const result = room.match_result;
  const winnerRole = result?.winner;
  const youWon = winnerRole === role;
  const isDraw = winnerRole === null;
  const myName = role === "creator" ? room.creator_name : room.joiner_name;
  const oppRole = role === "creator" ? "joiner" : "creator";
  const oppName = role === "creator" ? room.joiner_name : room.creator_name;

  // Play-again with role swap. The previous JOINER becomes the
  // new CREATOR (so rules-design rotation is fair across
  // matches). The flow:
  //
  //   1. Either side clicks "Play again" -> writes
  //      round_state.playAgainOptIn.<role> = true.
  //   2. Once BOTH sides have opted in, the previous joiner's
  //      client creates a new arena_rooms row, stamps the
  //      previous creator as the joiner, and writes
  //      next_room_id on the old room so the previous creator's
  //      client can follow.
  //   3. Both sides land on the new lobby. The new creator
  //      designs Round 1's rules; the new joiner designs
  //      Round 2's rules (same flow as a fresh match).
  //
  // The previous version created the new room as soon as the
  // joiner clicked, even if the creator hadn't opted in. That
  // leaves an orphan if the creator never opts in. The new
  // version waits for both, so cancel-by-leaving-the-tab works.
  const myOptIn = !!(room.round_state?.playAgainOptIn || {})[role];
  const oppOptInRole = role === "creator" ? "joiner" : "creator";
  const oppOptIn = !!(room.round_state?.playAgainOptIn || {})[oppOptInRole];

  // Single side-effect to materialize the rematch room once
  // both sides have opted in. Only the previous-joiner's client
  // does the create (otherwise we'd race and produce two rooms).
  // Idempotent on next_room_id so a re-render doesn't double-
  // create.
  const rematchInFlightRef = useRef(false);
  useEffect(() => {
    if (room.next_room_id) return;
    if (!myOptIn || !oppOptIn) return;
    if (role !== "joiner") return;
    if (rematchInFlightRef.current) return;
    rematchInFlightRef.current = true;
    (async () => {
      try {
        const created = await createRoom({
          creatorId: user.id,
          creatorName: user.name || null,
        });
        if (!created.ok || !created.room) {
          setError(created.error || "Couldn't create the rematch room.");
          rematchInFlightRef.current = false;
          return;
        }
        // Link the rooms. The previous creator's client picks
        // up `next_room_id` via realtime + the navigate effect
        // below and lands on the new room. They claim the
        // joiner seat through the normal ClaimJoinerSeat flow
        // (which the arena_rooms_guard_writes trigger allows
        // because new.joiner_id = the claiming user's auth.uid()).
        await updateRoom(room.id, { next_room_id: created.room.id });
      } catch (e) {
        setError(e?.message || "Couldn't create the rematch room.");
        rematchInFlightRef.current = false;
      }
    })();
  }, [myOptIn, oppOptIn, room.next_room_id, role, user, room.id]);

  const onPlayAgain = useCallback(async () => {
    if (room.next_room_id) {
      navigate(`/arena/${room.next_room_id}`);
      return;
    }
    setPendingPlayAgain(true);
    setError(null);
    try {
      const round_state = {
        ...(room.round_state || {}),
        playAgainOptIn: {
          ...(room.round_state?.playAgainOptIn || {}),
          [role]: true,
        },
      };
      const updateResult = await updateRoom(room.id, { round_state });
      if (updateResult?.ok && updateResult.room && setRoom) {
        setRoom((prev) => ({ ...(prev || {}), ...updateResult.room }));
      } else if (!updateResult?.ok) {
        setError(updateResult?.error || "Couldn't opt in to rematch.");
      }
    } finally {
      setPendingPlayAgain(false);
    }
  }, [room, role, navigate, setRoom]);

  // Once next_room_id materializes, navigate both sides over.
  useEffect(() => {
    if (room.next_room_id) {
      navigate(`/arena/${room.next_room_id}`);
    }
  }, [room.next_room_id, navigate]);

  return (
    <div className="anim-fade-up space-y-5">
      <div className={`p-6 border space-y-2 ${
        isDraw
          ? "bg-surface-container border-white/[0.06]"
          : youWon
            ? "bg-emerald-500/10 border-emerald-500/30"
            : "bg-error/10 border-error/30"
      }`}>
        <h2 className="font-headline text-2xl font-extrabold tracking-tighter">
          {isDraw ? "Match drawn" : youWon ? "You won the match" : `${oppName || "Opponent"} won`}
        </h2>
        <p className="text-[13px] text-on-surface-variant/65">
          Final score: <span className="font-bold">{myName || "you"} {result?.score?.[role] ?? 0}</span> &mdash; <span className="font-bold">{oppName || "opponent"} {result?.score?.[oppRole] ?? 0}</span>
        </p>
      </div>

      <div className="p-4 bg-surface-low border border-white/[0.04]">
        <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40 mb-3">
          Rounds
        </h3>
        <div className="space-y-2">
          {(result?.rounds || []).map((r) => (
            <div key={r.round} className="flex items-baseline justify-between px-3 py-2 bg-surface-container border border-white/[0.04]">
              <span className="text-[12px] text-on-surface-variant/65">
                {r.round === "tiebreak" ? "Tie-break" : `Round ${r.round}`}
              </span>
              <span className="text-[12px] text-on-surface-variant/85">
                {r.winner === null ? "Draw" : (r.winner === role ? "You" : (oppName || "Opponent")) + " won"}
                <span className="text-on-surface-variant/40"> &middot; {r.reason}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={onPlayAgain}
          disabled={pendingPlayAgain || myOptIn}
          className="btn btn-primary px-5 py-2 text-xs">
          {pendingPlayAgain
            ? "Loading\u2026 opting in"
            : myOptIn
              ? (oppOptIn ? "Loading\u2026 starting rematch" : "Waiting on opponent\u2026")
              : "Play again"}
        </button>
        <button onClick={() => navigate("/arena")} className="btn btn-secondary px-5 py-2 text-xs">
          Back to Arena
        </button>
      </div>
      {oppOptIn && !myOptIn && (
        <p className="text-[12px] text-primary/65">
          {oppName || "Opponent"} wants a rematch.
        </p>
      )}
      {error && (
        <p className="text-[12px] text-error">{error}</p>
      )}
    </div>
  );
}

// ── Skeletons ──────────────────────────────────────────────

function ArenaLoading() {
  return (
    <div className="flex">
      <div className="flex-1 min-w-0 max-w-[1400px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10 min-h-[calc(100dvh-4rem)]">
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            <span className="text-[11px] uppercase tracking-widest text-on-surface-variant/40">
              Loading&hellip; arena room
            </span>
          </div>
        </div>
      </div>
      <SocialPanel />
    </div>
  );
}

function ArenaError({ message, onBack }) {
  return (
    <div className="flex">
      <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10 min-h-[calc(100dvh-4rem)]">
        <div className="text-center py-16">
          <h2 className="font-headline text-2xl font-extrabold tracking-tighter text-primary mb-2">Couldn&apos;t open the room</h2>
          <p className="text-sm text-on-surface-variant/55 max-w-md mx-auto mb-6">{message}</p>
          <button onClick={onBack} className="btn btn-primary px-5 py-2 text-xs">
            Back to Arena
          </button>
        </div>
      </div>
      <SocialPanel />
    </div>
  );
}
