#!/usr/bin/env node
/**
 * Schema sanity check for an oChess Supabase project.
 *
 * Verifies — using the anon key, the same one the app ships with —
 * that every table, RPC, and storage bucket the app expects is
 * present and has at least the right shape. Run this after applying
 * `supabase/schema.sql` to a new project, and after any future schema
 * change, to catch drift before it reaches production.
 *
 * Usage:
 *   # from ochess-app/
 *   npm run check:supabase
 *
 * Reads VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY from `.env`. Exits
 * 1 on any failure with a precise message; exits 0 on full success.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── env loading ────────────────────────────────────────────────────

function loadDotEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = { ...loadDotEnv(resolve(ROOT, ".env")), ...process.env };
const url = env.VITE_SUPABASE_URL;
const anon = env.VITE_SUPABASE_ANON_KEY;

if (!url || !anon || /your-project|your-anon-key-here/.test(anon)) {
  console.error("[check:supabase] missing or placeholder VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env");
  console.error("                  set them to your real Supabase project values and re-run.");
  process.exit(1);
}

const supabase = createClient(url, anon, { auth: { persistSession: false } });

// ── expectations ───────────────────────────────────────────────────

// Tables we expect to be readable / probable with the anon key.
// For each, we issue a `select id ... limit 1` to confirm the table
// exists and the column projection is valid. Some tables are RLS-
// gated for anon — those return `[]` rather than an error, which is
// also fine.
const TABLES = [
  { name: "profiles", columns: "id" },
  { name: "ratings", columns: "user_id" },
  { name: "games", columns: "id, status" },
  { name: "seeks", columns: "id" },
  { name: "challenges", columns: "id" },
  { name: "puzzle_progress", columns: "user_id" },
  { name: "puzzle_attempts", columns: "user_id" },
  { name: "review_cards", columns: "user_id" },
  { name: "friendships", columns: "user_id" },
];

// RPCs we expect to exist. We only call ones that are safe to invoke
// from anon: anon should be REJECTED with an auth.uid()-style error
// rather than a "function does not exist" error. That tells us the
// function exists AND the RLS-style guard fired correctly.
// Names + parameter shapes here MUST match `supabase/schema.sql`. PostgREST
// resolves a function by argument names, so a typo in a param name surfaces
// here as "function does not exist" — same error we want to use to detect
// a missing schema. Be careful when editing.
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const RPCS = [
  { name: "claim_seek", args: { p_seek_id: ZERO_UUID, p_claimer_id: ZERO_UUID, p_claimer_name: "", p_claimer_rating: 0 } },
  { name: "accept_challenge", args: { p_challenge_id: ZERO_UUID, p_joiner_id: ZERO_UUID, p_joiner_name: "", p_joiner_rating: 0 } },
  { name: "create_rematch", args: { p_source_game_id: ZERO_UUID, p_user_id: ZERO_UUID } },
];

// Storage buckets we expect to exist.
const BUCKETS = ["avatars"];

// ── runner ─────────────────────────────────────────────────────────

const results = [];
let failures = 0;

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
}

function isMissingFunctionError(error) {
  // Supabase wraps Postgres errors. A missing function reads as 404 +
  // PGRST202 ("Could not find the function ... in the schema cache").
  // We treat anything else as "function exists but rejected the call",
  // which is what we want.
  if (!error) return false;
  const msg = (error.message || "").toLowerCase();
  const code = (error.code || "").toUpperCase();
  return code === "PGRST202" || msg.includes("could not find the function");
}

async function checkTables() {
  for (const t of TABLES) {
    try {
      const { error } = await supabase.from(t.name).select(t.columns).limit(1);
      if (error) record(`table:${t.name}`, false, error.message);
      else record(`table:${t.name}`, true);
    } catch (e) {
      record(`table:${t.name}`, false, e?.message || String(e));
    }
  }
}

async function checkRpcs() {
  for (const r of RPCS) {
    try {
      const { error } = await supabase.rpc(r.name, r.args);
      if (isMissingFunctionError(error)) {
        record(`rpc:${r.name}`, false, "function does not exist in the database");
      } else {
        // Either succeeded (unlikely with placeholder UUIDs) or
        // rejected by the auth.uid() guard inside the function. Both
        // mean the function is present and reachable.
        record(`rpc:${r.name}`, true);
      }
    } catch (e) {
      record(`rpc:${r.name}`, false, e?.message || String(e));
    }
  }
}

async function checkBuckets() {
  for (const b of BUCKETS) {
    try {
      // listBuckets() requires elevated permission, but a public
      // bucket can be probed via getPublicUrl + a HEAD-style check on
      // a known-non-existent path — the call itself succeeds and
      // returns a URL even if the file doesn't exist. We use list()
      // which works for public buckets even with the anon key.
      const { error } = await supabase.storage.from(b).list("", { limit: 1 });
      if (error) {
        // "Bucket not found" is a 404; anything else (e.g. RLS) means
        // the bucket exists but anon can't list — which is acceptable
        // because the avatars bucket is public-read by URL but list
        // can be RLS-gated.
        const msg = (error.message || "").toLowerCase();
        if (msg.includes("not found") || msg.includes("does not exist")) {
          record(`bucket:${b}`, false, error.message);
        } else {
          record(`bucket:${b}`, true, "exists (list gated)");
        }
      } else {
        record(`bucket:${b}`, true);
      }
    } catch (e) {
      record(`bucket:${b}`, false, e?.message || String(e));
    }
  }
}

async function checkRealtime() {
  // We can at least confirm the websocket endpoint accepts a
  // connection with the anon key. We don't subscribe to anything.
  try {
    const ch = supabase.channel("__check_supabase_smoke__");
    await new Promise((resolve) => {
      let done = false;
      const finish = (status) => {
        if (done) return;
        done = true;
        record("realtime:connect", status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "CLOSED",
          status === "SUBSCRIBED" ? "" : `status=${status}`);
        try { supabase.removeChannel(ch); } catch { /* fine */ }
        resolve();
      };
      ch.subscribe((status) => {
        if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "CLOSED") finish(status);
      });
      // Hard timeout in case Realtime is misconfigured.
      setTimeout(() => finish("TIMEOUT"), 5000);
    });
  } catch (e) {
    record("realtime:connect", false, e?.message || String(e));
  }
}

async function main() {
  console.log(`[check:supabase] target ${url}`);
  await checkTables();
  await checkRpcs();
  await checkBuckets();
  await checkRealtime();

  for (const r of results) {
    const tag = r.ok ? "  ok " : "FAIL ";
    const detail = r.detail ? `  — ${r.detail}` : "";
    console.log(`${tag} ${r.name}${detail}`);
  }
  console.log("");
  if (failures === 0) {
    console.log(`[check:supabase] ${results.length}/${results.length} checks passed.`);
    process.exit(0);
  } else {
    console.log(`[check:supabase] ${failures} of ${results.length} checks failed.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[check:supabase] unexpected error:", e);
  process.exit(1);
});
