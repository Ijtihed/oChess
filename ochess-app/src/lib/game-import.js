/**
 * Game import connectors for Lichess and Chess.com.
 * All requests go directly to public APIs - no backend needed.
 *
 * Imports are hard-capped at MAX_IMPORT_GAMES so a heavy account
 * (10k+ games) doesn't OOM the browser tab. The cap is exposed on
 * the result object so the UI can surface a "showing the most
 * recent N games" notice when it kicks in.
 *
 * Per-source client-side throttle: each source can be hit at most
 * MAX_CALLS_PER_HOUR times in a rolling hour from the same browser.
 * This is a courtesy to Lichess / chess.com (whose terms ask
 * downstream apps not to flood their public APIs) and a guard
 * against an accidental tight loop in our own UI. State lives in
 * localStorage so a refresh can't reset the counter trivially.
 *
 * NOTE: this is NOT a security boundary - a determined user can
 * clear localStorage. A real backend rate-limit (Edge Function
 * proxy + postgres counters) would be the next step at scale.
 */

export const MAX_IMPORT_GAMES = 5000;
const MAX_CALLS_PER_HOUR = 8;
const THROTTLE_KEY = "ochess_import_throttle";

function readThrottleLog() {
  try {
    const raw = JSON.parse(localStorage.getItem(THROTTLE_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

function writeThrottleLog(log) {
  try { localStorage.setItem(THROTTLE_KEY, JSON.stringify(log)); } catch {}
}

/**
 * Throws a friendly error if the caller has already hit the
 * per-hour cap for this source. Otherwise records the call and
 * returns. Exported for tests; callers normally just call the
 * fetch* functions which invoke this internally.
 */
export function checkImportThrottle(source, now = Date.now()) {
  const log = readThrottleLog();
  const cutoff = now - 60 * 60 * 1000;
  const prior = (log[source] || []).filter((ts) => Number.isFinite(ts) && ts > cutoff);
  if (prior.length >= MAX_CALLS_PER_HOUR) {
    const oldest = prior[0];
    const minutes = Math.max(1, Math.ceil((oldest + 60 * 60 * 1000 - now) / 60_000));
    const err = new Error(
      `Slow down - ${source} import limit is ${MAX_CALLS_PER_HOUR}/hour from this browser. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`
    );
    err.name = "RateLimitError";
    throw err;
  }
  prior.push(now);
  writeThrottleLog({ ...log, [source]: prior });
}

export async function fetchLichessGames(username, { signal, onProgress, max = MAX_IMPORT_GAMES } = {}) {
  checkImportThrottle("lichess");
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?pgnInJson=true&clocks=false&evals=false&opening=true&max=${Math.max(1, max)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/x-ndjson" },
    signal,
  });
  if (res.status === 404) throw new Error(`Lichess user "${username}" not found.`);
  if (!res.ok) throw new Error(`Lichess returned ${res.status}`);

  const games = [];
  let truncated = false;
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    for (const line of text.split("\n").filter((l) => l.trim())) {
      if (games.length >= max) { truncated = true; break; }
      try { pushLichessGame(games, JSON.parse(line)); } catch {}
    }
    games.truncated = truncated;
    return games;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (games.length >= max) { truncated = true; break outer; }
      try {
        pushLichessGame(games, JSON.parse(line));
        onProgress?.(games.length);
      } catch {}
    }
  }
  if (!truncated && buffer.trim() && games.length < max) {
    try { pushLichessGame(games, JSON.parse(buffer)); onProgress?.(games.length); } catch {}
  }
  // Best-effort cancel of the stream once we've capped, so we don't
  // keep a fetch open in the background.
  if (truncated) { try { reader.cancel(); } catch {} }
  games.truncated = truncated;
  return games;
}

function pushLichessGame(games, obj) {
  if (!obj.pgn) return;
  games.push({
    pgn: obj.pgn,
    id: obj.id,
    white: obj.players?.white?.user?.name || "?",
    black: obj.players?.black?.user?.name || "?",
    result: obj.winner === "white" ? "1-0" : obj.winner === "black" ? "0-1" : obj.status === "draw" ? "1/2-1/2" : "*",
    date: obj.createdAt ? new Date(obj.createdAt).toLocaleDateString() : "",
    opening: obj.opening?.name || "",
    speed: obj.speed || "",
    // Lichess JSON variant: "standard", "chess960", "fromPosition",
    // "atomic", "antichess", etc. Threaded through so the
    // import filter can drop variant games before they reach
    // chess.js's standard-rules replay.
    variant: obj.variant || "",
    perfType: obj.perf || "",
    source: "lichess",
    url: `https://lichess.org/${obj.id}`,
  });
}

// Per-call cap on chess.com archive pages we fetch in one import.
// A heavy player's account can have 100+ archive months; walking
// all of them sequentially is slow and impolite to chess.com when
// the user only wanted (say) their last 200 games. We stop after
// MAX_ARCHIVE_MONTHS regardless of whether `max` was met. The cap
// is deliberately generous: ~3 years of monthly archives covers
// the vast majority of corpora the post-game-loop cares about.
const MAX_ARCHIVE_MONTHS = 36;

export async function fetchChesscomGames(username, { signal, onProgress, max = MAX_IMPORT_GAMES } = {}) {
  checkImportThrottle("chesscom");
  const archivesRes = await fetch(
    `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/archives`,
    { signal }
  );
  if (archivesRes.status === 404) throw new Error(`Chess.com user "${username}" not found.`);
  if (!archivesRes.ok) throw new Error(`Chess.com returned ${archivesRes.status}`);

  let archives;
  try { archives = (await archivesRes.json()).archives; } catch { throw new Error("Invalid response from Chess.com."); }
  if (!archives || archives.length === 0) throw new Error(`No games found for "${username}".`);

  const games = [];
  let truncated = false;
  let monthsFetched = 0;

  for (let i = archives.length - 1; i >= 0; i--) {
    if (signal?.aborted) break;
    if (games.length >= max) { truncated = true; break; }
    if (monthsFetched >= MAX_ARCHIVE_MONTHS) { truncated = true; break; }
    monthsFetched++;
    const res = await fetch(archives[i], { signal });
    if (!res.ok) continue;
    const data = await res.json();
    if (!data.games) continue;

    for (let j = data.games.length - 1; j >= 0; j--) {
      if (games.length >= max) { truncated = true; break; }
      const g = data.games[j];
      if (!g.pgn) continue;
      games.push({
        pgn: g.pgn,
        id: g.url?.split("/").pop() || String(games.length),
        white: g.white?.username || "?",
        black: g.black?.username || "?",
        result: g.white?.result === "win" ? "1-0" : g.black?.result === "win" ? "0-1" : "1/2-1/2",
        date: g.end_time ? new Date(g.end_time * 1000).toLocaleDateString() : "",
        opening: g.pgn.match(/\[ECOUrl ".*\/(.+?)"\]/)?.[1]?.replace(/-/g, " ") || "",
        speed: g.time_class || "",
        // Chess.com archive `rules` field: "chess" for standard,
        // "chess960", "kingofthehill", "threecheck", "crazyhouse",
        // "bughouse", "oddschess", etc. We thread it through so
        // the filter can drop variant games. Falls back to the
        // PGN [Variant] tag check if absent.
        variant: g.rules || "",
        source: "chesscom",
        url: g.url || "",
      });
    }
    onProgress?.(games.length, archives.length - i, archives.length);
  }
  games.truncated = truncated;
  return games;
}

// Hard limits on file imports. The API import paths use
// MAX_IMPORT_GAMES (5000); file uploads need their own ceilings
// because there's no per-API throttle to keep the parser polite.
//   - PARSE_MAX_BYTES  - 8MB. Caps memory blow-up from a malicious
//                        or misformed file (e.g. a 50MB log of
//                        randomly-permuted "[Event" tags).
//   - PARSE_MAX_GAMES  - 5000. Matches MAX_IMPORT_GAMES so the
//                        downstream filter / persist path doesn't
//                        have to cope with surprise volumes.
const PARSE_MAX_BYTES = 8 * 1024 * 1024;
const PARSE_MAX_GAMES = 5000;

export function parsePgnFile(text) {
  if (typeof text !== "string") return [];
  // The .length here is a code-unit count, which is a safe upper
  // bound on the encoded byte size (UTF-16 -> UTF-8 never grows
  // past 4x for BMP text and the cap is generous enough that
  // bytes-vs-code-units doesn't matter).
  if (text.length > PARSE_MAX_BYTES) {
    text = text.slice(0, PARSE_MAX_BYTES);
  }

  const games = [];
  const chunks = text.split(/\n\n(?=\[)/);

  let buffer = "";
  for (const chunk of chunks) {
    if (games.length >= PARSE_MAX_GAMES) {
      games.truncated = true;
      return games;
    }
    buffer += (buffer ? "\n\n" : "") + chunk;
    if (buffer.includes("[Event") && /\d\s+(1-0|0-1|1\/2-1\/2|\*)/.test(buffer)) {
      const white = buffer.match(/\[White "(.+?)"\]/)?.[1] || "?";
      const black = buffer.match(/\[Black "(.+?)"\]/)?.[1] || "?";
      const result = buffer.match(/\[Result "(.+?)"\]/)?.[1] || "*";
      const date = buffer.match(/\[Date "(.+?)"\]/)?.[1] || "";
      const event = buffer.match(/\[Event "(.+?)"\]/)?.[1] || "";
      const opening = buffer.match(/\[Opening "(.+?)"\]/)?.[1] || "";
      games.push({
        pgn: buffer.trim(),
        id: String(games.length),
        white,
        black,
        result,
        date,
        opening: opening || event,
        speed: "",
        source: "file",
        url: "",
      });
      buffer = "";
    }
  }
  if (buffer.trim() && buffer.includes("[Event") && games.length < PARSE_MAX_GAMES) {
    const white = buffer.match(/\[White "(.+?)"\]/)?.[1] || "?";
    const black = buffer.match(/\[Black "(.+?)"\]/)?.[1] || "?";
    const result = buffer.match(/\[Result "(.+?)"\]/)?.[1] || "*";
    games.push({ pgn: buffer.trim(), id: String(games.length), white, black, result, date: "", opening: "", speed: "", source: "file", url: "" });
  }
  return games;
}
