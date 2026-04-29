import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import SocialPanel from "./SocialPanel";
import { isOnline } from "../lib/supabase";
import { createRoom } from "../lib/arena/service";
import { PRESETS } from "../lib/arena/presets";
import ArenaRoom from "./ArenaRoom";

/**
 * ArenaPage - landing for the AI Arena route.
 *
 * Without a roomId, lands on the create-or-join screen:
 *   - Create: pick a rule preset, click Create. New room id
 *     gets pushed to the URL (/arena/<roomId>) and the share
 *     link is copied to clipboard.
 *   - Join: paste a share link or room id, click Join. Routes
 *     to /arena/<roomId>.
 *
 * With a roomId, mounts <ArenaRoom> for the actual lobby /
 * warmup / 1v1 flow.
 *
 * Phase 1 reuses hand-curated presets in place of free-form AI
 * prompting so we can prove the orchestration loop end-to-end
 * without bringing the LLM along. Phase 2 will replace the
 * preset picker with a prompt input and call out to the
 * arena_rules Edge Function.
 */
export default function ArenaPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  // Sub-route renders the room directly; the rest of this
  // component is the create / join landing.
  if (roomId) {
    return <ArenaRoom roomId={roomId} />;
  }

  if (authLoading) {
    return (
      <div className="flex">
        <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-3">
              <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              <span className="text-[11px] uppercase tracking-widest text-on-surface-variant/40">
                Loading&hellip;
              </span>
            </div>
          </div>
        </div>
        <SocialPanel />
      </div>
    );
  }

  if (!user || user.guest) {
    return (
      <div className="flex">
        <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
          <h1 className="anim-fade-up font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-1" style={{ "--delay": "0.05s" }}>Arena</h1>
          <p className="anim-fade-up text-sm text-on-surface-variant/40 mb-6" style={{ "--delay": "0.06s" }}>
            One player picks the rules, both players warm up vs an AI, then 1v1.
          </p>
          <div className="anim-fade-up p-6 bg-surface-low border border-white/[0.04]" style={{ "--delay": "0.08s" }}>
            <h2 className="font-headline text-base font-bold text-primary mb-2">Sign in to play</h2>
            <p className="text-[13px] text-on-surface-variant/55 leading-relaxed">
              Arena rooms live on the server so two players on different devices can share a link.
              Guest mode and offline play aren&apos;t supported here yet.
            </p>
          </div>
        </div>
        <SocialPanel />
      </div>
    );
  }

  return (
    <div className="flex">
      <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
        <h1 className="anim-fade-up font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mb-1" style={{ "--delay": "0.05s" }}>Arena</h1>
        <p className="anim-fade-up text-sm text-on-surface-variant/40 mb-6" style={{ "--delay": "0.06s" }}>
          Pick a variant, send the link, both warm up vs an AI, then play 1v1. Rules can be unhinged.
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          <CreatePanel user={user} navigate={navigate} />
          <JoinPanel navigate={navigate} />
        </div>
      </div>
      <SocialPanel />
    </div>
  );
}

// ── Create flow ────────────────────────────────────────────

function CreatePanel({ user, navigate }) {
  const [pickedId, setPickedId] = useState("vanilla");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const online = isOnline();

  const onCreate = useCallback(async () => {
    if (!online) {
      setError("Offline. Connect to create rooms.");
      return;
    }
    if (!user?.id) {
      setError("Sign in first.");
      return;
    }
    const preset = PRESETS.find((p) => p.id === pickedId);
    if (!preset) {
      setError("Pick a variant first.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const result = await createRoom({
        creatorId: user.id,
        creatorName: user.name || null,
        rulesCreator: { ...preset.diff, presetId: preset.id },
      });
      if (!result.ok || !result.room) {
        setError(result.error || "Couldn't create the room.");
        return;
      }
      navigate(`/arena/${result.room.id}`);
    } catch (e) {
      setError(e?.message || "Couldn't create the room.");
    } finally {
      setCreating(false);
    }
  }, [online, user, pickedId, navigate]);

  return (
    <div className="anim-fade-up p-5 bg-surface-low border border-white/[0.04] space-y-4" style={{ "--delay": "0.08s" }}>
      <div>
        <h2 className="font-headline text-base font-bold text-primary mb-1">Create a room</h2>
        <p className="text-[12px] text-on-surface-variant/45 leading-relaxed">
          Pick the rules for round 1. Your opponent picks the rules for round 2.
        </p>
      </div>
      <div className="space-y-1.5">
        {PRESETS.map((p) => (
          <PresetRow
            key={p.id}
            preset={p}
            picked={pickedId === p.id}
            onPick={() => setPickedId(p.id)}
          />
        ))}
      </div>
      <button onClick={onCreate}
        disabled={creating || !online}
        className="btn btn-primary w-full py-3 text-sm">
        {creating ? "Loading\u2026 creating room" : "Create room"}
      </button>
      {error && (
        <p className="text-[12px] text-error leading-relaxed">{error}</p>
      )}
      {!online && (
        <p className="text-[11px] text-on-surface-variant/40 leading-relaxed">
          Online features aren&apos;t configured. Arena needs Supabase to share rooms.
        </p>
      )}
    </div>
  );
}

function PresetRow({ preset, picked, onPick }) {
  return (
    <button
      onClick={onPick}
      className={`w-full text-left px-3 py-2.5 border transition-colors ${
        picked
          ? "bg-primary/10 border-primary/30"
          : "bg-surface-container border-white/[0.04] hover:border-primary/20 hover:bg-surface-high"
      }`}
    >
      <div className="flex items-baseline gap-2 mb-0.5">
        <span className={`font-headline text-[13px] font-bold ${picked ? "text-primary" : "text-on-surface"}`}>
          {preset.label}
        </span>
        {preset.id === "vanilla" && (
          <span className="px-1.5 py-0.5 bg-surface-low text-on-surface-variant/45 font-headline text-[9px] font-bold uppercase tracking-widest">
            Default
          </span>
        )}
      </div>
      <span className="text-[11px] text-on-surface-variant/55 leading-snug">
        {preset.summary}
      </span>
    </button>
  );
}

// ── Join flow ──────────────────────────────────────────────

function JoinPanel({ navigate }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState(null);

  const onJoin = useCallback(() => {
    setError(null);
    const id = extractRoomId(input.trim());
    if (!id) {
      setError("Paste an /arena room link or id.");
      return;
    }
    navigate(`/arena/${id}`);
  }, [input, navigate]);

  return (
    <div className="anim-fade-up p-5 bg-surface-low border border-white/[0.04] space-y-4" style={{ "--delay": "0.1s" }}>
      <div>
        <h2 className="font-headline text-base font-bold text-primary mb-1">Join a room</h2>
        <p className="text-[12px] text-on-surface-variant/45 leading-relaxed">
          Paste a link a friend sent you or a room id you copied.
        </p>
      </div>
      <div>
        <label className="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant/40 block mb-1.5">
          Room link or id
        </label>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="https://ochess.app/arena/abc-123 or just abc-123"
          autoCapitalize="none"
          autoCorrect="off"
          className="w-full bg-surface-container border border-white/[0.06] px-3 py-2.5 text-[13px] text-on-surface placeholder:text-on-surface-variant/30 outline-none focus:border-primary/40"
          onKeyDown={(e) => { if (e.key === "Enter") onJoin(); }}
        />
      </div>
      <button onClick={onJoin} className="btn btn-secondary w-full py-3 text-sm">
        Join room
      </button>
      {error && (
        <p className="text-[12px] text-error leading-relaxed">{error}</p>
      )}
    </div>
  );
}

/**
 * Pull a room id out of a free-form input. Accepts:
 *   - plain ids ("abc-123-uuid"),
 *   - full app URLs ("https://ochess.app/arena/abc-123"),
 *   - relative paths ("/arena/abc-123").
 */
function extractRoomId(input) {
  if (!input) return null;
  // URL form - extract the last /arena/<id> segment.
  const arenaMatch = input.match(/\/arena\/([^/?#]+)/i);
  if (arenaMatch) return arenaMatch[1];
  // Bare id - basic shape check (UUIDs are 36 chars with dashes).
  if (/^[A-Za-z0-9-]{8,64}$/.test(input)) return input;
  return null;
}
