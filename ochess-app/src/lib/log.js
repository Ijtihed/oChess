/**
 * Lightweight logging helpers gated by build mode.
 *
 * `dlog` and `dwarn` only emit when running under Vite's dev server
 * (`import.meta.env.DEV === true`) or when the `VITE_DEBUG` env var
 * is set, so production users don't see the firehose of `[friends]`
 * / `[online-game]` / `[play]` traces that we use during development.
 *
 * Errors always log — they're rare and useful for crash reports.
 */

const enabled =
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV) ||
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_DEBUG === "true");

export function makeLogger(tag) {
  const prefix = tag ? `[${tag}]` : "";
  return {
    log(...args) {
      if (!enabled) return;
      if (prefix) console.log(prefix, ...args);
      else console.log(...args);
    },
    warn(...args) {
      if (!enabled) return;
      if (prefix) console.warn(prefix, ...args);
      else console.warn(...args);
    },
    error(...args) {
      // Errors always log so prod crash reports are not silent.
      if (prefix) console.error(prefix, ...args);
      else console.error(...args);
    },
  };
}

export const isDebugEnabled = () => enabled;
