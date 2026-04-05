/**
 * Converts Lichess chess-openings TSV files to a JSON lookup keyed by UCI moves.
 * Run: node scripts/build-openings.mjs
 */
import { Chess } from "chess.js";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const publicDir = join(import.meta.dirname, "..", "public");
const files = ["a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv"];

const book = {};

for (const file of files) {
  const raw = readFileSync(join(publicDir, file), "utf-8");
  const lines = raw.split("\n").slice(1); // skip header

  for (const line of lines) {
    if (!line.trim()) continue;
    const [eco, name, pgn] = line.split("\t");
    if (!pgn || !name) continue;

    try {
      const chess = new Chess();
      const moves = pgn.replace(/\d+\.\s*/g, "").trim().split(/\s+/);
      const uciMoves = [];

      for (const san of moves) {
        if (!san || san === "*") break;
        const result = chess.move(san);
        if (!result) break;
        uciMoves.push(result.from + result.to + (result.promotion || ""));
      }

      if (uciMoves.length > 0) {
        const key = uciMoves.join(",");
        book[key] = name;
      }
    } catch {
      // skip broken entries
    }
  }
}

const outPath = join(publicDir, "openings.json");
writeFileSync(outPath, JSON.stringify(book));
console.log(`Written ${Object.keys(book).length} openings to ${outPath}`);
console.log(`File size: ${(readFileSync(outPath).length / 1024).toFixed(1)} KB`);
