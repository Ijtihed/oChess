import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RUNTIME_SOURCE } from "../src/lib/arena/visual-sandbox/runtime-source.js";
import { repairVisualsForRules } from "../src/lib/arena/visual-repair.js";

const outDir = resolve(process.cwd(), "../tmp");
const screenshotPath = resolve(outDir, "arena-fireball-proof.png");
const htmlPath = resolve(outDir, "arena-fireball-proof.html");
mkdirSync(outDir, { recursive: true });

const rules = repairVisualsForRules({
  extends: "vanilla",
  name: "Fireball Queen",
  description: "Queen fires a flaming projectile and creates impact fire.",
  pieces: {
    q: {
      abilities: [{
        id: "fireball",
        label: "Fireball",
        target: { kind: "ranged", offsets: [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6]], requireEnemy: true },
        effect: { kind: "aoe_wrap", radius: 1, inner: { kind: "destroy" } },
        gating: { charges: 3, cooldownPlies: 4 },
      }],
    },
  },
});

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

const compiled = { compiled: compileForProof(rules.visuals) };

const safeRuntimeJson = JSON.stringify(RUNTIME_SOURCE).replaceAll("</script>", "<\\/script>");
const safeDrawSourcesJson = JSON.stringify(compiled.compiled).replaceAll("</script>", "<\\/script>");

const html = `<!doctype html>
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
  <h1>oChess arena visual proof: Fireball Queen</h1>
  <div id="board">
    <div class="piece white" style="left:240px;top:560px">♕</div>
    <div class="piece black" style="left:240px;top:80px">♛</div>
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
  { square: "d1", type: "q", color: "w" },
  { square: "d7", type: "q", color: "b" }
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
    const progress = (Math.sin(t / 650) + 1) / 2;
    iframe.contentWindow.postMessage({
      protocolVersion: 1,
      type: "SCENE",
      scene: {
        ply: 1,
        t,
        boardPx: 640,
        orientation: "white",
        pieces,
        lastCast: { from: "d1", to: "d7", abilityId: "fireball" },
        marks: { d7: [{ tag: "burning" }] },
        projectiles: [{ kind: "fireball", from: "d1", to: "d7", progress, age: t % 350, ttl: 350 }]
      }
    }, "*");
    requestAnimationFrame(frame);
  }
  frame();
}
</script>
</body>
</html>`;

writeFileSync(htmlPath, html);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 820 }, deviceScaleFactor: 1 });
const consoleLines = [];
page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => consoleLines.push(`[pageerror] ${err.message}`));
await page.goto("file://" + htmlPath, { waitUntil: "load" });
await page.waitForTimeout(2200);
await page.screenshot({ path: screenshotPath, fullPage: true });
const messages = await page.evaluate(() => window.__messages || []);
await browser.close();

console.log("screenshot", screenshotPath);
console.log("html", htmlPath);
console.log("messages", messages.map((m) => m && m.type).join(","));
console.log("console");
for (const line of consoleLines) console.log(line);
