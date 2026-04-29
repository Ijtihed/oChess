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
} from "../lib/sounds";
import {
  getRoom,
  joinRoom,
  updateRoom,
  deleteRoom,
  subscribeRoom,
  subscribeMoves,
  appendMove,
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
import { RulePreview } from "./ArenaPage";
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
  const onCommitJoinerRules = useCallback(async (rules) => {
    const patch = { rules_joiner: rules };
    const next = { ...room, ...patch };
    let nextStatus = room.status;
    if (next.rules_creator && next.rules_joiner) nextStatus = "warmup_round_1";
    else if (next.joiner_id) nextStatus = "prompting";
    if (nextStatus !== room.status) patch.status = nextStatus;
    const result = await updateRoom(roomId, patch);
    if (result?.ok && result.room) {
      setRoom?.((prev) => ({ ...(prev || {}), ...result.room }));
    }
  }, [room, roomId, setRoom]);

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
            // Creator's rules are committed at room-creation
            // time, so this branch only fires if the creator
            // somehow lands here without rules. Show a stub
            // with a back link.
            <p className="text-[12px] text-on-surface-variant/45">
              Your rules weren&apos;t saved correctly. Cancel the room and create a new one.
            </p>
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
      const result = await updateRoom(roomId, { status: nextStatus, round_state });
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

  const position = useMemo(() => {
    if (localPosition) return localPosition;
    try { return Position.fromFen(fenFromRoom); }
    catch { return Position.fromFen(VANILLA_FEN); }
  }, [fenFromRoom, localPosition]);

  // Move history for this round. Loaded from arena_moves on
  // mount and kept in sync via realtime + manual appends.
  const [moves, setMoves] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(null); // null = live; number = browsing
  const [highlight, setHighlight] = useState({});
  const [resignError, setResignError] = useState(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [confirmDraw, setConfirmDraw] = useState(false);
  const confirmTimerRef = useRef(null);
  const drawTimerRef = useRef(null);
  useEffect(() => () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    if (drawTimerRef.current) clearTimeout(drawTimerRef.current);
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
      .map((m) => ({
        to: m.to,
        promotion: m.promotion,
        captured: !!livePosition.pieceAt(m.to) || !!m.enPassant,
      }));
  }, [rules, myColor]);

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
    catch { playError(); return false; }

    // Sound + highlight match OnlineGameScreen so the play
    // surface feels identical. White tints for the last
    // move, capture/non-capture variants of the move sound.
    playMoveSound({ flags: move.captured ? "c" : "n" });
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

    // ── DB writes in the background ──
    // Fire-and-forget. The room realtime update from
    // updateRoom will replace localPosition once it lands.
    // appendMove still needs to resolve before round-end
    // PGN reconstruction, so we await the BACKGROUND task
    // chain inside the same async handler the round-end
    // effect can observe (the `lastWriteRef` promise).
    const writePromise = (async () => {
      try {
        await appendMove({ roomId, round, ply, fen: nextRoundState.fen, move: { ...move, san: lastHistory?.san } });
        const update = await updateRoom(roomId, { round_state: nextRoundState });
        if (update?.ok && update.room && setRoom) {
          setRoom((prev) => ({ ...(prev || {}), ...update.room }));
        }
      } catch (e) {
        // Network glitch - the realtime push from a peer's
        // future move OR a manual refetch will rectify.
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
  useEffect(() => {
    if (gameStatus.ended) return;
    const queued = premoveRef.current;
    if (!queued) return;
    if (position.turn !== myColor) return;
    // Validate legality under the live variant rules. If the
    // piece moved or the destination is now blocked the move
    // applyMove call will throw and we silently drop.
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
      const result = await updateRoom(roomId, {
        match_result: finalMatch,
        round_state: nextRoundState,
        status: nextStatus,
      });
      if (result?.ok && result.room && setRoom) {
        setRoom((prev) => ({ ...(prev || {}), ...result.room }));
      }
      // Persist the round to the games table for profile
      // history. Fire-and-forget; failure here doesn't block
      // the match flow. Skipped if we don't have full identity
      // info (e.g. partial DB row).
      if (room.creator_id && room.joiner_id) {
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
    const wasCapture = typeof last.san === "string" && last.san.includes("x");
    playMoveSound({ flags: wasCapture ? "c" : "n" });
  }, [moves, localPosition, localPly]);

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
      const result = await updateRoom(roomId, {
        match_result: finalMatch,
        round_state,
        status: nextStatus,
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
  //   { from: 'creator'|'joiner', round: <roundLabel> }
  // Either side can offer; the other side sees the incoming
  // banner and can Accept (round ends as a draw) or Decline
  // (offer cleared).
  const MAX_DRAW_OFFERS = 3;
  const drawOffersBySide = room.round_state?.drawOffersUsed || {};
  const myDrawOffersUsed = drawOffersBySide[role] || 0;
  const drawOffer = room.round_state?.drawOffer;
  const incomingDraw = drawOffer && drawOffer.from && drawOffer.from !== role && drawOffer.round === roundLabel;
  const myPendingDrawOffer = drawOffer && drawOffer.from === role && drawOffer.round === roundLabel;

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
    if (!confirmDraw) {
      setConfirmDraw(true);
      if (drawTimerRef.current) clearTimeout(drawTimerRef.current);
      drawTimerRef.current = setTimeout(() => setConfirmDraw(false), 4000);
      return;
    }
    if (drawTimerRef.current) clearTimeout(drawTimerRef.current);
    setConfirmDraw(false);
    const round_state = {
      ...(room.round_state || {}),
      drawOffer: { from: role, round: roundLabel, ts: new Date().toISOString() },
      drawOffersUsed: { ...drawOffersBySide, [role]: myDrawOffersUsed + 1 },
    };
    const result = await updateRoom(roomId, { round_state });
    if (result?.ok && result.room && setRoom) {
      setRoom((prev) => ({ ...(prev || {}), ...result.room }));
    }
  }, [gameStatus.ended, myDrawOffersUsed, myPendingDrawOffer, confirmDraw, room.round_state, role, roundLabel, drawOffersBySide, roomId, setRoom]);

  const onDrawDecline = useCallback(async () => {
    if (!incomingDraw) return;
    const round_state = {
      ...(room.round_state || {}),
      drawOffer: null,
    };
    const result = await updateRoom(roomId, { round_state });
    if (result?.ok && result.room && setRoom) {
      setRoom((prev) => ({ ...(prev || {}), ...result.room }));
    }
  }, [incomingDraw, room.round_state, roomId, setRoom]);

  const onDrawAccept = useCallback(async () => {
    if (!incomingDraw) return;
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
    const result = await updateRoom(roomId, {
      match_result: finalMatch,
      round_state,
      status: nextStatus,
    });
    if (!result?.ok) {
      advanceRoundEndedRef.current = false;
      return;
    }
    if (result?.room && setRoom) {
      setRoom((prev) => ({ ...(prev || {}), ...result.room }));
    }
  }, [incomingDraw, role, roundLabel, status, position, room, roomId, setRoom]);

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
            <div className="w-full mx-auto" style={{ maxWidth: "min(100%, calc(100dvh - 11rem))" }}>
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
                interactive={liveMode && !gameStatus.ended}
                highlightSquares={highlight}
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
            {!gameStatus.ended && (
              <div className="flex gap-2 shrink-0 flex-wrap">
                <button onClick={onDrawOffer} disabled={myDrawOffersUsed >= MAX_DRAW_OFFERS || !!myPendingDrawOffer}
                  className={`py-2.5 px-3 font-headline text-xs font-bold uppercase tracking-wide transition-colors active:scale-[0.96] ${
                    myDrawOffersUsed >= MAX_DRAW_OFFERS ? "bg-surface-low/50 border border-white/[0.02] text-on-surface-variant/15"
                    : myPendingDrawOffer ? "bg-amber-500/10 border border-amber-500/15 text-amber-400/60"
                    : confirmDraw ? "bg-amber-500/20 text-amber-400 border border-amber-500/20"
                    : "bg-surface-low border border-white/[0.04] text-on-surface-variant/35 hover:text-amber-400 hover:border-amber-500/15"
                  }`}>
                  {myDrawOffersUsed >= MAX_DRAW_OFFERS
                    ? "No draws left"
                    : myPendingDrawOffer
                      ? "Draw pending\u2026"
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

  // Play-again with role swap: previous joiner becomes new
  // creator. Each side opts in from the results screen; first
  // to click creates the new room and writes its id back into
  // the old room so the OTHER side can follow.
  const onPlayAgain = useCallback(async () => {
    if (room.next_room_id) {
      navigate(`/arena/${room.next_room_id}`);
      return;
    }
    setPendingPlayAgain(true);
    setError(null);
    // Determine new creator: previous JOINER. If I am the
    // joiner, I create. Otherwise I wait for the joiner to
    // create + write next_room_id.
    if (role !== "joiner") {
      // Just sit and wait - polling + realtime will pick up
      // the new room id when the joiner clicks Play again.
      setPendingPlayAgain(false);
      const updateResult = await updateRoom(room.id, { round_state: { ...(room.round_state || {}), playAgainOptIn: { ...(room.round_state?.playAgainOptIn || {}), [role]: true } } });
      if (updateResult?.ok && updateResult.room && setRoom) {
        setRoom((prev) => ({ ...(prev || {}), ...updateResult.room }));
      }
      return;
    }
    const created = await createRoom({
      creatorId: user.id,
      creatorName: user.name || null,
    });
    if (!created.ok || !created.room) {
      setPendingPlayAgain(false);
      setError(created.error || "Couldn't create the rematch room.");
      return;
    }
    // Stamp the previous creator as the new joiner up front
    // so they don't have to claim a seat.
    await updateRoom(created.room.id, {
      joiner_id: room.creator_id,
      joiner_name: room.creator_name,
    });
    // Link the rooms so the previous creator can follow.
    await updateRoom(room.id, { next_room_id: created.room.id });
    setPendingPlayAgain(false);
    navigate(`/arena/${created.room.id}`);
  }, [room, role, user, navigate, setRoom]);

  // The waiting-for-other-side state. If I opted in but the
  // other side hasn't created yet, show waiting copy. If
  // next_room_id appears, navigate there.
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
          disabled={pendingPlayAgain}
          className="btn btn-primary px-5 py-2 text-xs">
          {pendingPlayAgain
            ? "Loading\u2026 setting up rematch"
            : role === "joiner"
              ? "Play again"
              : ((room.round_state?.playAgainOptIn || {})[role] ? "Waiting on opponent\u2026" : "Play again")}
        </button>
        <button onClick={() => navigate("/arena")} className="btn btn-secondary px-5 py-2 text-xs">
          Back to Arena
        </button>
      </div>
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
