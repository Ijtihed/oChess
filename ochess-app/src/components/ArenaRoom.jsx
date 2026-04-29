import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import SocialPanel from "./SocialPanel";
import InteractiveBoard from "./InteractiveBoard";
import { playMoveSound, playError } from "../lib/sounds";
import {
  getRoom,
  joinRoom,
  updateRoom,
  deleteRoom,
  subscribeRoom,
} from "../lib/arena/service";
import { resolveRules } from "../lib/arena/rules";
import { Position } from "../lib/arena/position";
import { generateLegalMoves } from "../lib/arena/move-gen";
import { applyMove } from "../lib/arena/apply-move";
import { checkGameStatus } from "../lib/arena/win-check";
import { pickRandomMoveAsync } from "../lib/arena/random-bot";
import { PRESETS, presetById } from "../lib/arena/presets";
import { VANILLA_FEN } from "../lib/arena/schema";

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
    const unsub = subscribeRoom(roomId, (next) => {
      if (cancelled) return;
      setRoom((prev) => ({ ...(prev || {}), ...next }));
    });
    // Backup polling. Realtime is the primary sync path, but
    // the channel can silently die (network blip, server-side
    // hiccup, table accidentally not on the publication). A
    // 5s poll guarantees the UI converges even if realtime
    // stops delivering UPDATE events. Cheap (one row by id).
    const poll = setInterval(async () => {
      if (cancelled) return;
      const r = await getRoom(roomId);
      if (cancelled || !r.ok || !r.room) return;
      setRoom((prev) => {
        // Avoid React re-rendering when nothing changed. We
        // compare updated_at since it's the canonical change
        // marker on the row.
        if (prev?.updated_at === r.room.updated_at && prev?.status === r.room.status) {
          return prev;
        }
        return { ...(prev || {}), ...r.room };
      });
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      unsub?.();
    };
  }, [roomId]);

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

  // Tighter shell for board-bearing states (warmup / round /
  // tiebreak / done). Mirrors OnlineGameScreen's padding
  // (`py-3 sm:py-4`) so the board sits in the same visual
  // density as a regular Play match. Lobby keeps the relaxed
  // `py-6 sm:py-10` for breathing room around the rule
  // pickers + share-link card.
  const isBoardState = room.status === "warmup_round_1"
    || room.status === "warmup_round_2"
    || room.status === "round_1"
    || room.status === "round_2"
    || room.status === "tiebreak";
  const shellPadding = isBoardState
    ? "px-4 sm:px-6 md:px-10 xl:px-6 py-3 sm:py-4"
    : "px-4 sm:px-6 md:px-10 py-6 sm:py-10";

  return (
    <div className="flex">
      <div className={`flex-1 min-w-0 max-w-[1400px] xl:max-w-[1500px] 2xl:max-w-[1600px] mx-auto ${shellPadding} min-h-[calc(100dvh-4rem)]`}>
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
            Share the URL with your opponent &middot; status: <span className="text-on-surface-variant/85 font-bold">{room.status}</span>
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

// ── Body dispatch ──────────────────────────────────────────

function RoomBody({ room, setRoom, role, user, roomId }) {
  // Spectator (not creator and not joiner). The share-link UX
  // assumes the link recipient is the intended joiner; we
  // gate access to the open seat behind an explicit "Join"
  // click so a stranger who knows the URL can't auto-claim.
  if (!role) {
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
  if (room.status === "warmup_round_1" || room.status === "warmup_round_2") {
    return (
      <Warmup
        room={room}
        setRoom={setRoom}
        role={role}
        roomId={roomId}
      />
    );
  }

  // Round / tiebreak / done — Phase 1 stub.
  return (
    <RoundPlaceholder room={room} role={role} />
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
  const [picking, setPicking] = useState(false);
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

  const onPickRules = useCallback(async (preset) => {
    setPicking(true);
    const patch = role === "creator"
      ? { rules_creator: { ...preset.diff, presetId: preset.id } }
      : { rules_joiner: { ...preset.diff, presetId: preset.id } };
    // Auto-advance to 'prompting' if creator was waiting for
    // joiner and creator's rules are now set, or to
    // 'warmup_round_1' if both rules are stamped.
    const next = { ...room, ...patch };
    let nextStatus = room.status;
    if (next.rules_creator && next.rules_joiner) nextStatus = "warmup_round_1";
    else if (next.joiner_id) nextStatus = "prompting";
    if (nextStatus !== room.status) patch.status = nextStatus;
    const result = await updateRoom(roomId, patch);
    if (result?.ok && result.room) {
      // Don't wait for realtime - apply the new row to local
      // state immediately. The realtime subscription will fire
      // a redundant UPDATE shortly which is a no-op merge.
      setRoom?.((prev) => ({ ...(prev || {}), ...result.room }));
    }
    setPicking(false);
  }, [room, role, roomId, setRoom]);

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
    <div className="grid gap-6 xl:grid-cols-[1fr_320px] anim-fade-up">
      <div className="space-y-4">
        <div className="p-5 bg-surface-low border border-white/[0.04] space-y-3">
          <h2 className="font-headline text-sm font-bold uppercase tracking-widest text-on-surface-variant/45">
            Your rules
          </h2>
          {myRules ? (
            <RuleSummary rules={myRules} />
          ) : (
            <RulePicker disabled={picking} onPick={onPickRules} />
          )}
        </div>

        <div className="p-5 bg-surface-low border border-white/[0.04] space-y-3">
          <h2 className="font-headline text-sm font-bold uppercase tracking-widest text-on-surface-variant/45">
            Opponent&apos;s rules
          </h2>
          {oppRules ? (
            <RuleSummary rules={oppRules} />
          ) : (
            <p className="text-[12px] text-on-surface-variant/45">
              {oppName ? `${oppName} is picking\u2026` : "Waiting for opponent\u2026"}
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

        {/* Cancel-room: creator-only, only available while no
            opponent has claimed the second seat. Two-step
            confirm matches the destructive-action pattern used
            in /review (overflow menu Remove / Reset). */}
        {canCancel && (
          <div className="p-4 bg-surface-low border border-white/[0.04] space-y-2">
            <button onClick={onCancel}
              disabled={cancelPending}
              title={confirmCancel ? "Tap again to permanently cancel this room" : "Cancel this room"}
              className={`w-full px-3 py-2 font-headline text-[10px] font-bold uppercase tracking-widest border transition-colors ${
                confirmCancel
                  ? "bg-error/15 border-error/30 text-error animate-pulse"
                  : "bg-surface-container border-white/[0.04] text-on-surface-variant/45 hover:text-error hover:border-error/20"
              }`}>
              {cancelPending
                ? "Loading\u2026 cancelling"
                : confirmCancel
                  ? "Tap again to cancel"
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

function RulePicker({ onPick, disabled }) {
  return (
    <div className="space-y-1.5">
      {PRESETS.map((p) => (
        <button key={p.id}
          onClick={() => onPick(p)}
          disabled={disabled}
          className="w-full text-left px-3 py-2.5 bg-surface-container border border-white/[0.04] hover:border-primary/30 hover:bg-surface-high transition-colors disabled:opacity-50 disabled:pointer-events-none">
          <span className="font-headline text-[13px] font-bold text-on-surface block mb-0.5">{p.label}</span>
          <span className="text-[11px] text-on-surface-variant/55 leading-snug block">{p.summary}</span>
        </button>
      ))}
    </div>
  );
}

function RuleSummary({ rules }) {
  // Pull the preset metadata back from the diff. Phase 1 always
  // attaches `presetId`; Phase 2 will need a richer renderer
  // that descends into the rule object.
  const preset = rules.presetId ? presetById(rules.presetId) : null;
  return (
    <div className="px-3 py-2.5 bg-surface-container border border-white/[0.04]">
      <span className="font-headline text-[13px] font-bold text-primary block mb-0.5">
        {preset?.label || rules.name || "Custom rules"}
      </span>
      <span className="text-[11px] text-on-surface-variant/55 leading-snug">
        {preset?.summary || rules.description || "Custom variant rules."}
      </span>
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

  // When BOTH are ready, advance status to round_<n>. First
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
      const result = await updateRoom(roomId, { status: nextStatus });
      if (result?.ok && result.room && setRoom) {
        setRoom((prev) => ({ ...(prev || {}), ...result.room }));
      }
    })();
  }, [ready, oppReady, round, room.status, roomId, setRoom]);

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
      .map((m) => ({
        to: m.to,
        promotion: m.promotion,
        // Mark capture moves so the board renders the larger
        // capture-ring rather than the central dot. We have
        // to look at the destination square because the
        // engine doesn't pre-stamp the captured piece on
        // pseudo-moves the way chess.js does.
        captured: !!position.pieceAt(m.to) || !!m.enPassant,
      }));
  }, [position, rules, myColor]);

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
    } catch {
      playError();
      return false;
    }
    playMoveSound({ flags: move.captured ? "c" : "n" });
    setPosition(next);
    setHighlight({
      [move.from]: { backgroundColor: "rgba(76,175,80,0.25)" },
      [move.to]:   { backgroundColor: "rgba(76,175,80,0.35)" },
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

  return (
    <div className="flex flex-col xl:flex-row gap-4 xl:gap-6 anim-fade-up">
      <div className="flex-1 flex flex-col items-center xl:items-start max-w-[760px] xl:max-w-[920px] 2xl:max-w-[1040px]">
        <div className="w-full mb-3">
          <h2 className="font-headline text-base sm:text-lg font-extrabold tracking-tighter text-primary leading-tight">
            Warmup &middot; Round {round}
          </h2>
          <p className="text-[11px] text-on-surface-variant/55 mt-0.5">
            Get a feel for the variant. {WARMUP_DURATION_S}s, then the real round starts.
            Playing as <span className="font-bold text-on-surface-variant/85">{myColor === "w" ? "White" : "Black"}</span> against a random-move dummy.
          </p>
        </div>
        {/* Height-aware width cap. The board is aspect-square,
            so without this it can grow taller than the viewport
            on widescreen monitors and force vertical scrolling.
            Mirrors the math used by OnlineGameScreen / GameScreen
            (the chrome above + below the board takes ~11rem). */}
        <div className="w-full mx-auto" style={{ maxWidth: "min(100%, calc(100dvh - 11rem))" }}>
          <InteractiveBoard
            fen={position.toFen()}
            onMove={onUserMove}
            orientation={orientation}
            playerColor={myColor}
            interactive={position.turn === myColor && !ready}
            highlightSquares={highlight}
            legalMovesProvider={legalMovesProvider}
          />
        </div>
      </div>

      <div className="w-full xl:w-[280px] shrink-0 space-y-3">
        <div className="p-4 bg-surface-low border border-white/[0.04] space-y-2">
          <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">
            Round {round} rules
          </h3>
          <RuleSummary rules={rulesDiff || { extends: "vanilla" }} />
        </div>

        <div className="p-4 bg-surface-low border border-white/[0.04] space-y-3">
          <h3 className="font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">
            Warmup
          </h3>
          <div className="text-center">
            <span className="font-headline text-3xl font-extrabold tabular-nums text-primary">{secondsLeft}</span>
            <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/40 ml-1">s left</span>
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
        </div>
      </div>
    </div>
  );
}

// ── Round / done placeholder (Phase 1 stop) ────────────────

function RoundPlaceholder({ room, role }) {
  return (
    <div className="anim-fade-up p-6 bg-surface-low border border-primary/20 space-y-3">
      <h2 className="font-headline text-base font-bold text-primary">
        {room.status === "done" ? "Match complete" : `Phase 1 stop: ${room.status}`}
      </h2>
      <p className="text-[13px] text-on-surface-variant/65 leading-relaxed">
        The 1v1 rounds and tie-break aren&apos;t wired up yet in this slice. Both warmups completed
        successfully if you got here, and the room is ready to advance into round play. Keep an
        eye out for the next push.
      </p>
      <p className="text-[11px] text-on-surface-variant/40">
        You are the <span className="font-bold">{role}</span>.
      </p>
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
