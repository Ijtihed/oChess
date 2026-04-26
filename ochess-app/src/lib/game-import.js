/**
 * Game import connectors for Lichess and Chess.com.
 * All requests go directly to public APIs — no backend needed.
 */

export async function fetchLichessGames(username, { signal, onProgress } = {}) {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?pgnInJson=true&clocks=false&evals=false&opening=true`;
  const res = await fetch(url, {
    headers: { Accept: "application/x-ndjson" },
    signal,
  });
  if (res.status === 404) throw new Error(`Lichess user "${username}" not found.`);
  if (!res.ok) throw new Error(`Lichess returned ${res.status}`);

  const games = [];
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    for (const line of text.split("\n").filter((l) => l.trim())) {
      try { pushLichessGame(games, JSON.parse(line)); } catch {}
    }
    return games;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        pushLichessGame(games, JSON.parse(line));
        onProgress?.(games.length);
      } catch {}
    }
  }
  if (buffer.trim()) {
    try { pushLichessGame(games, JSON.parse(buffer)); onProgress?.(games.length); } catch {}
  }
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
    source: "lichess",
    url: `https://lichess.org/${obj.id}`,
  });
}

export async function fetchChesscomGames(username, { signal, onProgress } = {}) {
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

  for (let i = archives.length - 1; i >= 0; i--) {
    if (signal?.aborted) break;
    const res = await fetch(archives[i], { signal });
    if (!res.ok) continue;
    const data = await res.json();
    if (!data.games) continue;

    for (let j = data.games.length - 1; j >= 0; j--) {
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
        source: "chesscom",
        url: g.url || "",
      });
    }
    onProgress?.(games.length, archives.length - i, archives.length);
  }
  return games;
}

export function parsePgnFile(text) {
  const games = [];
  const chunks = text.split(/\n\n(?=\[)/);

  let buffer = "";
  for (const chunk of chunks) {
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
  if (buffer.trim() && buffer.includes("[Event")) {
    const white = buffer.match(/\[White "(.+?)"\]/)?.[1] || "?";
    const black = buffer.match(/\[Black "(.+?)"\]/)?.[1] || "?";
    const result = buffer.match(/\[Result "(.+?)"\]/)?.[1] || "*";
    games.push({ pgn: buffer.trim(), id: String(games.length), white, black, result, date: "", opening: "", speed: "", source: "file", url: "" });
  }
  return games;
}
