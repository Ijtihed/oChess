/**
 * ArenaVisualDebugPanel - small in-room widget that surfaces
 * AI-painted visual errors so we can iterate on prompt + AST
 * validator without needing to dig through DB tables.
 *
 * Visible only when:
 *   - The user has the `crazy_arena_lab` flag (so it's
 *     hidden from regular players who shouldn't see internal
 *     debug info), AND
 *   - At least one draw error has been recorded for the
 *     current room.
 *
 * UX:
 *   - Small chip at the bottom-right corner of the board
 *     showing the count of recent errors.
 *   - Clicking expands a popover listing the last ~10 errors:
 *     slot, message, ply, time. Click an entry to see the
 *     stack trace.
 *   - "Disable visuals for this room" button: sets a per-room
 *     localStorage flag that the overlay reads on next mount.
 *     Useful when one bad slot is making the rest of the
 *     game unplayable.
 *   - "Copy errors as JSON" button: dumps the buffer for
 *     pasting into a bug report.
 *
 * The panel is OFFLINE-FIRST - it reads from the in-memory
 * ring buffer (visuals-error-buffer.js), not the DB. The DB
 * audit log is for historic analysis; the panel is for "what
 * just broke?".
 */

import { useState, useSyncExternalStore } from "react";
import {
  getVisualErrors,
  subscribeToVisualErrors,
  clearVisualErrors,
} from "../lib/arena/visuals-error-buffer";

export default function ArenaVisualDebugPanel({ roomId, isLabUser, onDisableVisuals }) {
  const errors = useSyncExternalStore(
    (cb) => subscribeToVisualErrors(roomId, cb),
    () => getVisualErrors(roomId),
    () => [],
  );
  const [expanded, setExpanded] = useState(false);
  const [activeIdx, setActiveIdx] = useState(null);

  if (!isLabUser) return null;
  if (!errors || errors.length === 0) return null;

  const slotsAffected = new Set(errors.map((e) => e.slot));

  return (
    <div className="absolute bottom-2 right-2 z-[3] pointer-events-auto select-none">
      {!expanded ? (
        <button
          type="button"
          className="rounded-full bg-amber-500/90 hover:bg-amber-500 text-black text-xs font-bold px-3 py-1 shadow"
          onClick={() => setExpanded(true)}
          title={`${errors.length} draw error${errors.length === 1 ? "" : "s"} (${slotsAffected.size} slot${slotsAffected.size === 1 ? "" : "s"})`}
        >
          ! {errors.length} draw error{errors.length === 1 ? "" : "s"}
        </button>
      ) : (
        <div className="rounded-md bg-zinc-900/95 border border-amber-700/40 shadow-2xl text-zinc-100 text-xs w-[26rem] max-w-[80vw]">
          <header className="flex items-center justify-between px-3 py-2 border-b border-zinc-700">
            <span className="font-semibold text-amber-300">
              Visual debug ({errors.length})
            </span>
            <button
              type="button"
              className="text-zinc-400 hover:text-zinc-200"
              onClick={() => setExpanded(false)}
            >
              x
            </button>
          </header>
          <ul className="max-h-64 overflow-y-auto divide-y divide-zinc-800">
            {errors.slice().reverse().map((err, i) => {
              const idx = errors.length - 1 - i;
              const isActive = activeIdx === idx;
              return (
                <li key={idx} className="px-3 py-1.5">
                  <button
                    type="button"
                    className="w-full text-left flex items-baseline justify-between gap-2"
                    onClick={() => setActiveIdx(isActive ? null : idx)}
                  >
                    <span className="font-mono text-amber-200">{err.slot}</span>
                    <span className="text-zinc-400 text-[10px]">
                      ply {err.ply ?? "?"}
                    </span>
                  </button>
                  <p className="font-mono text-[11px] text-zinc-300 truncate">
                    {err.message}
                  </p>
                  {isActive && err.stack ? (
                    <pre className="mt-1 text-[10px] text-zinc-500 whitespace-pre-wrap break-words leading-tight">
{err.stack}
                    </pre>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <footer className="flex items-center justify-between gap-2 px-3 py-2 border-t border-zinc-700 bg-zinc-950/40">
            <button
              type="button"
              className="text-[11px] text-zinc-300 hover:text-zinc-100 underline-offset-2 hover:underline"
              onClick={() => {
                const blob = JSON.stringify(errors, null, 2);
                navigator.clipboard?.writeText(blob).catch(() => {});
              }}
            >
              copy as json
            </button>
            <button
              type="button"
              className="text-[11px] text-zinc-300 hover:text-zinc-100 underline-offset-2 hover:underline"
              onClick={() => clearVisualErrors(roomId)}
            >
              clear
            </button>
            <button
              type="button"
              className="text-[11px] text-amber-300 hover:text-amber-100 underline-offset-2 hover:underline"
              onClick={() => {
                if (typeof onDisableVisuals === "function") onDisableVisuals();
                setExpanded(false);
              }}
            >
              disable visuals
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
