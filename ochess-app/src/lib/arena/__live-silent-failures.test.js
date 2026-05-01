/**
 * Live-AI stress test for the silent-failure fix.
 *
 * For each prompt, generate a variant via Gemini, then enumerate
 * EVERY ability move available from the starting position (and
 * 4 plies of random play after) and call applyMove on each one.
 * Count any VariantError throws. Zero is the bar.
 *
 * Without the silent-failure fix in move-gen.js, the AI would
 * regularly emit abilities where move-gen offers crosshairs the
 * resolver then rejects ("spawn: target is not empty",
 * "displace: no piece at target", etc). The fix makes move-gen
 * combine effect-kind-implied requirements with the AI's
 * declared filters.
 *
 * This test is the empirical confirmation that the fix holds in
 * real generated variants, not just hand-crafted unit tests.
 *
 * Skipped by default. Run with:
 *   GEMINI_API_KEY=... RUN_LIVE_AI=1 npx vitest run \
 *     src/lib/arena/__live-silent-failures.test.js
 *
 * Cost: ~$0.005 per batch (5 prompts @ flash pricing).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Position } from "./position";
import { resolveRules } from "./rules";
import { generateLegalMoves } from "./move-gen";
import { applyMove } from "./apply-move";
import { validateRules } from "./validator";
import { verifyRules } from "./verification";
import { repairRules } from "./repair";

const skip = process.env.RUN_LIVE_AI !== "1";

describe.skipIf(skip)("live-AI silent-failure stress test", () => {
  it("zero VariantError throws when applying every legal ability move", async () => {
    const KEY = process.env.GEMINI_API_KEY;
    if (!KEY) throw new Error("GEMINI_API_KEY not set");
    const MODEL = process.env.MODEL || "gemini-2.5-flash";

    // Prompts intentionally chosen to trigger non-destroy effects
    // (spawn / displace / transform / mark) - those are the
    // primitives where silent failures used to fire.
    const PROMPTS = [
      { label: "spawn-bishop", prompt: "Bishop necromancer that summons a friendly pawn on any empty square within 3 squares. Pawns last 8 turns. 2 charges, 6-turn cooldown." },
      { label: "displace-knight", prompt: "Knight that can shove a friendly pawn forward up to 6 squares, knocking out any pieces in its path." },
      { label: "transform-bishop", prompt: "Bishop that can charm an enemy piece for 4 turns, making it fight on their side. Once per match." },
      { label: "mark-queen", prompt: "Frost mage queen that freezes any enemy she targets for 2 turns. 3 charges, 4-turn cooldown." },
      { label: "blink-rook", prompt: "Rook that can teleport to any empty square within 4 squares. Once per match per rook." },
    ];

    // ── Lift the system prompt + planner prompt from source ──
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const SRC = fs.readFileSync(
      path.resolve(__dirname, "../../../../supabase/functions/arena_rules/index.ts"),
      "utf8",
    );
    const extractTemplate = (varName) => {
      const m = SRC.match(new RegExp(`const\\s+${varName}\\s*=\\s*\`([\\s\\S]*?)\`;`));
      if (!m) throw new Error(`could not find ${varName}`);
      return m[1];
    };
    const SYSTEM_PROMPT = extractTemplate("SYSTEM_PROMPT");
    const PLANNER_SYSTEM_PROMPT = extractTemplate("PLANNER_SYSTEM_PROMPT");

    // ── Gemini wrapper ──
    async function callGemini(systemPrompt, userPrompt, opts = {}) {
      const url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
      const resp = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
          temperature: opts.temperature ?? 0.95,
          max_tokens: opts.maxTokens ?? 16000,
        }),
      });
      if (!resp.ok) throw new Error(`Gemini ${resp.status}`);
      const json = await resp.json();
      return json?.choices?.[0]?.message?.content || "";
    }

    function tolerantParse(content) {
      const trimmed = content.trim();
      try { return JSON.parse(trimmed); } catch {}
      let cleaned = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      try { return JSON.parse(cleaned); } catch {}
      cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1");
      return JSON.parse(cleaned);
    }

    /**
     * For one set of resolved rules, walk a few plies of legal
     * play and try EVERY ability move available at each step.
     * Return the count of VariantErrors thrown.
     */
    function stressApplyAbilities(rules) {
      let throws = 0;
      const startedAt = Date.now();
      const totalCasts = [];
      const PLY_DEPTH = 6; // 3 turns per side - covers turn 1 + a few common second-ply patterns
      const SAMPLES = 4;

      for (let s = 0; s < SAMPLES; s++) {
        let pos = Position.fromFen(rules.startingFen);
        for (let p = 0; p < PLY_DEPTH; p++) {
          const legal = generateLegalMoves(pos, rules);
          if (legal.length === 0) break;
          // Try EVERY ability move at this ply on a clone before
          // we pick a move to advance with.
          const abilityMoves = legal.filter((m) => m.kind === "ability");
          for (const ab of abilityMoves) {
            try {
              applyMove(pos, ab, rules);
              totalCasts.push({ ok: true, from: ab.from, to: ab.to, abilityId: ab.abilityId });
            } catch (e) {
              throws++;
              totalCasts.push({ ok: false, from: ab.from, to: ab.to, abilityId: ab.abilityId, err: e?.message || String(e) });
            }
          }
          // Pick a move to actually advance with (random).
          const pick = legal[Math.floor(Math.random() * legal.length)];
          try { pos = applyMove(pos, pick, rules); }
          catch { break; }
        }
      }

      return { throws, totalCasts: totalCasts.length, attempts: totalCasts, elapsedMs: Date.now() - startedAt };
    }

    const results = [];
    for (const p of PROMPTS) {
      console.log(`\n══ ${p.label} ══`);
      console.log(`  prompt: ${p.prompt.slice(0, 80)}…`);

      // Planner (best-effort).
      let plannerVibe = null;
      try {
        const pc = await callGemini(
          PLANNER_SYSTEM_PROMPT,
          `User's variant description:\n"""\n${p.prompt}\n"""\n\nReply with the JSON object.`,
          { temperature: 0.9, maxTokens: 500 },
        );
        const parsed = tolerantParse(pc);
        if (parsed?.fighting_style && parsed?.signature_mechanic && parsed?.under_pressure) {
          plannerVibe = parsed;
        }
      } catch { /* planner is non-fatal */ }

      // Factory.
      const userPrompt = `User's variant description:\n"""\n${p.prompt}\n"""\n${plannerVibe ? `\nDesign brief:\n- ${plannerVibe.fighting_style}\n- ${plannerVibe.signature_mechanic}\n- ${plannerVibe.under_pressure}\n` : ""}\nProduce a JSON rule diff. ONLY the JSON.`;
      let content;
      try { content = await callGemini(SYSTEM_PROMPT, userPrompt); }
      catch (e) { console.log(`  factory failed: ${e.message}`); continue; }
      let rulesDiff;
      try { rulesDiff = tolerantParse(content); }
      catch (e) { console.log(`  parse failed: ${e.message}`); continue; }

      // Structural validate.
      const structural = validateRules(rulesDiff);
      if (!structural.valid) {
        console.log(`  structural rejected: ${structural.errors.slice(0, 2).join("; ")}`);
        continue;
      }

      // Verify + repair (the full pipeline the client uses).
      let workingRules = rulesDiff;
      let report = verifyRules(rulesDiff);
      if (!report.ok) {
        const { repaired } = repairRules(rulesDiff, report);
        workingRules = repaired;
        report = verifyRules(workingRules);
      }
      const resolved = resolveRules(workingRules);

      // Stress test.
      const stress = stressApplyAbilities(resolved);
      console.log(`  abilities tested: ${stress.totalCasts}`);
      console.log(`  VariantError throws: ${stress.throws}`);
      console.log(`  ${stress.elapsedMs}ms elapsed`);
      if (stress.throws > 0) {
        console.log(`  ⚠ THROW DETAIL:`);
        for (const a of stress.attempts.filter((x) => !x.ok).slice(0, 3)) {
          console.log(`    - ${a.from}->${a.to} (${a.abilityId}): ${a.err}`);
        }
      }
      results.push({ label: p.label, ...stress });
    }

    const totalThrows = results.reduce((a, r) => a + r.throws, 0);
    const totalAttempts = results.reduce((a, r) => a + r.totalCasts, 0);
    console.log(`\n══ STRESS SUMMARY ══`);
    console.log(`  ${results.length} variants tested`);
    console.log(`  ${totalAttempts} total ability casts attempted`);
    console.log(`  ${totalThrows} VariantError throws (target: 0)`);

    expect(totalThrows).toBe(0);
  }, 600_000);
});
