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
    return () => {
      cancelled = true;
      unsub?.();
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

  return (
    <div className="flex">
      <div className="flex-1 min-w-0 max-w-[1400px] xl:max-w-[1500px] 2xl:max-w-[1600px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10 min-h-[calc(100dvh-4rem)]">
        <header className="anim-fade-up mb-5" style={{ "--delay": "0.05s" }}>
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

function RoomBody({ room, role, user, roomId }) {
  // Spectator (not creator and not joiner). Phase 1 doesn't
  // mount the seat-claim flow yet because the share-link UX
  // assumes the link recipient IS the joiner; for now we just
  // attempt to claim the open joiner seat on mount.
  if (!role) {
    return <ClaimJoinerSeat room={room} user={user} roomId={roomId} />;
  }

  // Lobby states.
  if (room.status === "waiting_for_joiner" || room.status === "prompting") {
    return (
      <Lobby
        room={room}
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

function ClaimJoinerSeat({ room, user, roomId }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const onClaim = useCallback(async () => {
    setPending(true);
    setError(null);
    const result = await joinRoom({
      roomId,
      joinerId: user.id,
      joinerName: user.name || null,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error || "Couldn't join the room.");
      return;
    }
    setDone(true);
  }, [roomId, user]);

  if (done) {
    // Subscription will refresh the room and the Lobby will
    // mount on the next render. Brief intermediate state.
    return (
      <div className="anim-fade-up p-6 bg-surface-low border border-white/[0.04]">
        <p className="text-[13px] text-on-surface-variant/55">Loading&hellip; opening the lobby</p>
      </div>
    );
  }

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

function Lobby({ room, role, user, roomId }) {
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState(false);

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
    await updateRoom(roomId, patch);
    setPicking(false);
  }, [room, role, roomId]);

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

const WARMUP_DURATION_S = 30;

function Warmup({ room, role, roomId }) {
  const round = room.status === "warmup_round_1" ? 1 : 2;
  const rulesDiff = round === 1 ? room.rules_creator : room.rules_joiner;
  // Round 1: creator plays Black under their own rules
  // (because the rule designer plays Black per the spec). The
  // joiner plays White. Round 2 is the mirror.
  const myColor = round === 1
    ? (role === "creator" ? "b" : "w")
    : (role === "creator" ? "w" : "b");

  const rules = useMemo(() => {
    try { return resolveRules(rulesDiff || { extends: "vanilla" }); }
    catch { return resolveRules({ extends: "vanilla" }); }
  }, [rulesDiff]);

  const [position, setPosition] = useState(() => Position.fromFen(rules.startingFen || VANILLA_FEN));
  const [highlight, setHighlight] = useState({});
  const [secondsLeft, setSecondsLeft] = useState(WARMUP_DURATION_S);
  const [ready, setReady] = useState(false);
  const [oppReady, setOppReady] = useState(false);
  const abortRef = useRef(null);

  // Reset board if rules change (e.g. transitioning from round
  // 1 warmup to round 2 warmup mid-mount).
  useEffect(() => {
    setPosition(Position.fromFen(rules.startingFen || VANILLA_FEN));
    setHighlight({});
    setSecondsLeft(WARMUP_DURATION_S);
    setReady(false);
  }, [rules]);

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

  // Mirror my readiness into the room row so the opponent sees
  // it. We also poll opponent's readiness from the room state.
  useEffect(() => {
    if (!ready) return;
    const flagKey = role === "creator" ? "warmup_creator_ready" : "warmup_joiner_ready";
    const round_state = { ...(room.round_state || {}), [flagKey]: round };
    updateRoom(roomId, { round_state });
  }, [ready, role, room.round_state, roomId, round]);

  // Opponent ready flag from the room row.
  useEffect(() => {
    const flagKey = role === "creator" ? "warmup_joiner_ready" : "warmup_creator_ready";
    setOppReady((room.round_state || {})[flagKey] === round);
  }, [room.round_state, role, round]);

  // When BOTH are ready, advance status to round_<n>. First
  // client to win this race transitions; the other reacts via
  // realtime.
  useEffect(() => {
    if (!ready || !oppReady) return;
    const nextStatus = round === 1 ? "round_1" : "round_2";
    if (room.status !== nextStatus) {
      updateRoom(roomId, { status: nextStatus });
    }
  }, [ready, oppReady, round, room.status, roomId]);

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
    <div className="grid gap-6 xl:grid-cols-[1fr_320px] anim-fade-up">
      <div className="flex flex-col items-center xl:items-start max-w-[760px] xl:max-w-[920px] 2xl:max-w-[1040px]">
        <div className="w-full mb-4">
          <h2 className="font-headline text-lg sm:text-xl font-extrabold tracking-tighter text-primary leading-tight">
            Warmup &middot; Round {round}
          </h2>
          <p className="text-[12px] text-on-surface-variant/55 mt-1">
            Get a feel for the variant. {WARMUP_DURATION_S} seconds, then the real round starts.
            Playing as <span className="font-bold text-on-surface-variant/85">{myColor === "w" ? "White" : "Black"}</span> against a random-move dummy.
          </p>
        </div>
        <InteractiveBoard
          fen={position.toFen()}
          onMove={onUserMove}
          orientation={orientation}
          playerColor={myColor}
          interactive={position.turn === myColor && !ready}
          highlightSquares={highlight}
        />
      </div>

      <div className="space-y-4">
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
