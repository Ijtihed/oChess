import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RUNTIME_SOURCE } from "../src/lib/arena/visual-sandbox/runtime-source.js";
import { repairVisualsForRules } from "../src/lib/arena/visual-repair.js";

const outDir = resolve(process.cwd(), "../tmp");
mkdirSync(outDir, { recursive: true });

const variants = [
  variant("fireball", "Fireball Queen", "fireball", "Fireball", "burning", { kind: "aoe_wrap", radius: 1, inner: { kind: "destroy" } }),
  variant("freeze", "Freezing Bishop", "freeze", "Freeze", "frozen", { kind: "mark", tag: "frozen", duration: 3, skipTurns: true }, "b"),
  variant("shadow_bolt", "Shadow Queen", "shadow_bolt", "Shadow Bolt", "curse", { kind: "destroy" }),
  variant("bowling", "Bowling Knight", "bowling", "Bowling Strike", "impact", { kind: "displace", delta: [0, 3], onCollision: "destroy_collider" }, "n"),
  variant("lightning", "Lightning Rook", "lightning", "Lightning", "shock", { kind: "destroy" }, "r"),
];

function variant(slug, name, id, label, markTag, effect, piece = "q") {
  return {
    slug,
    markTag,
    rules: repairVisualsForRules({
      extends: "vanilla",
      name,
      description: `${label} visual proof.`,
      pieces: {
        [piece]: {
          abilities: [{
            id,
            label,
            target: { kind: "ranged", offsets: [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6]], requireEnemy: true },
            effect,
            gating: { charges: 3, cooldownPlies: 4 },
          }],
        },
      },
    }),
  };
}

function wrapDraw(src, params) {
  return `function __draw__(__arenaGuardCtx__, __arenaGuard__, ${params.join(", ")}) {\n${src}\n}`;
}

function compileForProof(visuals) {
  const out = { slots: {}, projectiles: {}, effects: {}, overlays: [], brains: {} };
  for (const [k, src] of Object.entries(visuals.slots || {})) {
    out.slots[k] = wrapDraw(src, ["ctx", "x", "y", "facing", "owner", "t", "random", "state"]);
  }
  for (const [k, src] of Object.entries(visuals.projectiles || {})) {
    out.projectiles[k] = wrapDraw(src, ["ctx", "p"]);
  }
  for (const [k, src] of Object.entries(visuals.effects || {})) {
    out.effects[k] = wrapDraw(src, ["ctx", "e", "t"]);
  }
  for (const src of visuals.overlays || []) {
    out.overlays.push(wrapDraw(src, ["ctx", "scene"]));
  }
  for (const [k, src] of Object.entries(visuals.brains || {})) {
    out.brains[k] = wrapDraw(src, ["self", "world", "dt", "state", "random"]);
  }
  return out;
}

const safeRuntimeJson = JSON.stringify(RUNTIME_SOURCE).replaceAll("</script>", "<\\/script>");

function htmlFor({ slug, markTag, rules }) {
  const compiled = { compiled: compileForProof(rules.visuals) };
  const ability = Object.values(rules.pieces)[0].abilities[0];
  const pieceType = Object.keys(rules.pieces)[0];
  const whiteGlyph = pieceType === "n" ? "♘" : pieceType === "b" ? "♗" : pieceType === "r" ? "♖" : "♕";
  const blackGlyph = pieceType === "n" ? "♞" : pieceType === "b" ? "♝" : pieceType === "r" ? "♜" : "♛";
  const safeDrawSourcesJson = JSON.stringify(compiled.compiled).replaceAll("</script>", "<\\/script>");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body { margin: 0; background: #111; font-family: system-ui, sans-serif; }
    #wrap { padding: 20px; color: white; }
    #board {
      position: relative;
      width: 640px;
      height: 640px;
      background:
        repeating-conic-gradient(#b77942 0% 25%, #f0d1a5 0% 50%) 50% / 25% 25%;
      box-shadow: 0 0 0 2px #333, 0 18px 60px rgba(0,0,0,.55);
      overflow: hidden;
    }
    #board iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; pointer-events: none; }
    .piece {
      position: absolute;
      width: 80px; height: 80px;
      display: grid; place-items: center;
      font-size: 48px;
      z-index: 1;
      text-shadow: 0 2px 6px rgba(0,0,0,.55);
      pointer-events: none;
    }
    .white { color: #fff; }
    .black { color: #111; -webkit-text-stroke: 1px #eee; }
    #status { margin-top: 12px; font: 13px monospace; color: #ddd; }
  </style>
</head>
<body>
<div id="wrap">
  <h1>oChess arena visual proof: ${rules.name}</h1>
  <div id="board">
    <div class="piece white" style="left:240px;top:560px">${whiteGlyph}</div>
    <div class="piece black" style="left:240px;top:80px">${blackGlyph}</div>
    <iframe id="overlay" title="arena visual overlay" sandbox="allow-scripts"></iframe>
  </div>
  <div id="status">booting</div>
</div>
<script>
const iframe = document.getElementById("overlay");
const status = document.getElementById("status");
const drawSources = ${safeDrawSourcesJson};
const srcdoc = ${safeRuntimeJson};
const messages = [];
window.__messages = messages;
iframe.srcdoc = srcdoc;

const pieces = [
  { square: "d1", type: "${pieceType}", color: "w" },
  { square: "d7", type: "${pieceType}", color: "b" }
];

window.addEventListener("message", (ev) => {
  messages.push(ev.data);
  if (ev.data && ev.data.type === "READY") {
    status.textContent = "READY";
    startScenes();
  }
  if (ev.data && ev.data.type === "DRAW_ERROR") {
    status.textContent = "DRAW_ERROR " + ev.data.slot + " " + ev.data.message;
  }
});

iframe.addEventListener("load", () => {
  status.textContent = "iframe loaded; init";
  iframe.contentWindow.postMessage({
    protocolVersion: 1,
    type: "INIT",
    seed: "visual-proof-fireball",
    drawSources
  }, "*");
});

let started = false;
function startScenes() {
  if (started) return;
  started = true;
  const t0 = performance.now();
  function frame() {
    const t = performance.now() - t0;
    // Linear looping travel so screenshot frames clearly show
    // projectile motion from caster -> target.
    const progress = (t % 1600) / 1600;
    iframe.contentWindow.postMessage({
      protocolVersion: 1,
      type: "SCENE",
      scene: {
        ply: 1,
        t,
        boardPx: 640,
        orientation: "white",
        pieces,
        lastCast: { from: "d1", to: "d7", abilityId: "${ability.id}" },
        marks: { d7: [{ tag: "${markTag}" }] },
        projectiles: [{ kind: "${ability.id}", from: "d1", to: "d7", progress, age: t % 350, ttl: 350 }]
      }
    }, "*");
    requestAnimationFrame(frame);
  }
  frame();
}
</script>
</body>
</html>`;
}

const browser = await chromium.launch({ headless: true });
for (const v of variants) {
  const screenshotPath = resolve(outDir, `arena-${v.slug}-proof.png`);
  const htmlPath = resolve(outDir, `arena-${v.slug}-proof.html`);
  writeFileSync(htmlPath, htmlFor(v));
  const page = await browser.newPage({ viewport: { width: 900, height: 820 }, deviceScaleFactor: 1 });
  const consoleLines = [];
  page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleLines.push(`[pageerror] ${err.message}`));
  await page.goto("file://" + htmlPath, { waitUntil: "load" });
  if (v.slug === "fireball") {
    // Explicit motion proof frames: the projectile should move
    // upward between these images.
    await page.waitForTimeout(350);
    await page.screenshot({ path: resolve(outDir, "arena-fireball-motion-1.png"), fullPage: true });
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(outDir, "arena-fireball-motion-2.png"), fullPage: true });
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(outDir, "arena-fireball-motion-3.png"), fullPage: true });
  } else {
    await page.waitForTimeout(1350);
  }
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const messages = await page.evaluate(() => window.__messages || []);
  await page.close();
  console.log("screenshot", screenshotPath);
  console.log("html", htmlPath);
  console.log("messages", messages.map((m) => m && m.type).slice(0, 8).join(","));
  for (const line of consoleLines) console.log(line);
}
await browser.close();
