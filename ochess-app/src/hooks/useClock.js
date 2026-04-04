import { useState, useRef, useCallback, useEffect } from "react";

export default function useClock(initialMs, incrementMs = 0) {
  const white = useRef(initialMs);
  const black = useRef(initialMs);
  const active = useRef(null);
  const lastTick = useRef(null);
  const [display, setDisplay] = useState({ white: initialMs, black: initialMs });
  const [timedOut, setTimedOut] = useState(null);

  useEffect(() => {
    if (!initialMs) return;
    const id = setInterval(() => {
      if (!active.current || !lastTick.current) return;
      const now = Date.now();
      const elapsed = now - lastTick.current;
      lastTick.current = now;

      if (active.current === "w") {
        white.current = Math.max(0, white.current - elapsed);
        if (white.current <= 0) { setTimedOut("w"); active.current = null; }
      } else {
        black.current = Math.max(0, black.current - elapsed);
        if (black.current <= 0) { setTimedOut("b"); active.current = null; }
      }
      setDisplay({ white: white.current, black: black.current });
    }, 100);
    return () => clearInterval(id);
  }, [initialMs]);

  const start = useCallback((side) => {
    active.current = side;
    lastTick.current = Date.now();
  }, []);

  const switchSide = useCallback(() => {
    if (!active.current || !lastTick.current) return;
    const now = Date.now();
    const elapsed = now - lastTick.current;
    const side = active.current;

    if (side === "w") {
      white.current = Math.max(0, white.current - elapsed) + incrementMs;
    } else {
      black.current = Math.max(0, black.current - elapsed) + incrementMs;
    }

    active.current = side === "w" ? "b" : "w";
    lastTick.current = now;
    setDisplay({ white: white.current, black: black.current });
  }, [incrementMs]);

  const stop = useCallback(() => {
    if (active.current && lastTick.current) {
      const elapsed = Date.now() - lastTick.current;
      if (active.current === "w") white.current = Math.max(0, white.current - elapsed);
      else black.current = Math.max(0, black.current - elapsed);
    }
    active.current = null;
    lastTick.current = null;
    setDisplay({ white: white.current, black: black.current });
  }, []);

  const reset = useCallback((ms) => {
    white.current = ms;
    black.current = ms;
    active.current = null;
    lastTick.current = null;
    setTimedOut(null);
    setDisplay({ white: ms, black: ms });
  }, []);

  return { display, timedOut, start, switchSide, stop, reset };
}

export function formatTime(ms) {
  if (ms == null || ms <= 0) return "0:00";
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
