#!/usr/bin/env node
/**
 * Trim the 1 GB Lichess puzzle CSV down to a committed, deployable
 * subset.
 *
 * Why this exists:
 * - `lichess_db_puzzle.csv` from database.lichess.org is ~1 GB
 *   (~3.7 M puzzles) — too big to commit, too big for a Vercel
 *   deploy bundle (Vercel caps single static assets at 100 MB).
 * - For a hobby chess app, 10 000 puzzles is more than enough; even
 *   a heavy user solves a few hundred a year.
 *
 * Strategy:
 * - Stream through the source CSV line by line.
 * - Keep puzzles whose popularity score is >= POPULARITY_FLOOR.
 * - Reservoir-sample down to TARGET if we still have too many.
 * - Write the result to `public/puzzledb/puzzles.csv`, which the app
 *   loader fetches at runtime (see `src/lib/puzzles.js`).
 *
 * Usage:
 *   # Place lichess_db_puzzle.csv in ochess-app/public/puzzledb/
 *   # then from ochess-app/:
 *   node scripts/trim-puzzles.mjs
 *
 * Re-run any time you want to refresh the committed sample.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SRC = resolve(ROOT, "public/puzzledb/lichess_db_puzzle.csv");
const DST = resolve(ROOT, "public/puzzledb/puzzles.csv");
const TARGET = 10_000;
const POPULARITY_FLOOR = 80; // Lichess popularity is in [-100, 100].

if (!existsSync(SRC)) {
  console.error(`[trim-puzzles] missing source: ${SRC}`);
  console.error(`               download from https://database.lichess.org/#puzzles and place in public/puzzledb/`);
  process.exit(1);
}

const sizeMb = (statSync(SRC).size / (1024 * 1024)).toFixed(1);
console.log(`[trim-puzzles] source ${SRC} (${sizeMb} MB)`);
console.log(`[trim-puzzles] target ${TARGET} puzzles, popularity >= ${POPULARITY_FLOOR}`);

const reservoir = [];
let header = null;
let totalKept = 0;
let totalScanned = 0;

const stream = createReadStream(SRC, { encoding: "utf8" });
const rl = createInterface({ input: stream, crlfDelay: Infinity });

for await (const line of rl) {
  if (!line) continue;
  if (header === null) { header = line; continue; }
  totalScanned += 1;
  const cols = line.split(",");
  // CSV columns: PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,...
  const popularity = parseInt(cols[5]);
  if (!Number.isFinite(popularity) || popularity < POPULARITY_FLOOR) continue;
  totalKept += 1;
  // Reservoir sampling: keep first TARGET, then replace at random.
  if (reservoir.length < TARGET) {
    reservoir.push(line);
  } else {
    const j = Math.floor(Math.random() * totalKept);
    if (j < TARGET) reservoir[j] = line;
  }
}

console.log(`[trim-puzzles] scanned ${totalScanned.toLocaleString()} puzzles, kept ${totalKept.toLocaleString()}, sampled ${reservoir.length.toLocaleString()}`);

const out = header + "\n" + reservoir.join("\n") + "\n";
await writeFile(DST, out, "utf8");
const dstSizeKb = (Buffer.byteLength(out) / 1024).toFixed(1);
console.log(`[trim-puzzles] wrote ${DST} (${dstSizeKb} KB)`);
