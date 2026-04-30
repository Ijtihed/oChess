/**
 * Test wrapper for the live Gemini test harness. Vitest resolves
 * ESM imports the same way Vite does (bare relative paths without
 * .js suffixes), which the harness's deeper imports rely on. We
 * just import the harness module-by-module here and drive it via
 * a single test that prints results to console.
 *
 * NOT a unit test - this calls live Gemini and costs real money.
 * Skipped by default; opt in with RUN_LIVE_AI=1 in env.
 *
 *   GEMINI_API_KEY=... RUN_LIVE_AI=1 npx vitest run scripts/test-arena-prompts.test.js
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Position } from "./position";
import { resolveRules } from "./rules";
import { generateLegalMoves } from "./move-gen";
import { applyMove } from "./apply-move";
import { checkGameStatus } from "./win-check";
import { validateRules } from "./validator";
import { describeRules } from "./rule-preview";

const skip = process.env.RUN_LIVE_AI !== "1";

describe.skipIf(skip)("arena_rules live AI behaviour", () => {
  it("runs a small batch of prompts and reports findings", async () => {
    const KEY = process.env.GEMINI_API_KEY;
    if (!KEY) throw new Error("GEMINI_API_KEY not set");
    const MODEL = process.env.MODEL || "gemini-2.5-flash";
    const LIMIT = Number(process.env.LIMIT) || 0;

    const PROMPTS = [
      { label: "fireball-queen", prompt: "Wizard queen that throws fireballs at any enemy 4 squares away. 3 charges, 4-turn cooldown.", expect: { hasAbility: ["q"], minCastableFromStart: 1, mustEverFire: true } },
      { label: "frost-mage", prompt: "Frost mage queen that freezes any enemy she targets for 2 turns. 3 charges, 4-turn cooldown. Frozen pieces can't move.", expect: { hasAbility: ["q"], minCastableFromStart: 1, mustEverFire: true } },
      { label: "frost-aoe", prompt: "Frost mage queen — when she casts, the target square AND every piece within 1 square of it gets frozen for 2 turns. 2 charges, 5-turn cooldown.", expect: { hasAbility: ["q"], minCastableFromStart: 1, mustEverFire: true } },
      { label: "bowling-knights", prompt: "Knight that can shove a friendly pawn forward up to 6 squares, knocking out any pieces in its path until it stops or runs off the board.", expect: { hasAbility: ["n"], minCastableFromStart: 1, mustEverFire: true } },
      { label: "necromancer-bishops", prompt: "Bishop necromancer that summons a friendly pawn on any empty square within 3 squares. Pawns last 8 turns. 2 charges, 6-turn cooldown.", expect: { hasAbility: ["b"], minCastableFromStart: 1, mustEverFire: true } },
      { label: "blink-rook", prompt: "Rook that can teleport to any empty square within 4 squares. Once per match per rook.", expect: { hasAbility: ["r"], minCastableFromStart: 1, mustEverFire: true } },
      { label: "mind-control-bishop", prompt: "Bishop that can charm an enemy piece for 4 turns, making it fight on their side. Once per match per bishop.", expect: { hasAbility: ["b"], minCastableFromStart: 1, mustEverFire: true } },
    ];

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const ARENA_RULES_TS = path.resolve(__dirname, "../../../../supabase/functions/arena_rules/index.ts");
    const src = fs.readFileSync(ARENA_RULES_TS, "utf8");
    function extractTemplate(varName) {
      const re = new RegExp(`const\\s+${varName}\\s*=\\s*\`([\\s\\S]*?)\`;`);
      const m = src.match(re);
      if (!m) throw new Error(`could not find ${varName} in ${ARENA_RULES_TS}`);
      return m[1];
    }
    const SYSTEM_PROMPT = extractTemplate("SYSTEM_PROMPT");
    const PLANNER_SYSTEM_PROMPT = extractTemplate("PLANNER_SYSTEM_PROMPT");
    console.log(`Loaded SYSTEM_PROMPT (${SYSTEM_PROMPT.length} chars), PLANNER_PROMPT (${PLANNER_SYSTEM_PROMPT.length} chars)`);

    function buildPrompt(prompt, plannerVibe) {
      let plannerNote = "";
      if (plannerVibe) {
        plannerNote = `\nDesign brief from the planner (use as creative context; the user's prompt above is still primary):
- Fighting style: ${plannerVibe.fighting_style}
- Signature mechanic: ${plannerVibe.signature_mechanic}
- Under pressure: ${plannerVibe.under_pressure}
`;
      }
      return `User's variant description:\n"""\n${prompt.trim()}\n"""\n${plannerNote}\nProduce a JSON rule diff matching the schema. ONLY the JSON object. No prose, no markdown fences.`;
    }

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
      if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const json = await resp.json();
      const content = json?.choices?.[0]?.message?.content;
      if (!content) throw new Error("empty Gemini response");
      const usage = json.usage || {};
      return { content, inputTokens: Number(usage.prompt_tokens) || 0, outputTokens: Number(usage.completion_tokens) || 0 };
    }

    function tolerantParse(content) {
      const trimmed = content.trim();
      try { return JSON.parse(trimmed); } catch {}
      let cleaned = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      try { return JSON.parse(cleaned); } catch {}
      cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1");
      try { return JSON.parse(cleaned); } catch (e) {
        throw new Error(`couldn't parse JSON: ${e.message}; first 200 chars: ${cleaned.slice(0, 200)}`);
      }
    }

    function listAbilities(rules) {
      const out = [];
      for (const [pt, spec] of Object.entries(rules.pieces || {})) {
        for (const ab of spec.abilities || []) out.push({ pieceType: pt, ability: ab });
      }
      for (const color of ["w", "b"]) {
        for (const [pt, spec] of Object.entries(rules.byColor?.[color] || {})) {
          for (const ab of spec.abilities || []) out.push({ pieceType: pt, ability: ab, color });
        }
      }
      return out;
    }

    function countCastableForBothColors(rules) {
      const pos = Position.fromFen(rules.startingFen);
      const w = generateLegalMoves(pos, rules).filter((m) => m.kind === "ability").length;
      const sim = pos.clone();
      sim.turn = "b";
      const b = generateLegalMoves(sim, rules).filter((m) => m.kind === "ability").length;
      return { white: w, black: b };
    }

    function simulateAbilityUse(rules, opts = {}) {
      const games = opts.games ?? 5;
      const plyCap = opts.plyCap ?? 200;
      const fireCounts = {};
      let terminated = 0;
      let totalCasts = 0;
      for (let g = 0; g < games; g++) {
        let pos = Position.fromFen(rules.startingFen);
        for (let ply = 0; ply < plyCap; ply++) {
          const status = checkGameStatus(pos, rules);
          if (status.ended) { terminated++; break; }
          const legal = generateLegalMoves(pos, rules);
          if (legal.length === 0) { terminated++; break; }
          const pick = legal[Math.floor(Math.random() * legal.length)];
          if (pick.kind === "ability") {
            const key = `${pick.casterType}:${pick.abilityId}`;
            fireCounts[key] = (fireCounts[key] || 0) + 1;
            totalCasts++;
          }
          try { pos = applyMove(pos, pick, rules); }
          catch { break; }
        }
      }
      return { games, terminated, totalCasts, fireCounts };
    }

    const toRun = LIMIT > 0 ? PROMPTS.slice(0, LIMIT) : PROMPTS;
    console.log(`Running ${toRun.length} prompts via ${MODEL}...`);

    const results = [];
    for (const p of toRun) {
      const start = Date.now();
      console.log(`\n══ ${p.label} ══`);
      console.log(`  prompt: ${p.prompt.slice(0, 80)}${p.prompt.length > 80 ? "…" : ""}`);

      let plannerVibe = null;
      let plannerTokens = { in: 0, out: 0 };
      try {
        const pl = await callGemini(
          PLANNER_SYSTEM_PROMPT,
          `User's variant description:\n"""\n${p.prompt.trim()}\n"""\n\nReply with the JSON object described in the system prompt.`,
          { temperature: 0.9, maxTokens: 500 },
        );
        plannerTokens = { in: pl.inputTokens, out: pl.outputTokens };
        const parsed = tolerantParse(pl.content);
        if (parsed?.fighting_style && parsed?.signature_mechanic && parsed?.under_pressure) {
          plannerVibe = parsed;
        }
      } catch (e) {
        console.log(`  planner failed (non-fatal): ${e.message}`);
      }

      const factoryUserPrompt = buildPrompt(p.prompt, plannerVibe);
      let factoryResp;
      try {
        factoryResp = await callGemini(SYSTEM_PROMPT, factoryUserPrompt, { temperature: 0.95, maxTokens: 16000 });
      } catch (e) {
        console.log(`  factory FAILED: ${e.message}`);
        results.push({ label: p.label, ok: false, reason: "factory call failed" });
        continue;
      }
      const factoryTokens = { in: factoryResp.inputTokens, out: factoryResp.outputTokens };

      let rulesDiff;
      try {
        rulesDiff = tolerantParse(factoryResp.content);
      } catch (e) {
        console.log(`  parse FAILED: ${e.message}`);
        console.log(`  raw: ${factoryResp.content.slice(0, 300)}`);
        results.push({ label: p.label, ok: false, reason: "parse failed", raw: factoryResp.content });
        continue;
      }

      const report = validateRules(rulesDiff);
      if (!report.valid) {
        console.log(`  validator REJECTED:`);
        for (const e of report.errors.slice(0, 5)) console.log(`    ${e}`);
        results.push({ label: p.label, ok: false, reason: "validator rejected", errors: report.errors, rules: rulesDiff });
        continue;
      }

      const rules = resolveRules(rulesDiff);
      const abilities = listAbilities(rules);
      const cast = countCastableForBothColors(rules);
      const sim = simulateAbilityUse(rules, { games: 5, plyCap: 150 });
      const description = describeRules(rules);

      const findings = [];
      if (p.expect?.hasAbility) {
        for (const pt of p.expect.hasAbility) {
          const has = abilities.some((a) => a.pieceType === pt);
          if (!has) findings.push(`MISS: expected ability on '${pt}' but none emitted`);
        }
      }
      if (p.expect?.minCastableFromStart != null) {
        if (cast.white < p.expect.minCastableFromStart) {
          findings.push(`WEAK: white can cast 0 abilities from starting position (test expected ≥${p.expect.minCastableFromStart}); ability is effectively invisible at game start`);
        }
      }
      if (p.expect?.mustEverFire) {
        if (sim.totalCasts === 0) {
          findings.push(`DEAD: 5×150-ply random simulation produced ZERO ability casts; ability never fires in random play`);
        }
      }

      const elapsed = Date.now() - start;
      console.log(`  abilities: ${abilities.length} ${abilities.map((a) => `${a.pieceType}.${a.ability.id}`).join(", ")}`);
      for (const a of abilities) {
        const t = a.ability.target;
        const offsetCount = (t.offsets?.length || 0) + (t.dirs?.length || 0);
        const eff = a.ability.effect;
        const gat = a.ability.gating;
        console.log(`    - ${a.pieceType}.${a.ability.id}: target=${t.kind}(${offsetCount}offsets) effect=${eff.kind}${eff.aoe ? `+aoe${eff.aoe.radius}` : ""} gating=${JSON.stringify(gat || {})}`);
      }
      console.log(`  startable casts: white=${cast.white} black=${cast.black}`);
      console.log(`  random-sim casts: total=${sim.totalCasts} per=${JSON.stringify(sim.fireCounts)} terminated=${sim.terminated}/${sim.games}`);
      console.log(`  description: ${description.name} - ${description.description}`);
      console.log(`  tokens: planner=${plannerTokens.in}/${plannerTokens.out} factory=${factoryTokens.in}/${factoryTokens.out}`);
      console.log(`  elapsed: ${elapsed}ms`);
      if (findings.length) {
        console.log(`  ⚠ FINDINGS:`);
        for (const f of findings) console.log(`    - ${f}`);
      } else {
        console.log(`  ✓ all expectations met`);
      }

      results.push({
        label: p.label,
        ok: findings.length === 0,
        findings,
        abilities: abilities.map((a) => ({ pt: a.pieceType, id: a.ability.id, target: a.ability.target, effect: a.ability.effect, gating: a.ability.gating })),
        cast,
        sim,
        description,
        tokens: { planner: plannerTokens, factory: factoryTokens },
      });
    }

    const ok = results.filter((r) => r.ok).length;
    const total = results.length;
    const totalIn = results.reduce((a, r) => a + (r.tokens?.planner?.in || 0) + (r.tokens?.factory?.in || 0), 0);
    const totalOut = results.reduce((a, r) => a + (r.tokens?.planner?.out || 0) + (r.tokens?.factory?.out || 0), 0);
    const usd = (totalIn * 0.075 + totalOut * 0.30) / 1_000_000;
    console.log(`\n══ SUMMARY ══`);
    console.log(`  passed: ${ok}/${total}`);
    console.log(`  total tokens: ${totalIn} in + ${totalOut} out`);
    console.log(`  est. cost: $${usd.toFixed(4)} (~€${(usd * 0.92).toFixed(4)})`);
    console.log(`  per-prompt verdict:`);
    for (const r of results) {
      const tag = r.ok ? "✓" : "✗";
      const summary = r.findings ? r.findings.map((f) => f.split(":")[0]).join(",") : (r.reason || "");
      console.log(`    ${tag} ${r.label.padEnd(24)} ${summary}`);
    }

    const outFile = path.resolve(__dirname, "../../../../tmp/test-arena-prompts-output.json");
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
    console.log(`  full output: ${outFile}`);

    expect(results.length).toBe(toRun.length);
  }, 600_000); // 10-minute timeout for the whole batch
});
