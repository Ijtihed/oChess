# Crazy Arena — Design Doc

Arena Mode is upgrading from "small tweaks of vanilla chess" to "AI-designed
combat variants with active abilities, status effects, and animated visuals."
This doc captures the architecture, the constraints, the rollout plan, and the
threat model. It supersedes the original `arena_rules/README.md` for design
intent (the README still describes the running Edge Function).

The shipping version of crazy arena keeps the existing arena lobby, room,
clock, realtime sync, rate limit, and `$200/month` AI spend cap exactly as
they are today. Everything in this doc is **additive** to that infra.

## Goals

1. The user prompts a free-form variant ("fire mage chess", "frost-knight
   army", "necromancer queen"). The AI returns a variant where pieces have
   **active abilities** (fireball, freeze, summon), **passive triggers** (burn
   trail, on-capture explosion), and **animated visuals** that match the vibe.
2. **Every gameplay outcome stays deterministic and data-driven.** The
   AI does not write rule logic JS. It composes from a fixed but generous
   effect vocabulary the engine evaluates.
3. **The AI does write visual JS.** Per-piece slot draws, projectile
   renderers, full-board overlays. This is sandboxed (AST allowlist + loop
   guard + try/catch) and runs main-thread on the client. Visual code can
   never affect game state.
4. Replays, spectators, and shared variants work for the lifetime of the
   feature without breaking when a variant is later deleted.

## Non-goals

- AI-authored rule logic JS. The warrior reference architecture's
  server-authoritative `brain` function is **not** ported. Chess turns are
  short and deterministic; running untrusted JS in the move loop introduces
  desync risk, latency, and a much larger sandbox surface for ~5% more
  creativity. We may revisit if the data-driven version genuinely runs out of
  expressiveness.
- New board sizes, new piece types, drops, hex grids, multi-board variants.
  Same 8x8, same six FEN piece types as today.
- Per-user spend caps or paid tiers (yet). Free for everyone, hard global
  $200/month cap shared with `coach` is the day-1 monetization.

## Defense in depth (the real architecture)

After several rounds of "Gemini emits variants the user can't actually play"
hard lessons, the design crystallized around **layered defenses, mostly engine-
side**. The system prompt is no longer the only line of defense — it's just
the first layer in a pipeline that ends with a programmatic verifier and
deterministic auto-repair.

```
   ┌─────────────────────────────────┐
   │ User prompt                     │
   └────────────────┬────────────────┘
                    │
                    ▼
   ┌─────────────────────────────────┐
   │ Pre-flight prompt sanity check  │  CHEAP, no AI call
   └────────────────┬────────────────┘
                    │
                    ▼
   ┌─────────────────────────────────┐
   │ STEP 1: Behaviour Planner       │  Gemini, ~500 tok out
   │ (prose vibe; non-fatal)         │
   └────────────────┬────────────────┘
                    │
                    ▼
   ┌─────────────────────────────────┐
   │ STEP 2: Variant Factory         │  Gemini, JSON schema
   │ (rule diff w/ schema mode)      │
   └────────────────┬────────────────┘
                    │
                    ▼
   ┌─────────────────────────────────┐
   │ Structural validator            │  PURE FUNCTION, server + client
   │ (schema, types, ranges, AST)    │
   │ ─ on fail: 1 Gemini retry       │
   └────────────────┬────────────────┘
                    │
                    ▼
   ┌─────────────────────────────────┐
   │ Behavioural verifier (NEW)      │  PURE FUNCTION, runs the engine
   │ (verification.js)               │
   │ ─ ability reachability ≤4 plies │
   │ ─ win-condition feasibility     │
   │ ─ 8-game random-walk sim        │
   └────────────────┬────────────────┘
                    │ failed
                    ▼
   ┌─────────────────────────────────┐
   │ Auto-repair (NEW)               │  PURE FUNCTION, no AI
   │ (repair.js)                     │
   │ ─ extend too-narrow offsets     │
   │ ─ flip blockedByPieces=false    │
   │ ─ remove maxRange caps          │
   │ ─ re-verify                     │
   └────────────────┬────────────────┘
                    │ still failed
                    ▼
   ┌─────────────────────────────────┐
   │ Repair-via-Gemini retry (NEW)   │  ONE Gemini call w/ verifier hint
   │ ("previous attempt failed       │
   │  because X; please fix that.")  │
   └────────────────┬────────────────┘
                    │ still failed
                    ▼
   ┌─────────────────────────────────┐
   │ Friendly user error             │  "Try rephrasing your prompt."
   └─────────────────────────────────┘
```

Why each layer exists:

- The **system prompt** sets up the schema. It can't enforce playability —
  the LLM doesn't have a chess board to verify against. So we keep the prompt
  focused on the schema + a few worked examples, no hand-tuned fragile
  geometry rules.
- The **structural validator** catches malformed JSON, unknown effect kinds,
  out-of-range parameters. Pure shape checks. The AI gets one retry with the
  errors fed back.
- The **behavioural verifier** runs the actual engine to confirm the variant
  is PLAYABLE. Specifically: every declared ability must be reachable within
  4 plies of legal play, win conditions must be satisfiable, and an 8-game
  random simulation must show abilities firing. This is where we catch the
  "AI emitted offsets that don't reach turn-1 enemies" failure that plagued
  the early ship.
- The **auto-repair pass** is deterministic. The most common failure
  (offset coverage too narrow) has a programmatic fix: union the AI's offsets
  with a baseline queen-fan + knight-jumps, flip `blockedByPieces=false` on
  slide abilities so they reach through opening-rank pawns, drop tight
  maxRange caps. No AI call, no extra tokens.
- The **repair-via-Gemini retry** is the last AI call. We feed the verifier's
  errors back as a focused hint so Gemini knows exactly what to fix. One
  retry max — beyond that we save rate-limit tokens and surface a friendly
  user error.

Live-AI testing (see `__live-prompts.test.js`) shows this pipeline reaches
**~90% playability** across a 20-prompt diverse adversarial set covering
happy-path, edge cases, vague/gibberish prompts, prompts asking for engine-
incompatible features, and adversarial / jailbreak attempts. Total cost per
batch is ~$0.013 / €0.012, which makes it cheap enough to run as a CI
regression gate before any prompt change.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client (browser)                        │
│                                                                 │
│  ArenaPage  ─→  ArenaRoom                                       │
│                  │                                              │
│                  ├─ InteractiveBoard            (existing)      │
│                  ├─ AnimationOverlay  (NEW)     <canvas>        │
│                  │   ├─ piece slots (per-piece pre-translated)  │
│                  │   ├─ projectiles (absolute coords)           │
│                  │   └─ board effects (full canvas)             │
│                  │                                              │
│                  └─ TurnInputLock     (NEW)                     │
│                      animations block input until ttl reaches 0 │
│                                                                 │
│  lib/arena/                                                     │
│    schema.js          ← extended: abilities, slots, brain spec  │
│    rules.js           ← extended: resolveRules merges abilities │
│    move-gen.js        ← extended: `ranged` primitive            │
│    apply-move.js      ← extended: ability moves, status effects │
│    validator.js       ← extended: validates abilities, sandboxes│
│    sandbox.js         (NEW) AST validator + loop-guard injector │
│    crazy-state.js     (NEW) per-piece status state sidecar      │
│    animation-queue.js (NEW) intensity-tiered input lock         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ supabase-js (existing)
                              │
┌─────────────────────────────────────────────────────────────────┐
│                  Supabase Edge Function (Deno)                  │
│                                                                 │
│  arena_rules/index.ts                                           │
│   ├─ existing: auth, rate limit, $-cap, CORS                    │
│   ├─ NEW: 3-step Gemini pipeline                                │
│   │   1. planner   (prose vibe) ────────→  Gemini Flash         │
│   │   2. factory   (rules JSON + draws) ─→  Gemini Flash        │
│   │   3. critic    (validate + score) ──→  structural + sim     │
│   ├─ existing: structural validator (extended for abilities)    │
│   └─ NEW: AST validator on every emitted JS body                │
│                                                                 │
│  RPC: record_arena_rules_call         (existing, untouched)     │
│  RPC: record_ai_spend_or_block        (existing, untouched)     │
│  Table: arena_rooms                   (existing + crazy_state)  │
│  Table: arena_moves                   (existing + state_after)  │
│  Table: arena_variants                (NEW, saved variants)     │
└─────────────────────────────────────────────────────────────────┘
```

## Schema diff

The existing rule object grows three new top-level concerns. Everything
remains optional — a variant that doesn't use abilities or visuals just omits
the new fields and behaves like today.

### Effect primitives (Ship #2 design shift)

The original ship #2 plan had a fixed enum of named effects (freeze, burn,
shield, ...). This was too narrow for "the user can prompt anything
physical" — bowling pawns, throwing pieces, mind-control, summon walls, all
require mechanics outside the named set.

Ship #2 replaces the enum with **seven composable primitives** the AI
combines to express any physical mechanic. The engine resolves each
primitive deterministically; the AI never writes rule logic JS.

| Primitive | What it does |
| --- | --- |
| `destroy` | Remove the target piece. (Ship #1's `capture` is this under the hood.) |
| `displace` | Move target piece to a new square. Push, pull, throw, knockback, bowling. |
| `relocate_self` | Move the caster to a new square as part of the cast. Teleport, blink, charge. |
| `spawn` | Create a piece on an empty square. Summon, resurrect, conjure-wall. |
| `transform` | Change a piece's type or color, with optional revert-on-expiry. Charm, polymorph. |
| `mark` | Apply a tagged status that the engine ticks. Freeze, burn, shield, stun, root, silence, haste — and any future status. |
| `aoe_wrap` | Apply any of the above to neighbors of the target within a radius. Splash damage, chain effects, AOE freeze. |

The `mark` primitive is the status-effect catch-all. AI emits a `tag` string
(any name: `"frost"`, `"poisoned"`, `"hexed"`, `"blessed"`, `"berserker"`)
and **behavioral fields** that the engine acts on:

- `skip_turns: bool` — frozen pieces emit zero moves while active
- `silence_abilities: bool` — silenced pieces can move but not cast
- `absorb_captures: int` — shield: absorbs N incoming captures, then breaks
- `extra_moves: int` — haste: owner gets N extra moves on this piece this turn
- `destroy_on_expire: bool` — burn: piece dies when timer hits 0
- `expire_on_capture: bool` — shield-style marks that drop on absorbing
- `revert_to: { type, color }` — what `transform` reverts to when the mark expires
- `duration: int` — plies remaining (omit = permanent)

The `tag` string itself is just a label for ship #3+ visuals. Engine cares
only about the behavioral fields.

**Why this works:** "Knight bowls pawns down a file" becomes a knight
ability with `effect: { kind: "displace", target_filter: "friendly_pawn",
along_line: { dir: "forward", maxRange: 8 }, on_collision: "destroy_both"
}`. "Frost mage" becomes `effect: { kind: "aoe_wrap", radius: 2, inner: {
kind: "mark", tag: "frost", duration: 2, skip_turns: true } }`. "Yeet the
king" becomes `effect: { kind: "displace", direction: "away_from_caster",
distance: 4 }`. Every physically-expressible mechanic resolves to a
composition of the seven primitives.

### 1. `abilities` on `PieceMoveSpec`

Each piece type can have any number of named active abilities. An ability is
an active-cast effect: instead of moving, the piece spends a charge / triggers
a cooldown to apply an effect at a target square within range.

```jsonc
{
  "extends": "vanilla",
  "pieces": {
    "q": {
      "abilities": [
        {
          "id": "fireball",
          "label": "Fireball",
          "target": {
            "kind": "ranged",
            "offsets": [/* knight-like leap set */] | null,
            "dirs":    [/* slide directions */]   | null,
            "maxRange": 5,
            "requireEnemy": true,
            "requireEmpty": false,
            "blockedByPieces": false
          },
          "effect": {
            "kind": "capture",
            "aoe": { "radius": 1, "hitsPawns": false, "hitsFriendly": false }
          },
          "gating": {
            "charges": 2,           // total uses per match (omit = unlimited)
            "cooldownPlies": 4,     // plies between casts (omit = no cooldown)
            "startsOnCooldown": false
          },
          "intensity": "medium",    // brief | medium | dramatic
          "animation": {
            "projectile": { "drawSrc": "/* JS body, see Sandbox */" },
            "impact":     { "drawSrc": "/* JS body */" }
          }
        }
      ]
    }
  }
}
```

`target.kind` reuses the existing primitive vocabulary — `leap` (offset list),
`slide` (directions + maxRange), or the new `ranged` (which is a leap with a
`requireEnemy` filter and an `aoe` effect, conceptually).

`effect.kind` is initially:

- `"capture"` — remove the target piece (and AOE neighbors per `effect.aoe`)
- `"freeze"` — apply a `frozen` status effect to the target for N plies
- `"burn"` — apply `burn` status with N plies remaining
- `"shield"` — apply `shield(N)` to a friendly target
- `"swap"` — swap the caster with a friendly target piece
- `"summon"` — spawn a piece of given type on an empty target square
- `"teleport"` — move the caster to the target empty square (ignoring blockers)

Future ships (#3, #4) add `chain`, `knockback`, `resurrect`, `aura`. Each
one is a hand-coded resolver in `apply-move.js` — the AI cannot invent new
effect kinds.

### 2. `slots` and `brain` on `PieceMoveSpec` (Ship #3)

```jsonc
{
  "pieces": {
    "q": {
      "slots": {
        "body":     { "drawSrc": "/* JS */" },
        "head":     null,
        "back":     null,
        "weapon_R": { "drawSrc": "/* JS */" },
        "weapon_L": null,
        "feet":     null,
        "aura":     { "drawSrc": "/* JS, painted UNDER body */" }
      },
      "brain": {
        "drawSrc":  "/* JS body — purely cosmetic per-frame hook */"
      }
    }
  }
}
```

Each `drawSrc` is a function body string. Signatures:

- Slot: `(ctx, x, y, facing, owner, t) => void` — pre-translated to the
  piece's screen coords. Box of ~80×80 around `(0, 0)`. `t` is wall-clock ms
  since match start.
- Brain: `(self, world, dt) => void` — runs once per move (NOT per-frame; see
  Non-goals). Can call `world.spawnEffect({ at, drawSrc, ttlMs, intensity })`
  to schedule a passive cosmetic effect. Cannot mutate any game state.
- Projectile: `(ctx, p) => void` where `p = { x, y, fromX, fromY, toX, toY,
  progress: 0..1 }`. Painted on absolute board coords every frame.
- Effect: `(ctx, e, t) => void` where `e = { x, y, ageMs, ttlMs }`.

### 3. `crazy_state` sidecar

Status effects, charges, and cooldowns live alongside the FEN, not in it.
This keeps FEN compatible with `chess.js` (used by SAN display) and avoids
inventing an extended FEN format.

```jsonc
{
  "effects": {
    "e4": [{ "kind": "frozen", "expiresPly": 12 }],
    "d5": [{ "kind": "burn",   "expiresPly": 14, "perPly": 1 }]
  },
  "charges":   { "d1": { "fireball": 1 } },
  "cooldowns": { "d1": { "fireball": 3 } }   // plies remaining
}
```

DB-side:

- `arena_rooms.crazy_state JSONB` — the current state, mirrored on both
  clients via the existing realtime channel.
- `arena_moves.state_after JSONB` — snapshot at end of every move, for
  replay scrubbing. Optional; if null, the replay re-runs the resolver.

## Sandbox model

This is the highest-stakes piece. The whole "AI writes visual JS" idea
collapses if we can't draw a hard line between "this code runs" and "this
code can do harm."

### Validator pipeline

Every `drawSrc` string flows through this pipeline before it ever
executes:

```
                                       ┌─ reject if any error ─┐
factory.responseJsonSchema  ────→  parse with acorn           │
                                       │                       │
                                       ├─ walk AST, allowlist ─┤
                                       │  identifiers          │
                                       │                       │
                                       ├─ inject loop-guard ───┤
                                       │  on every loop +      │
                                       │  function entry       │
                                       │                       │
                                       └─ stringify back ──────→  saved
```

### Allowlist (exact)

**Permitted globals (whole-identifier match):**

```
Math, Math.PI, Math.E,
Math.abs, Math.floor, Math.ceil, Math.round, Math.sign,
Math.min, Math.max, Math.pow, Math.sqrt, Math.hypot,
Math.sin, Math.cos, Math.tan, Math.atan2, Math.log,
Math.exp, Math.random,   ← REPLACED at runtime by seeded PRNG
Number.isFinite, Number.isInteger,
Array.from, Array.isArray,
Object.keys, Object.values, Object.entries,
String, Number, Boolean,
JSON.stringify, JSON.parse,
parseInt, parseFloat,
isNaN, isFinite
```

**Permitted member access (anywhere):**

```
ctx.<canvas-2d API>      // fillStyle, fillRect, fill, beginPath, arc,
                         //   moveTo, lineTo, closePath, save, restore,
                         //   translate, rotate, scale, globalAlpha,
                         //   strokeStyle, lineWidth, stroke, etc.
                         //   FULL list documented inline in sandbox.js.
                         //   ctx.fillText / ctx.strokeText BANNED.
.x .y .progress .age* .ttl* .fromX .fromY .toX .toY
self.* (whitelisted: type, color, square, hp, charges)
world.spawnEffect, world.spawnProjectile  (brain only)
```

**Banned everywhere (any occurrence rejects the variant):**

```
fetch, XMLHttpRequest, WebSocket, EventSource,
import, eval, Function, new Function,
document, window, globalThis, self.constructor,
localStorage, sessionStorage, indexedDB, cookie,
postMessage, addEventListener, navigator,
setTimeout, setInterval, requestAnimationFrame,
process, require, module, exports,
ctx.fillText, ctx.strokeText, ctx.drawImage   ← visual safety
__proto__, prototype, constructor              ← prototype escape
new Date  (use t parameter for time)
```

Any token outside the allowlist that's not also banned **defaults to
reject** — better to lose a creative draw than to leak a sandbox
identifier.

### Loop-guard injection

Every `for`, `while`, `do-while` gets an injected counter check:

```js
// before
for (let i = 0; i < n; i++) { /* body */ }

// after
{ let __g = 0; for (let i = 0; i < n; i++) {
    if (++__g > 5000) throw new Error("loop-guard");
    /* body */
} }
```

Every function entry gets a wall-clock check:

```js
// before
function foo(a) { /* body */ }

// after
function foo(a) {
  const __t0 = performance.now();
  /* body, with periodic if (performance.now() - __t0 > 40) throw ... */
}
```

The 5000 / 40ms numbers come straight from the warrior reference. Per-frame
the budget is much tighter than the limits — at 30 fps draw budget we have
~33ms total across all pieces.

### Runtime sandbox

```js
// Per drawSrc:
const fn = new Function("ctx", "x", "y", "facing", "owner", "t", body);

// Wrapped:
function safeDraw(ctx, x, y, facing, owner, t) {
  try {
    fn(ctx, x, y, facing, owner, t);
  } catch (e) {
    crazyState.errorCount += 1;
    if (crazyState.errorCount > 30) {
      // Pause match, offer "regenerate variant?"
    }
  }
}
```

Errors don't propagate — a single piece's draw can fail without bringing
down the rest of the board. After 30 errors total per match the user is
prompted to regenerate the variant. The chess game keeps playing throughout.

## Three-step Gemini pipeline

The existing `arena_rules` Edge Function makes one Gemini call. Crazy arena
makes three sequential calls inside the same function invocation:

### Step 1 — Behaviour Planner

```
model:    gemini-2.5-flash
temp:     0.9
thinking: low
output:   prose, ~500 tokens
```

Prompts Gemini for three short prose fields describing the variant's vibe:

```jsonc
{
  "fighting_style":     "...",  // 1-2 sentences, how the army feels in play
  "signature_mechanic": "...",  // 1-2 sentences, the headline ability
  "under_pressure":     "..."   // 1-2 sentences, what happens when losing
}
```

Pure prose. No code. No JSON schema. Used as the planning context for the
factory call.

### Step 2 — Variant Factory

```
model:    gemini-2.5-flash
temp:     0.95
thinking: medium
output:   JSON, up to 16384 tokens
schema:   responseJsonSchema (the full extended rules object)
```

Receives the user's prompt + the planner output. Emits the full rules JSON
including abilities and (in Ship #3+) `slots` / `brain` JS. The
`responseJsonSchema` enforces structure; the existing structural validator
catches type errors; the AST validator catches sandbox escapes.

If the structural validator OR the AST validator rejects, we auto-retry once
with the rejection reasons appended to the prompt (existing pattern — see
`arena_rules/index.ts` line 925-943).

### Step 3 — Critic

```
provider: structural validator + 100-game random simulation
no Gemini call
```

After both validators pass, run the critic:

1. **100-game random simulation** server-side. Use the existing
   `validator.js` simulator with `simulations: 100`, deterministic seeded
   PRNG.
2. Reject if win rate is > 80% one-sided (unfair).
3. Reject if termination rate < 30% within 200 plies (game won't end).
4. Otherwise accept and return.

This is a hand-coded critic, no extra Gemini cost. We can upgrade to a
Gemini-based "is this fun" critic later if structural balance isn't enough.

## Animation overlay

A new `<canvas>` mounted absolute-positioned over `<InteractiveBoard>`. Same
DOM size, no pointer events (passes clicks through). Driven by a
`requestAnimationFrame` loop targeting 30fps.

Per frame:

1. Clear the canvas.
2. For each piece on the board:
   - Look up its `slots`. For each non-null slot, save context, translate to
     screen coords for that square, call the `drawSrc`, restore context.
3. For each active projectile, call its `drawSrc(ctx, p)` on absolute coords.
4. For each active effect, call `drawSrc(ctx, e, t)`.
5. Decrement projectile / effect ttls; remove expired ones.

Animations block input via a separate `animation-queue.js` lock. When a
move is committed, the engine emits a list of animations to play
(intensity-tiered). The lock holds the next-move input until the highest
intensity tier finishes:

- `brief` (200ms) — ordinary moves, captures, en passant
- `medium` (800ms) — ability casts, status effect applies
- `dramatic` (2000ms) — game-ending moves, big AOE

The intensity tier is server-stamped on every animation descriptor, so a
malicious AI can't make every move take 5 seconds.

## Saved variants

A new table holds the variants users explicitly save:

```sql
create table public.arena_variants (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references public.profiles(id) on delete cascade,
  prompt      text not null check (char_length(prompt) <= 2000),
  rules_json  jsonb not null,    -- factory output (post-validation)
  planner_json jsonb not null,   -- planner output, kept for replay context
  visibility  text not null default 'private'
              check (visibility in ('private', 'unlisted', 'public')),
  name        text generated always as (rules_json ->> 'name') stored,
  description text generated always as (rules_json ->> 'description') stored,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index arena_variants_owner_idx on public.arena_variants(owner);
create index arena_variants_visibility_idx on public.arena_variants(visibility)
  where visibility != 'private';
```

RLS:

- Read: owner sees their own; everyone reads `visibility = 'public'`;
  `unlisted` reads only via the share link (id-by-id reads, no listing).
- Write: owner only.

UI:

- Existing arena create panel: optional "save as variant" toggle.
- New `/arena/variants` page: list owner's variants + browse public ones.
- "Use this variant" button creates a room with the saved variant's
  `rules_json` skipping the prompt.

## Replay format

Replays already work via the existing `arena_moves` table (move list +
final FEN). For crazy arena we add:

- `arena_rooms.snapshot` — JSONB snapshot of `rules_json` + `planner_json`
  taken when round 1 starts. Frozen for the rest of the match. If the
  variant is later deleted from `arena_variants`, the replay still has
  everything it needs.
- `arena_moves.state_after` — JSONB snapshot of `crazy_state` after the
  move. Optional; if null, the replay re-runs the resolver.

Replay viewer: same component as live, but with `replay = true` flag that
disables input + plays animations at 2x speed.

## Cost math (revised)

Existing single-call arena_rules:
- Input ~3-4 KB system prompt + ~600 char user prompt → ~1100 tokens
- Output ~500 tokens
- Cost: ~`$0.0003` / call → up to ~600,000 / month at $200 cap

Crazy arena three-step:
- **Planner**: 2 KB system + planner prompt → ~500 in / ~200 out → `$0.0001`
- **Factory**: 6 KB system + planner output as context → ~2000 in / ~10000 out → `$0.003`
- **Critic**: hand-coded, no AI cost
- Total: ~`$0.003` per generation, ~10x existing cost
- Budget: ~67,000 generations/month at $200 cap

In Ship #3+ when AI writes draw code:
- Factory output grows to ~30K tokens for visuals → ~`$0.01` per generation
- Budget: ~20,000 generations/month at $200 cap

With the existing rate limit of 10/10min/user, a single user can spend at
most `60 calls/hour × 24 hours × 30 days × $0.01 = $432/month`, so
**aggregate** spend is well-bounded by the per-user limit and the
$200/month global cap, but a single power user can blow the global cap.

When opening to >10 active users we add per-user monthly spend caps (cheap
RPC change), defaulting to $20/user/month.

## Threat model

| Vector | Mitigation |
| --- | --- |
| Prompt injection extracts API key from system prompt | Edge Function strips system prompt from any user-visible response. AST validator on output (no string concat from system prompt to JS body). |
| AI hallucinates `fetch(...)` in a draw | AST identifier allowlist rejects. |
| AI writes infinite loop in a draw | Loop-guard injection breaks it after 5000 iters / 40ms. |
| AI writes a draw that silently CPU-spins | Per-frame draw budget enforced; piece silently disabled after 30 errors. |
| Player A serves a malicious variant to player B | All AST + structural validation runs server-side BEFORE the variant gets into a room. Player B only ever sees rules + draws that have passed the validator. |
| AI writes `ctx.fillText("slur")` | `ctx.fillText` and `ctx.strokeText` are AST-banned. No text rendering allowed from AI code. |
| AI writes `new Function("...")` | `Function`, `eval`, `import`, `constructor` access banned. |
| Saved variant re-used after schema change | Variants store the schema version. On load, if version is unsupported, render with vanilla pieces + show "this variant uses an older format" banner. |
| Cost runaway via prompt automation | Existing rate limit (10/10min/user) + global $-cap. Per-user $-cap added before public launch. |
| Replay viewer playing stale variant whose code now fails | Same try/catch + 30-error limit. Replay falls back to static board if visuals fail. Match outcome already in DB so this is purely cosmetic. |

## Rollout (4 ships)

### Ship #1 — `ranged` primitive + abilities (this PR)

- Schema: add `abilities` to `PieceMoveSpec`, add `target.kind: "ranged"`
  primitive, add `effect.kind: "capture"` (with `aoe` shape).
- Engine: `move-gen.js` generates ability moves marked `kind: "ability"`,
  `apply-move.js` resolves them (capture target, do not move caster, decrement
  charge, start cooldown).
- Validator: structural checks for the new shape.
- Three-step Gemini pipeline replaces the single call. Critic is structural
  + the existing 50-game simulator with `simulations: 100`.
- Hand-coded animations for ability fires (red flash on the target square,
  120ms). No AI-written visuals yet.
- Tests: ranged primitive parity, charges/cooldowns honored, validator
  rejection cases, three-step pipeline mock parsing.

### Ship #2 — Composable primitives + crazy_state sidecar (PARTIAL — engine + DB landed; UI deferred to Ship #2.5)

Replaces the original "fixed status enum" plan with the seven-primitive
composable system. Internal-testbed-only behind `profiles.crazy_arena_lab`.

**Landed in this PR:**
- ✅ **Engine:** seven primitives (`destroy`, `displace`, `relocate_self`,
  `spawn`, `transform`, `mark`, `aoe_wrap`) implemented in
  `src/lib/arena/effects.js`. Apply-move (`apply-move.js`) calls into
  them; move-gen (`move-gen.js`) respects `mark.skipTurns` and
  `mark.silenceAbilities` so frozen pieces emit zero moves and
  silenced pieces can move but not cast. Strict failure mode: any
  cast anomaly throws a `VariantError` from `applyMove`.
- ✅ **Engine state:** `Position.crazyState` sidecar carries marks,
  charges, cooldowns. Marks tick at end of every move (regular OR
  ability). `addMark`, `tickMarks`, `tryAbsorbCapture`,
  `dropExpireOnCaptureMarks`, `pieceEffectiveState` exported for
  use by move-gen + apply-move.
- ✅ **Validator:** mirrored client (`validator.js`) and server
  (`arena_rules/index.ts`) range-check every primitive. Lab flag
  threads through both - outside the lab only `destroy`/`capture`
  effect kinds are accepted.
- ✅ **DB migration:** `arena_rooms.crazy_state JSONB`,
  `arena_moves.state_after JSONB`, `arena_moves.ability_id`,
  `arena_moves.move_kind`, `profiles.crazy_arena_lab BOOLEAN`,
  and a `get_crazy_arena_lab()` RPC. Migration is in
  `supabase/schema.sql`.
- ✅ **AI prompt:** rewritten around primitives with seven worked
  examples covering fireball, bowling knights, necromancer bishops,
  mind-control wizard, frost mage, blink rook, burning fingers.
  Tells Gemini explicitly: translate any physical prompt into
  compositions. Lab gate in `buildPrompt` instructs Gemini to use
  only Ship #1 effects when the user isn't in the lab.
- ✅ **Tests:** 19 new primitive tests in `effects.test.js` cover
  destroy back-compat, displace with bowling collisions, edge
  destroy, relocate_self/blink, spawn move-gen filter, transform
  with revert, mark with skipTurns / destroyOnExpire / shield
  absorb, aoe_wrap freezing pieces in radius. Plus 5 validator
  rejection cases. Total 166/166 tests passing.

**Deferred to Ship #2.5 (separate PR before #3):**
- ❌ Ability targeting UI in `ArenaRoom.jsx` + `InteractiveBoard`.
  Without this, only random-bot warmup and bot-vs-bot play exercise
  the new primitives - human players can't easily cast.
- ❌ Plain-text status badges on squares with active marks.
- ❌ "Variant error - match cancelled" toast + DB-side round-as-
  draw write when `applyMove` throws a `VariantError`.
- ❌ Server-side 100-game simulation critic. The existing
  client-side validator's deterministic mobility check is the
  only fairness gate today; the simulator critic remains a Ship
  #2.5 followup.

**No CSS animations, no overlays, no canvas, no projectiles in
this PR or Ship #2.5.** Ship #3 lands AI-written visuals on top
of the now-complete data layer.

### Ship #3 — AI-written `slots` (per-piece visuals)

- Schema: add `slots` field on `PieceMoveSpec`.
- Sandbox: implement the AST validator + loop-guard injector.
- Animation overlay: mount the canvas, RAF loop, per-piece draws.
- AI prompt: teach Gemini about slot drawing with worked examples.
- Saved variants table.

### Ship #4 — Projectiles + brain + full-board overlays

- Schema: `slots.brain`, projectile/effect `drawSrc` inside ability
  `animation` field.
- Engine: spawn projectiles on ability fire, tick them, animate.
- Animation queue: intensity-tiered input lock.
- AI prompt: full crazy-mode prompt with all features.

After ship #4 the system matches the warrior architecture's visual scope
(piece slots, projectiles, effects, full-board overlays) without ever giving
the AI authority over rule outcomes.

## Open questions (deliberately deferred)

- **Per-user spend caps** → before opening alpha to >10 users.
- **AI-written brain that decides outcomes** → revisit only if data-driven
  effects feel limiting after 4 ships.
- **Public variant gallery + community moderation** → ship #5+.
- **Mobile UX for ability targeting** → tested in ship #1 with the
  click-piece-then-target flow; revisit if it feels bad.
