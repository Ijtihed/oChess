import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import SocialPanel from "./SocialPanel";
import { isOnline } from "../lib/supabase";
import { createRoom } from "../lib/arena/service";
import { generateArenaRules, isAIRulesAvailable } from "../lib/arena/ai-rules";
import { resolveRules } from "../lib/arena/rules";
import { describeRules } from "../lib/arena/rule-preview";
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
          Describe a chess variant in your own words. AI builds the rules, you and your opponent each design one round, then 1v1.
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
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(null); // { rules, summary, model }
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [validatorErrors, setValidatorErrors] = useState(null);
  const [cooldownSec, setCooldownSec] = useState(0);
  const online = isOnline();
  const aiAvailable = isAIRulesAvailable();

  // Cooldown ticker for the rate-limit countdown.
  useEffect(() => {
    if (cooldownSec <= 0) return undefined;
    const t = setTimeout(() => setCooldownSec((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldownSec]);

  // Resolve the generated rule diff once for the preview
  // panel. Keeps the heavy resolver out of the per-render
  // path.
  const resolvedRules = useMemo(() => {
    if (!generated?.rules) return null;
    try { return resolveRules(generated.rules); }
    catch { return null; }
  }, [generated]);

  const description = useMemo(() => {
    if (!resolvedRules) return null;
    return describeRules(resolvedRules);
  }, [resolvedRules]);

  const onGenerate = useCallback(async () => {
    if (!aiAvailable) {
      setError("AI rule generator isn't configured. Sign in or check your connection.");
      return;
    }
    if (!prompt.trim()) {
      setError("Type a description first. e.g. 'Pawns can move backward, knights leap twice'.");
      return;
    }
    setGenerating(true);
    setError(null);
    setValidatorErrors(null);
    setGenerated(null);
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
      setGenerated({ rules: result.rules, summary: result.summary, model: result.model });
    } catch (e) {
      setError(e?.message || "AI request failed.");
    } finally {
      setGenerating(false);
    }
  }, [aiAvailable, prompt]);

  const onCreate = useCallback(async () => {
    if (!online) { setError("Offline. Connect to create rooms."); return; }
    if (!user?.id) { setError("Sign in first."); return; }
    if (!generated?.rules) { setError("Generate the rules first."); return; }
    setCreating(true);
    setError(null);
    try {
      const result = await createRoom({
        creatorId: user.id,
        creatorName: user.name || null,
        rulesCreator: generated.rules,
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
  }, [online, user, generated, navigate]);

  if (!aiAvailable) {
    return (
      <div className="anim-fade-up p-5 bg-surface-low border border-error/20 space-y-3" style={{ "--delay": "0.08s" }}>
        <h2 className="font-headline text-base font-bold text-primary mb-1">Create a room</h2>
        <p className="text-[12px] text-error leading-relaxed">
          AI rule generation isn&apos;t available right now. The Arena needs the Supabase Edge Function (arena_rules) to be deployed.
        </p>
      </div>
    );
  }

  return (
    <div className="anim-fade-up p-5 bg-surface-low border border-white/[0.04] space-y-4" style={{ "--delay": "0.08s" }}>
      <div>
        <h2 className="font-headline text-base font-bold text-primary mb-1">Create a room</h2>
        <p className="text-[12px] text-on-surface-variant/45 leading-relaxed">
          Describe round 1&apos;s rules. Your opponent designs round 2 once they join.
        </p>
      </div>
      <div>
        <label className="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant/40 block mb-1.5">
          Variant description
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. Pawns can move backwards. The first to capture 3 pieces wins."
          rows={3}
          maxLength={600}
          disabled={generating}
          className="w-full bg-surface-container border border-white/[0.06] px-3 py-2 text-[13px] text-on-surface placeholder:text-on-surface-variant/30 outline-none focus:border-primary/40 resize-none"
        />
        <p className="mt-1 text-[10px] text-on-surface-variant/30">
          {prompt.length} / 600
        </p>
      </div>
      <button onClick={onGenerate}
        disabled={generating || cooldownSec > 0 || !online || !prompt.trim()}
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
        <ul className="text-[11px] text-amber-300/70 leading-snug space-y-0.5">
          {validatorErrors.slice(0, 5).map((e, i) => (
            <li key={i} className="font-mono">&middot; {e}</li>
          ))}
        </ul>
      )}

      {generated && (
        <button onClick={onCreate}
          disabled={creating || !online}
          className="btn btn-primary w-full py-3 text-sm">
          {creating ? "Loading\u2026 creating room" : "Create room with these rules"}
        </button>
      )}

      {!online && (
        <p className="text-[11px] text-on-surface-variant/40 leading-relaxed">
          Online features aren&apos;t configured. Arena needs Supabase to share rooms.
        </p>
      )}
    </div>
  );
}

/**
 * Compact preview of what the AI rules change vs vanilla.
 * Shows the variant name + 1-line description + a list of
 * concrete changes (piece moves, win conditions, etc.). Same
 * shape used by the lobby + warmup + round-play side panels.
 */
function RulePreview({ description, model }) {
  if (!description) return null;
  return (
    <div className="px-3 py-3 bg-surface-container border border-primary/20 space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <span className="font-headline text-[13px] font-bold text-primary">
          {description.name || "Custom rules"}
        </span>
        {model && (
          <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/30">
            {model}
          </span>
        )}
      </div>
      {description.description && (
        <p className="text-[12px] text-on-surface-variant/65 leading-relaxed">
          {description.description}
        </p>
      )}
      {description.changes.length > 0 && (
        <ul className="text-[11px] text-on-surface-variant/65 leading-snug space-y-0.5">
          {description.changes.slice(0, 8).map((c, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-primary/60 shrink-0">&middot;</span>
              <span>{c.detail}</span>
            </li>
          ))}
          {description.changes.length > 8 && (
            <li className="text-on-surface-variant/35">
              &hellip; and {description.changes.length - 8} more
            </li>
          )}
        </ul>
      )}
      {description.changes.length === 0 && (
        <p className="text-[11px] text-on-surface-variant/40 italic">
          No changes from standard chess.
        </p>
      )}
    </div>
  );
}

// Export for use in the room lobby (joiner's prompt panel
// re-mounts the same UX inside ArenaRoom).
export { RulePreview };

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
