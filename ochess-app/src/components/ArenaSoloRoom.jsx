/**
 * ArenaSoloRoom - play your AI-generated variant against a
 * bot, no opponent required.
 *
 * Why this exists: the multiplayer arena room flow assumes
 * two humans, which means most users with a great variant
 * idea hit the wall of "I have no one to play with right now".
 * Solo mode is the "feel out the variant" surface - same
 * engine, same visuals, just an automated opponent.
 *
 * Bot strategy: random-mover from the legal-move set. NOT a
 * real chess engine. This is deliberate:
 *   - Real engines don't understand custom variants. Adding
 *     one would require a per-variant evaluation function,
 *     which the AI doesn't generate today.
 *   - Random play is enough for "does this variant feel
 *     interesting?" - the user is mostly testing mechanics
 *     and visuals, not playing for blood.
 *   - Random play also has a meta-property: the user gets to
 *     drive the action. Anything more sophisticated would
 *     dominate them (the bot would always cast the strongest
 *     ability, the user wouldn't get to experiment).
 *
 * State lives entirely in this component - no Supabase, no
 * realtime sync. Refresh = fresh game.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import InteractiveBoard from "./InteractiveBoard";
import ArenaVisualOverlay from "./ArenaVisualOverlay";
import ArenaAbilityPanel from "./ArenaAbilityPanel";
import { compileVisuals } from "../lib/arena/visual-sandbox/compile-draws";
import { useActiveProjectiles } from "../lib/arena/use-active-projectiles";
import {
  Position,
  resolveRules,
  generateLegalMoves,
  applyMove,
  checkGameStatus,
  VANILLA_FEN,
} from "../lib/arena";
import { playMoveSound, playError, playAbilityCast } from "../lib/sounds";

const BOT_THINK_MIN_MS = 600;
const BOT_THINK_MAX_MS = 1200;

/**
 * Pull the rules diff for solo play out of sessionStorage. The
 * /arena lobby's "play solo" button stashes the just-generated
 * diff there before navigating; we restore it on mount. This
 * is intentionally non-persistent across tab close: a fresh
 * solo game shouldn't auto-restore on a page reload.
 */
function loadSessionVariant() {
  try {
    const raw = sessionStorage.getItem("arena_solo_variant");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default function ArenaSoloRoom() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [variant] = useState(() => loadSessionVariant());

  // No variant in session = navigate back to the lobby. This is
  // the "user opened the URL directly" failsafe.
  useEffect(() => {
    if (!variant) {
      navigate("/arena", { replace: true });
    }
  }, [variant, navigate]);

  if (!variant) return null;

  return <SoloGame variant={variant} navigate={navigate} userName={user?.name || "You"} />;
}

function SoloGame({ variant, navigate, userName }) {
  const rules = useMemo(() => {
    try { return resolveRules(variant.rules || { extends: "vanilla" }); }
    catch { return resolveRules({ extends: "vanilla" }); }
  }, [variant]);

  const [position, setPosition] = useState(() => {
    // Restore from sessionStorage if the user reloaded mid-game.
    // Indexed by variant name so two different solo sessions
    // don't clobber each other (rare but easy to fix).
    try {
      const saved = sessionStorage.getItem(`arena_solo_pos:${variant.rules?.name || "v"}`);
      if (saved) return Position.fromFen(saved);
    } catch { /* ignore */ }
    return Position.fromFen(rules.startingFen || VANILLA_FEN);
  });
  // Persist position on every change so a reload doesn't lose
  // the game.
  useEffect(() => {
    try {
      sessionStorage.setItem(`arena_solo_pos:${variant.rules?.name || "v"}`, position.toFen());
    } catch { /* ignore */ }
  }, [position, variant]);
  const [highlight, setHighlight] = useState({});
  const [castFlash, setCastFlash] = useState(null);
  const [variantError, setVariantError] = useState(null);
  const [gameEnded, setGameEnded] = useState(null);
  const [abilityHighlight, setAbilityHighlight] = useState([]);
  // Most recent bot move surfaced as a small toast so the user
  // can see WHAT the bot played (especially abilities, which
  // are easy to miss). Auto-clears after 2.5s.
  const [botMoveToast, setBotMoveToast] = useState(null);
  useEffect(() => {
    if (!botMoveToast) return undefined;
    const t = setTimeout(() => setBotMoveToast(null), 2500);
    return () => clearTimeout(t);
  }, [botMoveToast]);

  // Visual overlay state.
  const compiledVisuals = useMemo(() => {
    if (!variant.rules?.visuals) return null;
    return compileVisuals(variant.rules.visuals).compiled;
  }, [variant]);
  const { projectiles, fireProjectile } = useActiveProjectiles();

  // Player picks a side at game start; default white. The bot
  // takes the other.
  const [myColor] = useState(() => "w");
  const botColor = myColor === "w" ? "b" : "w";

  // Cast flash auto-clears.
  useEffect(() => {
    if (!castFlash) return undefined;
    const t = setTimeout(() => setCastFlash(null), 700);
    return () => clearTimeout(t);
  }, [castFlash]);

  // Variant-error toast auto-clears.
  useEffect(() => {
    if (!variantError) return undefined;
    const t = setTimeout(() => setVariantError(null), 6000);
    return () => clearTimeout(t);
  }, [variantError]);

  // Game-status check on every position change.
  useEffect(() => {
    const status = checkGameStatus(position, rules);
    if (status.ended) {
      setGameEnded(status);
    }
  }, [position, rules]);

  // Apply a move (player or bot).
  const applyAndAdvance = useCallback((move) => {
    let next;
    try {
      next = applyMove(position, move, rules);
    } catch (e) {
      setVariantError(e?.message || "That move can't be played.");
      playError();
      return false;
    }
    if (move.kind === "ability") {
      const ab = findAbility(rules, move.casterType, move.abilityId, move.castColor || position.turn);
      playAbilityCast(ab);
      setCastFlash({ from: move.from, to: move.to });
      fireProjectile(move.from, move.to, move.abilityId, 350);
    } else {
      playMoveSound({ flags: move.captured ? "c" : "n" });
    }
    setHighlight({
      [move.from]: { backgroundColor: "rgba(255,255,255,0.07)" },
      [move.to]:   { backgroundColor: "rgba(255,255,255,0.11)" },
    });
    setPosition(next);
    return true;
  }, [position, rules, fireProjectile]);

  // User-driven move from the InteractiveBoard.
  const onUserMove = useCallback((move) => {
    if (gameEnded) return false;
    if (position.turn !== myColor) return false;
    return applyAndAdvance(move);
  }, [gameEnded, position.turn, myColor, applyAndAdvance]);

  // Bot move scheduler. When it's the bot's turn AND the game
  // isn't over, pick a random legal move after a small think
  // delay so the user can perceive turn-taking.
  const botTimeoutRef = useRef(null);
  useEffect(() => {
    if (gameEnded) return undefined;
    if (position.turn !== botColor) return undefined;
    const moves = generateLegalMoves(position, rules);
    if (moves.length === 0) return undefined;
    const delay = BOT_THINK_MIN_MS + Math.random() * (BOT_THINK_MAX_MS - BOT_THINK_MIN_MS);
    botTimeoutRef.current = setTimeout(() => {
      const choice = pickBotMove(moves);
      if (choice) {
        const ok = applyAndAdvance({ ...choice, castColor: botColor });
        if (ok) {
          setBotMoveToast(formatBotMove(choice));
        }
      }
    }, delay);
    return () => {
      if (botTimeoutRef.current) clearTimeout(botTimeoutRef.current);
    };
  }, [position, rules, botColor, gameEnded, applyAndAdvance]);

  // Move-provider for the interactive board.
  const legalMovesProvider = useCallback((square) => {
    if (gameEnded) return [];
    if (position.turn !== myColor) return [];
    const all = generateLegalMoves(position, rules);
    return all
      .filter((m) => m.from === square)
      .map((m) => ({
        to: m.to,
        promotion: m.promotion || null,
        kind: m.kind,
        abilityId: m.abilityId,
        casterType: m.casterType,
      }));
  }, [position, rules, gameEnded, myColor]);

  const orientation = myColor === "w" ? "white" : "black";

  return (
    <div className="flex">
      <div className="flex-1 min-w-0 max-w-[1200px] mx-auto px-4 sm:px-6 md:px-10 py-6 sm:py-10">
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="font-headline text-2xl font-extrabold text-primary">
              {variant.rules?.name || "Solo arena"}
            </h1>
            <p className="text-[12px] text-on-surface-variant/45">
              Solo vs bot &middot; random opponent. Refresh to start over.
            </p>
          </div>
          <button
            onClick={() => navigate("/arena")}
            className="text-[11px] uppercase tracking-widest text-on-surface-variant/45 hover:text-primary transition-colors"
          >
            Back to lobby
          </button>
        </header>

        <div className="grid gap-4 md:grid-cols-[1fr,260px]">
          <div className="relative">
            <InteractiveBoard
              fen={position.toFen()}
              onMove={onUserMove}
              orientation={orientation}
              playerColor={myColor}
              interactive={position.turn === myColor && !gameEnded}
              highlightSquares={mergeHighlight(highlight, abilityHighlight, castFlash)}
              legalMovesProvider={legalMovesProvider}
            />
            <ArenaVisualOverlay
              compiledDraws={compiledVisuals}
              seed={`solo:${variant.rules?.name || "v"}`}
              position={position}
              orientation={orientation}
              projectiles={projectiles}
              disabled={!compiledVisuals}
            />
            {variantError && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[3] px-3 py-2 bg-error/95 text-white text-xs rounded shadow-xl">
                {variantError}
              </div>
            )}
            {botMoveToast && !gameEnded && (
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-[3] px-3 py-1.5 bg-surface-low/95 border border-white/[0.08] text-on-surface text-[11px] font-mono rounded shadow-xl">
                Bot: <span className="text-primary font-bold">{botMoveToast}</span>
              </div>
            )}
            {gameEnded && (
              <div className="absolute inset-0 z-[5] bg-black/60 flex items-center justify-center">
                <div className="bg-surface-low border border-white/[0.06] px-6 py-5 text-center max-w-sm">
                  <h2 className="font-headline text-xl font-bold text-primary mb-1">
                    {gameEndedHeadline(gameEnded, myColor)}
                  </h2>
                  <p className="text-[12px] text-on-surface-variant/55 mb-4">
                    {gameEnded.reason || "Game over."}
                  </p>
                  <div className="flex gap-2 justify-center">
                    <button
                      onClick={() => {
                        try {
                          sessionStorage.removeItem(`arena_solo_pos:${variant.rules?.name || "v"}`);
                        } catch { /* ignore */ }
                        setPosition(Position.fromFen(rules.startingFen || VANILLA_FEN));
                        setGameEnded(null);
                        setHighlight({});
                      }}
                      className="btn btn-primary px-4 py-2 text-xs"
                    >
                      Play again
                    </button>
                    <button
                      onClick={() => navigate("/arena")}
                      className="btn btn-secondary px-4 py-2 text-xs"
                    >
                      Lobby
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <aside>
            <div className="mb-3 px-3 py-2 bg-surface-low border border-white/[0.04]">
              <p className="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant/45 mb-0.5">
                Player
              </p>
              <p className="text-[13px] text-on-surface">
                {userName} <span className="text-on-surface-variant/40">({myColor === "w" ? "White" : "Black"})</span>
              </p>
              <p className="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant/45 mt-2 mb-0.5">
                Opponent
              </p>
              <p className="text-[13px] text-on-surface">
                Random bot <span className="text-on-surface-variant/40">({botColor === "w" ? "White" : "Black"})</span>
              </p>
              <p className="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant/45 mt-2 mb-0.5">
                Turn
              </p>
              <p className="text-[13px] text-on-surface">
                {position.turn === myColor ? "Your move" : "Bot thinking\u2026"}
              </p>
            </div>
            <ArenaAbilityPanel
              rules={rules}
              position={position}
              myColor={myColor}
              onHover={setAbilityHighlight}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

/**
 * Random-mover. Optionally weights ability casts down a tiny
 * bit so the bot doesn't spend all its abilities in the first
 * few turns - keeps games more interesting. Not a real
 * evaluation function; just a heuristic.
 */
function pickBotMove(moves) {
  if (moves.length === 0) return null;
  // 70/30 split: prefer normal moves over abilities so the bot
  // doesn't burn through cast charges on turn 1.
  const normals = moves.filter((m) => m.kind !== "ability");
  const abilities = moves.filter((m) => m.kind === "ability");
  const pool = (abilities.length > 0 && Math.random() < 0.3 && normals.length > 0)
    ? abilities
    : normals.length > 0 ? normals : moves;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Compact human-readable summary of a bot move. Not full SAN
 * (the engine doesn't compute SAN for ability casts), just
 * enough so the user can see "knight to c6" or "queen casts
 * fireball on e5".
 */
function formatBotMove(move) {
  if (!move) return "?";
  if (move.kind === "ability") {
    const ab = move.abilityId ? `'${move.abilityId}'` : "ability";
    return `${(move.casterType || "?").toUpperCase()} ${ab} -> ${move.to}`;
  }
  // Plain move: piece-letter from-to with capture marker.
  const piece = move.piece ? move.piece.toUpperCase() : "";
  const sep = move.captured ? "x" : "-";
  return piece ? `${piece} ${move.from}${sep}${move.to}` : `${move.from}${sep}${move.to}`;
}

function findAbility(rules, casterType, abilityId, color) {
  if (!casterType || !abilityId) return null;
  const byColor = rules?.byColor?.[color]?.[casterType];
  if (byColor?.abilities) {
    const hit = byColor.abilities.find((a) => a.id === abilityId);
    if (hit) return hit;
  }
  const base = rules?.pieces?.[casterType];
  if (base?.abilities) {
    return base.abilities.find((a) => a.id === abilityId) || null;
  }
  return null;
}

function gameEndedHeadline(status, myColor) {
  if (status.winner === myColor) return "You win";
  if (status.winner && status.winner !== myColor) return "You lose";
  return "Draw";
}

function mergeHighlight(base, abilityHighlight, castFlash) {
  const out = { ...(base || {}) };
  if (abilityHighlight && abilityHighlight.length > 0) {
    for (const sq of abilityHighlight) {
      out[sq] = { ...(out[sq] || {}), backgroundColor: "rgba(245,158,11,0.32)" };
    }
  }
  if (castFlash) {
    out[castFlash.from] = { ...(out[castFlash.from] || {}), backgroundColor: "rgba(239,68,68,0.32)" };
    out[castFlash.to]   = { ...(out[castFlash.to] || {}),   backgroundColor: "rgba(239,68,68,0.45)" };
  }
  return out;
}
