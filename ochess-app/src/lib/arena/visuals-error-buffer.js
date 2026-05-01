/**
 * Per-room in-memory ring buffer of draw errors.
 *
 * The arena_visual_errors DB table is the source of truth for
 * historic analysis. The debug panel doesn't query it on every
 * render though - that would be N+1 round-trips per error. So
 * we also keep a small local buffer that the panel reads
 * synchronously.
 *
 * Capped at 32 entries per room. On overflow the oldest is
 * dropped (FIFO). Cleared on room change.
 *
 * Subscribers can listen for buffer mutations to trigger a
 * re-render of the debug panel.
 */

const MAX_ENTRIES = 32;
const buffers = new Map();        // roomId -> { entries, listeners }

/**
 * Push a draw error into the buffer for the given room.
 * Notifies all subscribers.
 */
export function pushVisualError(roomId, err) {
  if (!roomId) return;
  let bucket = buffers.get(roomId);
  if (!bucket) {
    bucket = { entries: [], listeners: new Set() };
    buffers.set(roomId, bucket);
  }
  const entry = {
    slot: String(err?.slot || "unknown"),
    message: String(err?.message || ""),
    stack: err?.stack ? String(err.stack) : "",
    ply: Number.isFinite(err?.ply) ? err.ply : null,
    at: Date.now(),
  };
  bucket.entries.push(entry);
  if (bucket.entries.length > MAX_ENTRIES) {
    bucket.entries.shift();
  }
  for (const fn of bucket.listeners) {
    try { fn(); } catch { /* swallow */ }
  }
}

/**
 * Get a snapshot of the buffer for the given room. Returns a
 * NEW array each call so React's reference equality fires.
 */
export function getVisualErrors(roomId) {
  const bucket = buffers.get(roomId);
  if (!bucket) return [];
  return [...bucket.entries];
}

/**
 * Subscribe to buffer mutations for the given room. Returns
 * an unsubscribe function. Useful for `useSyncExternalStore`-
 * shaped hooks.
 */
export function subscribeToVisualErrors(roomId, listener) {
  if (!roomId || typeof listener !== "function") return () => {};
  let bucket = buffers.get(roomId);
  if (!bucket) {
    bucket = { entries: [], listeners: new Set() };
    buffers.set(roomId, bucket);
  }
  bucket.listeners.add(listener);
  return () => {
    bucket.listeners.delete(listener);
  };
}

/**
 * Clear the buffer for a room (e.g. on room unmount or
 * variant regenerate).
 */
export function clearVisualErrors(roomId) {
  buffers.delete(roomId);
}
