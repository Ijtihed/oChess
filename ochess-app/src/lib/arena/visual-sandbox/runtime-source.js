/**
 * The iframe sandbox runtime, as a stringified module.
 *
 * Why a string? The iframe must run with `sandbox="allow-scripts"`
 * and NO `allow-same-origin`. With an opaque origin, the iframe
 * can't `fetch()` external scripts (cross-origin, no Origin
 * header any backend trusts). So the runtime has to be INLINED
 * into the srcdoc attribute at mount time.
 *
 * We keep it as a JS template string so it's readable + linted +
 * unit-testable as JS. The `RUNTIME_SOURCE` export is what the
 * React overlay component (Phase 3) passes to srcdoc.
 *
 * Architecture inside the iframe:
 *
 *   1. On window.message INIT(rules, drawSources, seed):
 *        - Parse the (already-validated, already-loop-guarded)
 *          draw sources into Function objects via new Function.
 *        - Stash them by slot key.
 *        - Build the seeded PRNG from the seed.
 *        - postMessage READY back.
 *
 *   2. On window.message SCENE(position, marks, lastCast, t):
 *        - Clear the canvas.
 *        - For each piece on the board:
 *            - For each non-null slot the variant has:
 *                - ctx.save()
 *                - ctx.translate to the piece's screen coords
 *                - call the slot draw with budget tracking
 *                - ctx.restore()
 *        - For each active projectile + overlay:
 *            - same shape on absolute coords
 *        - postMessage PERF_REPORT (frame time, slowest slot).
 *
 *   3. On any draw error:
 *        - try/catch each draw. Log to a per-slot error counter.
 *        - postMessage DRAW_ERROR(slot, msg, ply, source-excerpt).
 *        - After 30 errors per slot, disable that slot for the
 *          rest of the iframe lifetime.
 *
 *   4. The guard helper:
 *        - Each call gets a fresh ctx { iter: 0, t0: now }.
 *        - On every guarded iteration: bump iter, reject if >5000
 *          OR if (now - t0) > 40ms.
 *
 *   5. Math.random is shadowed at iframe init to route through
 *      the seeded PRNG. AI draws that forget to use the `random`
 *      parameter still produce deterministic output.
 *
 *   6. The iframe also installs error capture for unhandled
 *      promise rejections (defense - draws shouldn't be async,
 *      but if one slips through the AST validator we want to know).
 */

/**
 * The complete HTML doc as a string. To be passed verbatim to
 * the iframe's `srcdoc` attribute by the overlay component.
 *
 * IMPORTANT: this is a string, not real JS in this scope. The
 * code inside runs in the iframe, NOT in the parent. Don't
 * reference any module-level imports here.
 */
export const RUNTIME_SOURCE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0; padding: 0;
    width: 100%; height: 100%;
    overflow: hidden;
    background: transparent;
  }
  canvas {
    display: block;
    width: 100%; height: 100%;
    background: transparent;
  }
</style>
</head>
<body>
<canvas id="c"></canvas>
<script>
(function () {
  "use strict";
  // ── State ─────────────────────────────────────────────
  var canvas = document.getElementById("c");
  var ctx = canvas.getContext("2d");

  // The runtime is invoked with a fresh state object per
  // mount; resets are handled by remounting the iframe.
  var state = {
    drawsBySlot: {},              // { "q.aura": Function, "n.body": Function, ... }
    projectileDrawsById: {},      // { "fireball": Function, ... }
    effectDrawsById: {},          // { "impact": Function, "smoke": Function, ... }
    overlayDraws: [],             // [Function, ...]
    brainDraws: {},               // { "q": Function, ... }  (cosmetic per-piece hooks)
    activeProjectiles: [],        // spawned by brain hooks
    activeEffects: [],            // spawned by brain hooks
    errorCounts: {},              // { "q.aura": 5, ... }
    disabledSlots: {},            // { "q.aura": true, ... }
    perfBuckets: {},              // { "q.aura": [3.2, 4.1, ...], ... }
    seed: "default",
    seededRandom: Math.random,
    pieceState: {},               // per-piece state map for brain hooks
    lastSceneT: 0,
    lastBrainT: 0,
  };

  var MAX_ERRORS_PER_SLOT = 30;
  var MAX_TOTAL_ERRORS = 100;
  var totalErrors = 0;
  var GUARD_MAX_ITER = 5000;
  var GUARD_MAX_MS = 40;
  var SLOW_SLOT_MS = 5;            // a single draw exceeding this is "slow"
  var SLOW_FRAMES_TO_DOWNGRADE = 10;
  var BRAIN_INTERVAL_MS = 120;     // ~8Hz, similar to WarriorFactory brains
  var MAX_BRAIN_PROJECTILES = 32;
  var MAX_BRAIN_EFFECTS = 64;

  // ── Seeded PRNG (xoshiro128+) ─────────────────────────
  // Inlined here because the iframe can't import; same algo
  // as src/lib/arena/visual-sandbox/seeded-prng.js so output
  // matches what the parent expects.
  function makeRandom(seedStr) {
    function mix32(x) {
      x = (x ^ (x >>> 16)) >>> 0;
      x = Math.imul(x, 0x85ebca6b) >>> 0;
      x = (x ^ (x >>> 13)) >>> 0;
      x = Math.imul(x, 0xc2b2ae35) >>> 0;
      x = (x ^ (x >>> 16)) >>> 0;
      return x;
    }
    var s0 = 0x9E3779B1, s1 = 0xBB67AE85, s2 = 0x3C6EF372, s3 = 0xA54FF53A;
    for (var i = 0; i < seedStr.length; i++) {
      var c = seedStr.charCodeAt(i);
      s0 = mix32(s0 ^ c) >>> 0;
      s1 = mix32(s1 + c) >>> 0;
      s2 = mix32(s2 ^ ((c << 8) | (c >>> 24))) >>> 0;
      s3 = mix32(s3 + s0 + c) >>> 0;
    }
    if ((s0 | s1 | s2 | s3) === 0) s0 = 1;
    return function () {
      var result = (s0 + s3) >>> 0;
      var t = (s1 << 9) >>> 0;
      s2 ^= s0;
      s3 ^= s1;
      s1 ^= s2;
      s0 ^= s3;
      s2 ^= t;
      s3 = (s3 << 11) | (s3 >>> 21);
      return result / 0x100000000;
    };
  }

  // Replace Math.random globally so AI draws that forget to
  // use the 'random' parameter still get deterministic output.
  var originalMathRandom = Math.random;
  function shadowMathRandom() {
    Math.random = state.seededRandom;
  }

  // ── Guard helper (used by injected loop-guard calls) ──
  // The guard ctx is created fresh per draw call. It tracks
  // iteration count + elapsed wall-clock time.
  function makeGuardCtx() {
    return {
      iter: 0,
      t0: performance.now(),
    };
  }
  function guardFn(g) {
    g.iter++;
    if (g.iter > GUARD_MAX_ITER) {
      throw new Error("loop-guard: " + GUARD_MAX_ITER + " iters exceeded");
    }
    if (performance.now() - g.t0 > GUARD_MAX_MS) {
      throw new Error("time-budget: " + GUARD_MAX_MS + "ms exceeded");
    }
  }

  // ── Per-slot draw runner ──────────────────────────────
  function runSlotDraw(slotKey, args) {
    if (state.disabledSlots[slotKey]) return null;
    var fn = state.drawsBySlot[slotKey];
    if (!fn) return null;
    var g = makeGuardCtx();
    var t0 = performance.now();
    try {
      fn.apply(null, [g, guardFn].concat(args));
    } catch (err) {
      handleDrawError(slotKey, err, args);
      return null;
    }
    var elapsed = performance.now() - t0;
    trackPerf(slotKey, elapsed);
    return elapsed;
  }

  // ── Error handling ────────────────────────────────────
  function handleDrawError(slotKey, err, args) {
    state.errorCounts[slotKey] = (state.errorCounts[slotKey] || 0) + 1;
    totalErrors++;
    var msg = err && err.message ? err.message : String(err);
    var stack = err && err.stack ? String(err.stack).split("\\n").slice(0, 3).join("\\n") : "";
    sendToParent({
      type: "DRAW_ERROR",
      slot: slotKey,
      message: msg,
      stack: stack,
      ply: state.lastScenePly,
      t: state.lastSceneT,
    });
    if (state.errorCounts[slotKey] >= MAX_ERRORS_PER_SLOT) {
      state.disabledSlots[slotKey] = true;
      sendToParent({
        type: "SLOT_DISABLED",
        slot: slotKey,
        reason: "exceeded " + MAX_ERRORS_PER_SLOT + " errors",
      });
    }
    if (totalErrors >= MAX_TOTAL_ERRORS) {
      // Disable EVERY slot. Parent will surface a friendly UI.
      for (var k in state.drawsBySlot) state.disabledSlots[k] = true;
      sendToParent({ type: "SANDBOX_HALTED", reason: "total error cap reached" });
    }
  }

  function trackPerf(slotKey, ms) {
    if (!state.perfBuckets[slotKey]) state.perfBuckets[slotKey] = [];
    var buf = state.perfBuckets[slotKey];
    buf.push(ms);
    if (buf.length > 60) buf.shift();
    if (ms > SLOW_SLOT_MS) {
      // Count slow frames. Disable after threshold.
      buf.slowCount = (buf.slowCount || 0) + 1;
      if (buf.slowCount >= SLOW_FRAMES_TO_DOWNGRADE) {
        state.disabledSlots[slotKey] = true;
        sendToParent({
          type: "SLOT_DISABLED",
          slot: slotKey,
          reason: "slow: " + SLOW_FRAMES_TO_DOWNGRADE + " frames > " + SLOW_SLOT_MS + "ms",
        });
      }
    } else {
      // Reset slow counter on a fast frame.
      buf.slowCount = 0;
    }
  }

  // ── Brain hooks (WarriorFactory-style cosmetic scheduler) ─
  // Brains run at low frequency and can spawn purely-visual
  // projectiles/effects. They CANNOT change chess state.
  function runBrains(scene, sqSize, orientation) {
    var nowT = scene.t || 0;
    if (nowT - state.lastBrainT < BRAIN_INTERVAL_MS) return;
    var dt = state.lastBrainT ? (nowT - state.lastBrainT) / 1000 : BRAIN_INTERVAL_MS / 1000;
    state.lastBrainT = nowT;

    for (var i = 0; i < (scene.pieces || []).length; i++) {
      var piece = scene.pieces[i];
      var brain = state.brainDraws[piece.type];
      if (!brain) continue;
      var sx = squareToScreen(piece.square, sqSize, orientation);
      if (!sx) continue;
      var selfState = state.pieceState[piece.square] = state.pieceState[piece.square] || {};
      var self = {
        type: piece.type,
        color: piece.color,
        square: piece.square,
        x: sx.x,
        y: sx.y,
        facing: piece.color === "w" ? 1 : -1,
        t: nowT,
        state: selfState,
      };
      var world = makeBrainWorld(nowT);
      var g = makeGuardCtx();
      try {
        brain(g, guardFn, self, world, dt, selfState);
      } catch (err) {
        handleDrawError("brain." + piece.type, err, []);
      }
    }
  }

  function makeBrainWorld(nowT) {
    return {
      spawnProjectile: function (payload) {
        if (!payload || typeof payload !== "object") return;
        if (state.activeProjectiles.length >= MAX_BRAIN_PROJECTILES) state.activeProjectiles.shift();
        var ttl = clampNumber(payload.ttl || payload.ttlMs || 500, 80, 2000);
        state.activeProjectiles.push({
          kind: String(payload.kind || "default"),
          fromX: Number(payload.fromX) || Number(payload.x) || 0,
          fromY: Number(payload.fromY) || Number(payload.y) || 0,
          toX: Number(payload.toX) || Number(payload.x) || 0,
          toY: Number(payload.toY) || Number(payload.y) || 0,
          age: 0,
          ttl: ttl,
          startedAt: nowT,
        });
      },
      spawnEffect: function (payload) {
        if (!payload || typeof payload !== "object") return;
        if (state.activeEffects.length >= MAX_BRAIN_EFFECTS) state.activeEffects.shift();
        var ttl = clampNumber(payload.ttl || payload.ttlMs || 600, 80, 3000);
        state.activeEffects.push({
          kind: String(payload.kind || "default"),
          x: Number(payload.x) || 0,
          y: Number(payload.y) || 0,
          age: 0,
          ttl: ttl,
          data: payload.data && typeof payload.data === "object" ? payload.data : {},
          startedAt: nowT,
        });
      },
    };
  }

  function clampNumber(n, min, max) {
    n = Number(n);
    if (!isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  // ── Scene paint ───────────────────────────────────────
  function paintScene(scene) {
    if (!scene) return;
    state.lastScenePly = scene.ply;
    state.lastSceneT = scene.t || 0;

    // Resize canvas to match the iframe's actual pixel size.
    // The parent sends boardPx so we know the board's CSS size;
    // we use devicePixelRatio for crispness.
    var boardPx = scene.boardPx || 480;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== boardPx * dpr || canvas.height !== boardPx * dpr) {
      canvas.width = boardPx * dpr;
      canvas.height = boardPx * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.clearRect(0, 0, boardPx, boardPx);

    var sq = boardPx / 8;
    var orientation = scene.orientation || "white";

    var frameStartT = performance.now();

    // 1. Per-piece slots
    for (var i = 0; i < (scene.pieces || []).length; i++) {
      var piece = scene.pieces[i];
      var sx = squareToScreen(piece.square, sq, orientation);
      if (!sx) continue;
      var owner = { type: piece.type, color: piece.color };
      var facing = piece.color === "w" ? 1 : -1;

      // Try every slot key the variant declares for this piece type.
      var slotKeys = ["body", "head", "back", "weapon_R", "weapon_L", "feet", "aura"];
      for (var j = 0; j < slotKeys.length; j++) {
        var key = piece.type + "." + slotKeys[j];
        if (!state.drawsBySlot[key]) continue;
        ctx.save();
        ctx.translate(sx.x, sx.y);
        runSlotDraw(key, [ctx, 0, 0, facing, owner, scene.t || 0, state.seededRandom, state.pieceState[piece.square] = state.pieceState[piece.square] || {}]);
        ctx.restore();
      }
    }

    // 2. Brain hooks can spawn cosmetic projectiles/effects.
    runBrains(scene, sq, orientation);

    // 3. Active projectiles (absolute coords). Includes chess-
    // event projectiles from the parent plus visual-only brain
    // spawned projectiles.
    var activeProjectiles = updateBrainProjectiles(scene.t || 0);
    var projectiles = (scene.projectiles || []).concat(activeProjectiles);
    for (var k = 0; k < projectiles.length; k++) {
      var proj = projectiles[k];
      if (!proj) continue;
      var fn = state.projectileDrawsById[proj.kind];
      if (!fn) continue;
      var g = makeGuardCtx();
      var pt0 = performance.now();
      try {
        var fromS = proj.fromX != null ? { x: proj.fromX, y: proj.fromY } : squareToScreen(proj.from, sq, orientation);
        var toS = proj.toX != null ? { x: proj.toX, y: proj.toY } : squareToScreen(proj.to, sq, orientation);
        if (!fromS || !toS) continue;
        var p = {
          x: fromS.x + (toS.x - fromS.x) * proj.progress,
          y: fromS.y + (toS.y - fromS.y) * proj.progress,
          fromX: fromS.x, fromY: fromS.y,
          toX: toS.x, toY: toS.y,
          progress: proj.progress,
          age: proj.age || 0,
          ttl: proj.ttl || 0,
        };
        fn(g, guardFn, ctx, p);
      } catch (err) {
        handleDrawError("proj." + proj.kind, err, []);
      }
      trackPerf("proj." + proj.kind, performance.now() - pt0);
    }

    // 4. Brain-spawned effects (absolute coords)
    var effects = updateBrainEffects(scene.t || 0);
    for (var ei = 0; ei < effects.length; ei++) {
      var eff = effects[ei];
      var efn = state.effectDrawsById[eff.kind];
      if (!efn) continue;
      var eg = makeGuardCtx();
      var et0 = performance.now();
      try {
        efn(eg, guardFn, ctx, eff, scene.t || 0);
      } catch (err) {
        handleDrawError("effect." + eff.kind, err, []);
      }
      trackPerf("effect." + eff.kind, performance.now() - et0);
    }

    // 5. Full-board overlays
    for (var m = 0; m < state.overlayDraws.length; m++) {
      var ofn = state.overlayDraws[m];
      var og = makeGuardCtx();
      var ot0 = performance.now();
      try {
        ofn(og, guardFn, ctx, {
          width: boardPx,
          height: boardPx,
          marks: scene.marks || {},
          lastCast: scene.lastCast || null,
          t: scene.t || 0,
        });
      } catch (err) {
        handleDrawError("overlay." + m, err, []);
      }
      trackPerf("overlay." + m, performance.now() - ot0);
    }

    var frameMs = performance.now() - frameStartT;
    sendToParent({
      type: "PAINT_DONE",
      ply: scene.ply,
      ms: frameMs,
    });
  }

  function updateBrainProjectiles(nowT) {
    var next = [];
    for (var i = 0; i < state.activeProjectiles.length; i++) {
      var p = state.activeProjectiles[i];
      var age = nowT - p.startedAt;
      if (age >= p.ttl) continue;
      p.age = age;
      p.progress = Math.max(0, Math.min(1, age / p.ttl));
      next.push(p);
    }
    state.activeProjectiles = next;
    return next;
  }

  function updateBrainEffects(nowT) {
    var next = [];
    for (var i = 0; i < state.activeEffects.length; i++) {
      var e = state.activeEffects[i];
      var age = nowT - e.startedAt;
      if (age >= e.ttl) continue;
      e.age = age;
      e.progress = Math.max(0, Math.min(1, age / e.ttl));
      next.push(e);
    }
    state.activeEffects = next;
    return next;
  }

  // ── Helpers ───────────────────────────────────────────
  function squareToScreen(sq, sqSize, orientation) {
    if (typeof sq !== "string" || sq.length !== 2) return null;
    var file = sq.charCodeAt(0) - 97;
    var rank = parseInt(sq[1], 10) - 1;
    if (file < 0 || file > 7 || isNaN(rank) || rank < 0 || rank > 7) return null;
    var fileFlipped = orientation === "black" ? (7 - file) : file;
    var rankFlipped = orientation === "black" ? rank : (7 - rank);
    return {
      x: fileFlipped * sqSize + sqSize / 2,
      y: rankFlipped * sqSize + sqSize / 2,
    };
  }

  // ── Message protocol ──────────────────────────────────
  function sendToParent(msg) {
    try { window.parent.postMessage(msg, "*"); } catch (e) { /* ignore */ }
  }

  // We accept messages from any origin since our iframe has an
  // opaque origin and the parent's origin can be anything.
  // The parent ALSO validates the protocol version on its end.
  window.addEventListener("message", function (ev) {
    var msg = ev.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.protocolVersion && msg.protocolVersion !== 1) return;

    if (msg.type === "INIT") {
      try {
        // Build the seeded PRNG.
        state.seed = String(msg.seed || "default");
        state.seededRandom = makeRandom(state.seed);
        shadowMathRandom();

        // Compile each draw source into a Function.
        // The drawSources object is shaped as:
        //   { slots: { "q.aura": "<source>", ... },
        //     projectiles: { "fireball": "<source>", ... },
        //     effects: { "impact": "<source>", ... },
        //     overlays: ["<source>", ...],
        //     brains: { "q": "<source>", ... } }
        // Each source is a complete function declaration string
        // produced by inject-loop-guard.js in the parent.
        var sources = msg.drawSources || {};
        for (var slotKey in (sources.slots || {})) {
          state.drawsBySlot[slotKey] = compileDraw(sources.slots[slotKey], slotKey);
        }
        for (var pk in (sources.projectiles || {})) {
          state.projectileDrawsById[pk] = compileDraw(sources.projectiles[pk], "proj." + pk);
        }
        for (var ek in (sources.effects || {})) {
          state.effectDrawsById[ek] = compileDraw(sources.effects[ek], "effect." + ek);
        }
        for (var oi = 0; oi < (sources.overlays || []).length; oi++) {
          var compiled = compileDraw(sources.overlays[oi], "overlay." + oi);
          if (compiled) state.overlayDraws.push(compiled);
        }
        for (var bk in (sources.brains || {})) {
          state.brainDraws[bk] = compileDraw(sources.brains[bk], "brain." + bk);
        }
        sendToParent({ type: "READY" });
      } catch (err) {
        sendToParent({ type: "INIT_ERROR", message: err.message });
      }
      return;
    }

    if (msg.type === "SCENE") {
      paintScene(msg.scene);
      return;
    }
  });

  function compileDraw(source, slotKey) {
    try {
      // The source IS the full function declaration. We need
      // to evaluate it to get the function object back. Use
      // new Function as the eval mechanism (the AST validator
      // already ensured it's safe).
      // The wrapper returns __draw__ from local scope.
      var wrapper = new Function("return (" + source + ")");
      var fn = wrapper();
      if (typeof fn !== "function") {
        throw new Error("compiled source did not produce a function");
      }
      return fn;
    } catch (err) {
      handleDrawError(slotKey || "unknown", err, []);
      return null;
    }
  }

  // ── Defense: catch unhandled rejections ──
  window.addEventListener("error", function (ev) {
    sendToParent({
      type: "DRAW_ERROR",
      slot: "unknown",
      message: "uncaught: " + (ev.message || "?"),
      stack: "",
    });
  });
  window.addEventListener("unhandledrejection", function (ev) {
    sendToParent({
      type: "DRAW_ERROR",
      slot: "unknown",
      message: "unhandled-rejection: " + String(ev.reason),
      stack: "",
    });
  });

  // Ready signal sent only after INIT; we don't preemptively
  // signal here because the parent waits for READY to start
  // dispatching SCENE messages.
})();
</script>
</body>
</html>
`;

/**
 * Stable protocol version. Bump when the parent <-> iframe
 * message shape changes incompatibly. Both sides check.
 */
export const PROTOCOL_VERSION = 1;
