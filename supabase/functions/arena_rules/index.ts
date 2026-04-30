// Deno-based Supabase Edge Function - AI Arena rule generator.
//
// Takes a free-form natural-language prompt and returns a
// structured rule diff that the client engine resolves at
// runtime. The Edge Function is the only sanctioned path -
// keys stay server-side, rate limit is enforced via the
// `record_arena_rules_call` RPC, and the structural validator
// runs server-side BEFORE any AI output reaches a client.
//
// CRAZY ARENA SHIP #1 (this revision):
// Variant generation is a 3-step pipeline matching the warrior
// architecture pattern.
//
//   STEP 1 - Behaviour Planner (prose):
//     Gemini Flash, temp 0.9, ~500 output tokens. Three short
//     prose fields describing the variant's vibe (fighting
//     style, signature mechanic, pressure response). No JSON
//     schema, no code. Output feeds into the factory step's
//     prompt as creative context.
//
//   STEP 2 - Variant Factory (structured JSON):
//     Gemini Flash, temp 0.95, up to 16K output tokens, JSON
//     schema mode. Emits the full rule diff including the new
//     `abilities` field on each piece. Auto-retries once if
//     the structural validator rejects.
//
//   STEP 3 - Critic (deterministic, no Gemini call):
//     Hand-coded structural + simulation critic. Runs a
//     100-game random-walk simulation server-side and rejects
//     variants whose win rate is > 80% one-sided or which
//     terminate < 30% of the time. Catches the obviously broken
//     variants without burning another AI call.
//
// Flow per request:
//   1. JWT-auth the caller (handled by Supabase platform).
//   2. Burn one rate-limit token via record_arena_rules_call.
//      If the user is over the cap, return 429 with retry
//      countdown.
//   3. Pre-flight $-cap guard via record_ai_spend_or_block.
//   4. STEP 1 (planner) - get prose vibe.
//   5. STEP 2 (factory) - get structured rule JSON.
//   6. STEP 3 (critic) - structural + 100-game simulation.
//   7. The client does a second-pass full validation on
//      receipt - defense in depth.
//
// Deploy:
//   1. Get a Gemini API key from https://aistudio.google.com.
//   2. Set as a function secret:
//        npx supabase --workdir .. secrets set GEMINI_API_KEY=...
//      (optionally GEMINI_MODEL=gemini-2.5-flash)
//   3. Deploy:
//        npx supabase --workdir .. functions deploy arena_rules

import { createClient } from "jsr:@supabase/supabase-js@2";

// ── Hard limits ──
const MAX_PROMPT_CHARS = 2000;
const DEFAULT_MODEL = "gemini-2.5-flash";

// ── Rate limit defaults (must match the SQL RPC defaults) ──
const RATE_LIMIT_WINDOW_SECONDS = 600; // 10 min
const RATE_LIMIT_MAX_CALLS = 10;

// ── Types ──

interface ArenaRulesRequest {
  /** Natural-language description of the variant. */
  prompt?: string;
}

interface ArenaRulesResponse {
  ok: boolean;
  /** Structured rule diff with extends="vanilla" + overrides. */
  rules?: Record<string, unknown>;
  /** Brief human-readable summary the model returned alongside the diff. */
  summary?: string;
  /**
   * Three short prose fields produced by the planner step (Ship #1+).
   * Optional - if the planner errored we skip it and the field is
   * undefined. Useful for the lobby UI to surface "design brief"
   * context to both players.
   */
  planner?: {
    fighting_style: string;
    signature_mechanic: string;
    under_pressure: string;
  };
  /** Validator errors when ok=false and we couldn't recover. */
  validatorErrors?: string[];
  error?: string;
  model?: string;
  rate_limit?: {
    calls_in_window: number;
    max_calls: number;
    window_seconds: number;
  };
  retry_after_seconds?: number;
}

interface RateLimitResult {
  ok: boolean;
  allowed: boolean;
  retryAfterSeconds: number;
  callsInWindow: number;
  maxCalls: number;
  windowSeconds: number;
  error?: string;
}

// ── Auth + rate limit (lifted from coach/index.ts) ──

function makeAuthedClient(req: Request) {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return null;
  return createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Look up the caller's `crazy_arena_lab` flag (Ship #2). Returns
 * false on any error, including unauthenticated callers - the flag
 * gates an internal-testbed-only feature so failing closed is the
 * safe default.
 */
async function getCrazyArenaLabFlag(req: Request): Promise<boolean> {
  const supabase = makeAuthedClient(req);
  if (!supabase) return false;
  const { data, error } = await supabase.rpc("get_crazy_arena_lab");
  if (error) return false;
  return data === true;
}

async function recordRateLimitedCall(req: Request): Promise<RateLimitResult> {
  const supabase = makeAuthedClient(req);
  if (!supabase) {
    return {
      ok: false, allowed: false, retryAfterSeconds: 0,
      callsInWindow: 0, maxCalls: RATE_LIMIT_MAX_CALLS,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
      error: "Supabase client unavailable",
    };
  }
  const { data, error } = await supabase.rpc("record_arena_rules_call", {
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
    p_max_calls: RATE_LIMIT_MAX_CALLS,
  });
  if (error) {
    return {
      ok: false, allowed: false, retryAfterSeconds: 0,
      callsInWindow: 0, maxCalls: RATE_LIMIT_MAX_CALLS,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
      error: error.message,
    };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return {
      ok: false, allowed: false, retryAfterSeconds: 0,
      callsInWindow: 0, maxCalls: RATE_LIMIT_MAX_CALLS,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
      error: "Empty rate-limit response",
    };
  }
  return {
    ok: true,
    allowed: !!row.allowed,
    retryAfterSeconds: Number(row.retry_after_seconds) || 0,
    callsInWindow: Number(row.calls_in_window) || 0,
    maxCalls: Number(row.max_calls) || RATE_LIMIT_MAX_CALLS,
    windowSeconds: Number(row.window_seconds) || RATE_LIMIT_WINDOW_SECONDS,
  };
}

// ── Prompt construction ──

const SYSTEM_PROMPT = `You are an expert chess variant designer. The user describes a variant in natural language; you produce a strict JSON rule diff that an engine can read directly.

CRITICAL OUTPUT FORMAT:
- Reply with ONLY a single JSON object. No markdown fences, no comments, no prose, no trailing commas.
- The output must be parseable by JavaScript JSON.parse on the first try.
- Every key/value pair you write must be syntactically valid JSON.

Top-level fields the engine accepts (omit any you don't need):
- "extends": always the string "vanilla".
- "name": short label, max 3 words.
- "description": 1-2 sentences describing the variant in plain English.
- "overrides": object with optional "startingFen" (valid FEN string) and optional "maxPlies" (integer 10..2000).
- "pieces": object keyed by piece type ("p", "n", "b", "r", "q", "k"). Only include pieces you are actually changing.
- "byColor": object keyed by color ("w" or "b"), each containing a pieces-shaped subobject. Only use this for asymmetric variants.
- "capture": object with optional "explosionRadius" (integer 0..3) and optional "convert" (boolean, currently must be false).
- "winConditions": ordered array of win condition objects, first to fire ends the game.

Each piece spec is an object with these optional fields:
- "moves": array of move primitives (see below).
- "castling": object with optional booleans "kingside", "queenside", "requireUnmoved" and optional arrays "requireEmpty" and "requireSafe".
- "promotion": object with array "type", each entry being one of "n", "b", "r", "q".
- "abilities": array of active-cast abilities (see "Active abilities" section below). NEW.

Move primitives (used inside "moves" arrays). Coordinates are [file_delta, rank_delta] pairs from White's POV; the engine flips rank for Black.

1. Slide primitive:
   { "kind": "slide", "dirs": [[df,dr], ...], "maxRange": 1..8 }
   The "maxRange" field is optional. Slides in each direction until blocked.

2. Leap primitive:
   { "kind": "leap", "offsets": [[df,dr], ...] }
   Single-square jump per offset. Knight and king moves use this.

3. Step primitive:
   { "kind": "step", "dirs": [[df,dr], ...], "conditions": { ... } }
   Single-square step. The "conditions" field is optional and may contain any of these booleans: "onlyFirstMove", "onlyCapture", "onlyNonCapture", "enPassant".

ACTIVE ABILITIES (the headline feature for crazy arena):
A piece can have any number of active-cast abilities. On a player's turn they choose between MOVING the piece OR casting one of that piece's abilities. An ability spends a charge / starts a cooldown to apply an effect at a target square within range. The caster does NOT move when casting (it's a turn-replacing action, not a move) - UNLESS the effect is "relocate_self".

Ability shape:
{
  "id": "fireball",                              // lowercase, alpha+digits+underscore, unique within a piece
  "label": "Fireball",                           // optional, UI label
  "target": {
    "kind": "ranged" | "leap" | "slide",         // "ranged" = leap with requireEnemy default true; "leap" = same shape but works on empty squares too (use for summon/teleport); "slide" = ray-cast in dirs.
    "offsets": [[df,dr], ...],                   // required for "ranged" or "leap"
    "dirs": [[df,dr], ...],                      // required for "slide"
    "maxRange": 1..8,                            // optional for "slide"
    "requireEnemy": true,                        // default true; set false for self-effects/teleports/spawns
    "requireEmpty": false,                       // default false; set true for spawn/teleport
    "blockedByPieces": true                      // default true for slide; set false to fire through pieces
  },
  "effect": <EFFECT_PRIMITIVE>,                  // see EFFECT PRIMITIVES below
  "gating": {
    "charges": 1..99,                            // total uses per match. Strongly recommended.
    "cooldownPlies": 1..20,                      // plies between casts. Recommended.
    "startsOnCooldown": false                    // optional
  },
  "intensity": "brief" | "medium" | "dramatic"   // animation tier; default "medium"
}

EFFECT PRIMITIVES (composable - the AI's vocabulary for crazy mechanics):

The user can prompt anything physical - bowling pawns, throwing pieces, summoning walls, mind-controlling enemies, freezing, burning, shielding, teleporting. Translate the prompt into a composition of these seven primitives. NEVER invent new effect kinds; the engine only knows these seven.

1. { "kind": "destroy", "aoe": { "radius": 0..3, "hitsPawns": bool, "hitsFriendly": bool } }
   Remove the target piece. Optional AOE explodes around the target.
   Use for: fireball, ranged kill, sniper, atomic.

2. { "kind": "displace", "delta": [df, dr] | undefined,
     "direction": "from_caster" | "toward_caster" | "toward_target_from_origin" | undefined,
     "distance": 1..7 | undefined,
     "onCollision": "stop" | "destroy_target" | "destroy_collider" | "destroy_both",
     "bounceOffEdge": bool }
   Move the target piece without removing it. Pick EITHER 'delta' (fixed offset) OR 'direction'+'distance' (computed). With "destroy_collider" you get bowling/yeet semantics: the target travels along the line and destroys whatever it slams into.
   Use for: throwing pawns, bowling, knockback, gravitational pull, push, yeet.

3. { "kind": "relocate_self", "destination": "target" | "adjacent_to_target" | "caster_origin" }
   Move the caster as part of the cast. Use this with target.requireEmpty=true to avoid running over your own pieces.
   Use for: teleport, blink, charge attack, swap-with-empty.

4. { "kind": "spawn", "pieceType": "p"|"n"|"b"|"r"|"q", "color": "caster"|"enemy", "lifespan": 1..30 }
   Create a new piece on an empty target square. Kings cannot be spawned. Set target.requireEmpty=true for sane move-gen filtering.
   Use for: summon, conjure wall, raise the dead, necromancer.

5. { "kind": "transform", "pieceType": "p"|"n"|"b"|"r"|"q"|"k", "color": "flip"|"caster"|"enemy", "duration": 1..30, "revertOnCapture": bool }
   Change the target piece's type or color. With duration set, reverts after N plies.
   Use for: charm, mind control, polymorph, possess.

6. { "kind": "mark", "tag": "lowercase_id", "duration": 1..30,
     "skipTurns": bool, "silenceAbilities": bool,
     "absorbCaptures": 1..9, "extraMoves": 1..2,
     "destroyOnExpire": bool, "expireOnCapture": bool }
   Apply a tagged status effect. The "tag" is your free-form label (use thematic names like "frost", "burning", "blessed", "hexed", "berserker"). The behavioral fields control what the engine actually does:
   - skipTurns:        target emits zero moves while active (freeze, stun, root)
   - silenceAbilities: target can move but not cast (silence)
   - absorbCaptures:   shield: blocks N incoming captures, then expires
   - extraMoves:       owner gets N extra moves on this piece this turn (haste)
   - destroyOnExpire:  target dies when timer hits 0 (burn, doom, hex)
   - expireOnCapture:  mark drops if the marked piece captures (one-shot effects)

7. { "kind": "aoe_wrap", "radius": 1..3, "hitsPawns": bool, "hitsFriendly": bool, "inner": <PRIMITIVE> }
   Apply any of the above to every piece in a radius around the target square. Cannot nest aoe_wrap inside another aoe_wrap. Caster's own square is always immune.
   Use for: AOE freeze, splash damage, chain effects, area summons.

PRIMITIVE COMPOSITION RULES:
- Always include gating (charges OR cooldownPlies). Ungated abilities lead to one-shot games.
- target.offsets must NEVER include [0,0].
- spawn requires target.requireEmpty=true; relocate_self typically does too (or requireEnemy=false to allow capturing-on-arrival).
- aoe_wrap.inner must be one of the other six primitives.

ABILITY TARGETING DESIGN (CRITICAL - this is what makes abilities feel good):

An ability is only INTERESTING if it can do something the piece's normal moves can't. The user spends a charge to do something different - not the same.

What "different" actually means in chess:
- Hit a piece BEHIND a blocker (the queen freezes the enemy queen even though there's a pawn in the way - kind:"ranged"/"leap" ignores blockers; kind:"slide" doesn't).
- Hit a piece CASTER COULDN'T REACH IN ONE MOVE (a bishop charms a knight on an orthogonal square; a knight bolts something on an adjacent square).
- Apply an effect a normal capture can't (freeze, transform, displace, spawn, mark - all of these are different from "remove the piece").
- Hit MULTIPLE pieces (aoe_wrap).

OFFSET DENSITY IS WHAT MAKES ABILITIES PLAYABLE.

The most common failure: the AI emits offsets at ONLY the maximum range (e.g. only [±4, ±N] for a "4-square fireball"). That ability is INVISIBLE at game start because there are no enemy pieces 4 squares from the queen on the starting board. The user clicks the queen, sees no red crosshairs, and the variant feels broken.

ALWAYS include short-range AND medium-range offsets, not just the maximum. For a "4-square fireball": include offsets at distance 1, 2, 3, AND 4. Like this for orthogonals only:
  [[1,0],[-1,0],[0,1],[0,-1],
   [2,0],[-2,0],[0,2],[0,-2],
   [3,0],[-3,0],[0,3],[0,-3],
   [4,0],[-4,0],[0,4],[0,-4]]
That's 16 offsets. Add diagonals (4 distances × 4 directions) and knight-jumps and you're at 20-32 offsets. THAT's a normal density. Anything under 12 offsets is suspicious - go denser.

Rule of thumb: a ranged ability that says "X squares away" means "ANY square within X squares," not "exactly X squares." Emit a fan that fills the zone densely. Density is more important than which exact directions.

DIFFERENTIATING FROM NORMAL MOVES (avoid pointless redundancy):
- For a QUEEN: include knight-jump offsets ([1,2], [2,1], etc) since the queen can't make those normally. But ALSO include the slide directions at all distances - the value of an ability isn't "different shape" but "different EFFECT" (capture without moving, freeze, push, etc).
- For a BISHOP: include orthogonal AND knight-jump offsets in addition to diagonals.
- For a ROOK: include diagonal AND knight-jump offsets in addition to orthogonals.
- For a KNIGHT: include adjacent squares (1-step orthogonals/diagonals).
- For a PAWN: anywhere beyond a 1-step diagonal capture.

NON-CAPTURE ABILITIES are MORE valuable than capture abilities for slide pieces (queens, rooks, bishops) because the slide piece can already capture via a normal move. Prefer mark/displace/transform/spawn for those. Capture abilities make sense for KNIGHTS and PAWNS (whose captures are constrained), AND for slide pieces when paired with AOE (so the ability hits MULTIPLE targets at once).

Use kind:"ranged" or kind:"leap" with explicit offsets when you want to reach THROUGH friendly/enemy pieces (a frost mage freezes the king behind a pawn wall - that's the magic). Use kind:"slide" only when blocking lines of sight is part of the fantasy (a sniper shooting down a corridor).

PROMPT INTERPRETATION GUIDE - translate verbs into primitives + targeting:
- "Frost mage" / "freeze X" → mark with skipTurns. Target offsets should DENSELY cover squares within the stated range, NOT just the maximum range. Often paired with aoe_wrap radius 1 for area-freeze.
- "Knight bowls pawns" → knight ability targeting a friendly pawn (requireEnemy:false), effect: displace with onCollision:"destroy_collider".
- "Mind-control wizard" / "charm X" → bishop ability, effect: transform with color:"caster" and duration. Dense offset coverage so something is in range turn 1.
- "Necromancer raises pawns" → bishop ability targeting empty squares, effect: spawn with pieceType:"p".
- "Yeet X" / "knockback" → ability targeting an enemy, effect: displace with direction:"from_caster", distance:3..7.
- "Black hole" → ability targeting an empty square, effect: aoe_wrap with inner displace toward_caster.
- "Sniper" / "ranged kill" → kind:"slide" with destroy effect. Slide IS the right shape here because line-of-sight is part of the sniper fantasy.
- "Burn / curse / doom" → mark with destroyOnExpire and a 3-5 ply duration. Let the target see their fate and try to remove the caster.

REACHABILITY CHECK BEFORE YOU FINALIZE:

Starting board geometry: white pieces sit on ranks 1-2, black on 7-8. The middle ranks 3-6 are EMPTY. A back-rank piece like the queen on d1 needs offsets with dr=5..7 to reach an enemy on turn 1. Anything with dr ≤ 4 (or |df+dr| < 5) cannot fire from the opening.

This means:
- "Fireball at 4 squares away" sounds reasonable but on a chess starting board it's almost useless - the queen can't reach a black piece 4 squares ahead. Either escalate the range to 5-7 OR use kind:"slide" with maxRange undefined (slide-shaped abilities that reach the back rank like a normal queen does).
- For a back-rank piece (king/queen/rook/bishop on rank 1 or 8), prefer kind:"slide" with the full set of directions, OR explicit offsets with dr up to 7.
- For a knight or pawn that starts closer to the middle, ranges of 2-4 are fine.
- For long-range "spell" abilities, use kind:"slide" so the offsets are computed implicitly and reach the entire board within line-of-sight - this is the simplest way to guarantee reachability.

When in doubt about reachability: prefer kind:"slide" for queens/rooks/bishops, kind:"leap" or kind:"ranged" with offsets covering up to 7 squares for all other pieces. Density of offsets matters but RANGE matters more - 12 offsets that reach rank 7 beat 32 offsets that stop at rank 4.

If the user prompt says "any enemy" with NO explicit range cap, do NOT invent one. Default to kind:"slide" with all 8 directions (queen-shaped fan), or kind:"ranged" with offsets covering up to 7 squares in every direction. The user wanted broad reach; respect that.

If the user does specify a range, like "4 squares away", interpret it as "anywhere within 4 squares" - but ALSO recognize that on a chess starting board, range ≤ 4 reaches into the empty middle ranks, not enemy pieces. If the user's prompt asks for a low range, you may extend it to 5-6 anyway with a note in the description ("...within 5 squares so the spell can reach the back rank") - playability beats literal compliance.

After writing offsets, mentally trace from the piece's starting square: does ANY offset land on an enemy piece on the starting board? If no, the ability is invisible at game start - rewrite with longer reach.

Win condition objects (used inside "winConditions" array):
- { "type": "checkmate" }
- { "type": "capture_king" }
- { "type": "first_to_n_captures", "target": 1..64 }
- { "type": "race_to_squares", "piece": "p" | "n" | "b" | "r" | "q" | "k", "squaresWhite": ["e8"], "squaresBlack": ["e1"] }
- { "type": "last_standing" }

Constraints / common pitfalls:
- Never include [0,0] in any dirs or offsets array.
- "maxRange" must be in 1..8 if specified.
- Slide and step always need a "dirs" array. Leap always needs an "offsets" array.
- "extends" is always "vanilla".
- If a piece doesn't change, omit it entirely. Do not restate vanilla moves.
- Only set "byColor" when the variant is asymmetric. Otherwise place overrides under "pieces".
- Win conditions are evaluated in order. Put variant-specific conditions before checkmate so they fire first.
- Keep "name" punchy (3 words max). Keep "description" to 1-2 sentences.
- LEGAL STARTING POSITION: when you provide a custom startingFen, neither king may be in check on move 1. No rook, queen, or bishop on an open line of sight to a king. No enemy knight a knight-hop away from a king. No enemy pawn one diagonal step from a king. Place pieces between the kings or behind them; never set up a check before the game starts.
- Vanilla baseline defaults (do NOT restate these unless changing them):
  - p: 1-step forward (no capture), 2-step forward from rank 2 (first move only, no capture), diagonal capture, diagonal en passant, promotion to n/b/r/q.
  - n: leap to all 8 knight offsets.
  - b: slide along 4 diagonals.
  - r: slide along 4 orthogonals.
  - q: slide along 8 directions.
  - k: leap to 8 surrounding squares plus castling kingside and queenside if rights remain.

Be CREATIVE. Lean into the user's intent and make the variant feel distinct, not just a tiny tweak of vanilla. If they say "kings start in the middle", actually rewrite the FEN and put the kings near the middle of the board. If they say "knight wars", make knights powerful and the rest weak. If their prompt is sparse, embellish a bit while staying playable.

Tested example variants for inspiration (do not copy verbatim - use them as patterns):

  "Kings in the middle":
  {
    "extends": "vanilla",
    "name": "Royal Center",
    "description": "Kings start in the middle of the board with their armies behind them. Move fast or get smothered.",
    "overrides": { "startingFen": "rnbq1bnr/pppppppp/8/3k4/8/4K3/PPPPPPPP/RNBQ1BNR w - - 0 1" }
  }

  "Knights move twice":
  {
    "extends": "vanilla",
    "name": "Knight Storm",
    "description": "Knights leap to either standard knight squares or anywhere two knight-hops away.",
    "pieces": { "n": { "moves": [
      { "kind": "leap", "offsets": [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]] },
      { "kind": "leap", "offsets": [[2,4],[4,2],[4,-2],[2,-4],[-2,-4],[-4,-2],[-4,2],[-2,4],[3,3],[3,-3],[-3,-3],[-3,3]] }
    ] } }
  }

  "Pawns can move backward":
  {
    "extends": "vanilla",
    "name": "Reverse Pawns",
    "description": "Pawns may step back to your own first rank to reset and try again.",
    "pieces": { "p": { "moves": [
      { "kind": "step", "dirs": [[0,1]], "conditions": { "onlyNonCapture": true } },
      { "kind": "step", "dirs": [[0,2]], "conditions": { "onlyFirstMove": true, "onlyNonCapture": true } },
      { "kind": "step", "dirs": [[1,1],[-1,1]], "conditions": { "onlyCapture": true } },
      { "kind": "step", "dirs": [[1,1],[-1,1]], "conditions": { "enPassant": true } },
      { "kind": "step", "dirs": [[0,-1]], "conditions": { "onlyNonCapture": true } }
    ] } }
  }

  "First to capture 3 wins":
  {
    "extends": "vanilla",
    "name": "Three Strikes",
    "description": "First side to capture three enemy pieces wins immediately. Defenders fall fast.",
    "winConditions": [{ "type": "first_to_n_captures", "target": 3 }, { "type": "checkmate" }]
  }

  "Atomic chess":
  {
    "extends": "vanilla",
    "name": "Atomic",
    "description": "Captures explode and detonate adjacent non-pawn pieces. Kings cannot capture.",
    "capture": { "explosionRadius": 1 },
    "winConditions": [{ "type": "capture_king" }]
  }

  "Race to e8/e1":
  {
    "extends": "vanilla",
    "name": "King Race",
    "description": "First king to reach the opposite back rank wins. No need for checkmate.",
    "winConditions": [
      { "type": "race_to_squares", "piece": "k", "squaresWhite": ["e8"], "squaresBlack": ["e1"] },
      { "type": "checkmate" }
    ]
  }

  "Last Standing":
  {
    "extends": "vanilla",
    "name": "Annihilation",
    "description": "Win by reducing the opponent to king only. Material matters more than position.",
    "winConditions": [{ "type": "last_standing" }, { "type": "checkmate" }]
  }

Composable-primitive worked examples (cover the patterns; do NOT copy verbatim):

  "Fireball mage queen" (destroy + AOE - kind:"slide" so the fireball reaches the back rank from move 1; AOE makes the cast meaningfully different from a normal queen capture):
  {
    "extends": "vanilla",
    "name": "Fireball Queen",
    "description": "The queen casts fireballs along any direction. The blast detonates on the first enemy in line, with a small AOE.",
    "pieces": {
      "q": {
        "abilities": [
          {
            "id": "fireball",
            "label": "Fireball",
            "target": {
              "kind": "slide",
              "dirs": [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]],
              "blockedByPieces": true
            },
            "effect": { "kind": "destroy", "aoe": { "radius": 1 } },
            "gating": { "charges": 3, "cooldownPlies": 4 },
            "intensity": "dramatic"
          }
        ]
      }
    }
  }

  "Bowling knights" (displace with collision):
  {
    "extends": "vanilla",
    "name": "Bowling Knights",
    "description": "Knights can shove a friendly pawn forward, knocking out any pieces in its path until it stops or runs off the board.",
    "pieces": {
      "n": {
        "abilities": [
          {
            "id": "shove",
            "label": "Bowling Shove",
            "target": {
              "kind": "leap",
              "offsets": [[0,1]],
              "requireEnemy": false
            },
            "effect": {
              "kind": "displace",
              "delta": [0, 6],
              "onCollision": "destroy_collider"
            },
            "gating": { "charges": 1, "cooldownPlies": 5 },
            "intensity": "dramatic"
          }
        ]
      }
    }
  }

  "Necromancer bishops" (spawn):
  {
    "extends": "vanilla",
    "name": "Necromancer Bishops",
    "description": "Bishops can raise a friendly pawn from any empty square within 3 squares. The summons last 8 plies.",
    "pieces": {
      "b": {
        "abilities": [
          {
            "id": "raise",
            "label": "Raise the Dead",
            "target": {
              "kind": "ranged",
              "offsets": [
                [1,0],[2,0],[3,0],[-1,0],[-2,0],[-3,0],
                [0,1],[0,2],[0,3],[0,-1],[0,-2],[0,-3],
                [1,1],[2,2],[3,3],[-1,-1],[-2,-2],[-3,-3]
              ],
              "requireEnemy": false,
              "requireEmpty": true
            },
            "effect": { "kind": "spawn", "pieceType": "p", "color": "caster", "lifespan": 8 },
            "gating": { "charges": 2, "cooldownPlies": 6 },
            "intensity": "medium"
          }
        ]
      }
    }
  }

  "Mind-control wizard" (transform color):
  {
    "extends": "vanilla",
    "name": "Mind Wizard",
    "description": "Bishops can charm an enemy piece for 4 plies, making it fight on their side until the spell breaks.",
    "pieces": {
      "b": {
        "abilities": [
          {
            "id": "charm",
            "label": "Charm",
            "target": {
              "kind": "ranged",
              "offsets": [[1,1],[2,2],[1,-1],[2,-2],[-1,1],[-2,2],[-1,-1],[-2,-2]]
            },
            "effect": { "kind": "transform", "color": "caster", "duration": 4, "revertOnCapture": true },
            "gating": { "charges": 1, "cooldownPlies": 8 },
            "intensity": "dramatic"
          }
        ]
      }
    }
  }

  "Frost mage" (aoe_wrap + mark with skipTurns - kind:"ranged" with offsets covering up to 7 squares so the queen can freeze a back-rank piece on turn 1 even though pieces are 6+ ranks apart at the start; ranged also bypasses blockers, which is the whole point of "spell" abilities):
  {
    "extends": "vanilla",
    "name": "Frost Mage",
    "description": "Queens cast a frost burst at any enemy on a rank, file, or diagonal. Everyone in a 1-tile radius around the target gets frozen for 2 turns. Reaches through pieces.",
    "pieces": {
      "q": {
        "abilities": [
          {
            "id": "frost_burst",
            "label": "Frost Burst",
            "target": {
              "kind": "ranged",
              "offsets": [
                [1,0],[2,0],[3,0],[4,0],[5,0],[6,0],[7,0],
                [-1,0],[-2,0],[-3,0],[-4,0],[-5,0],[-6,0],[-7,0],
                [0,1],[0,2],[0,3],[0,4],[0,5],[0,6],[0,7],
                [0,-1],[0,-2],[0,-3],[0,-4],[0,-5],[0,-6],[0,-7],
                [1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],
                [-1,1],[-2,2],[-3,3],[-4,4],[-5,5],[-6,6],[-7,7],
                [1,-1],[2,-2],[3,-3],[4,-4],[5,-5],[6,-6],[7,-7],
                [-1,-1],[-2,-2],[-3,-3],[-4,-4],[-5,-5],[-6,-6],[-7,-7]
              ]
            },
            "effect": {
              "kind": "aoe_wrap",
              "radius": 1,
              "hitsPawns": true,
              "inner": { "kind": "mark", "tag": "frost", "duration": 2, "skipTurns": true }
            },
            "gating": { "charges": 2, "cooldownPlies": 5 },
            "intensity": "dramatic"
          }
        ]
      }
    }
  }

  "Blink rook" (relocate_self):
  {
    "extends": "vanilla",
    "name": "Blink Rook",
    "description": "Rooks can teleport to any empty square within 4 squares. Once per match per rook.",
    "pieces": {
      "r": {
        "abilities": [
          {
            "id": "blink",
            "label": "Blink",
            "target": {
              "kind": "leap",
              "offsets": [
                [1,0],[2,0],[3,0],[4,0],[-1,0],[-2,0],[-3,0],[-4,0],
                [0,1],[0,2],[0,3],[0,4],[0,-1],[0,-2],[0,-3],[0,-4]
              ],
              "requireEnemy": false,
              "requireEmpty": true
            },
            "effect": { "kind": "relocate_self", "destination": "target" },
            "gating": { "charges": 1 },
            "intensity": "medium"
          }
        ]
      }
    }
  }

  "Burning fingers" (mark with destroyOnExpire):
  {
    "extends": "vanilla",
    "name": "Burning Fingers",
    "description": "Bishops can curse an enemy piece. The cursed piece dies in 3 turns unless something captures the bishop first.",
    "pieces": {
      "b": {
        "abilities": [
          {
            "id": "doom",
            "label": "Mark of Doom",
            "target": {
              "kind": "ranged",
              "offsets": [[1,1],[2,2],[3,3],[1,-1],[2,-2],[3,-3],[-1,1],[-2,2],[-3,3],[-1,-1],[-2,-2],[-3,-3]]
            },
            "effect": { "kind": "mark", "tag": "burning", "duration": 3, "destroyOnExpire": true },
            "gating": { "charges": 2, "cooldownPlies": 6 },
            "intensity": "dramatic"
          }
        ]
      }
    }
  }

Reply with ONLY a JSON object, no prose around it.`;

function buildPrompt(prompt: string, validatorErrors?: string[], plannerVibe?: PlannerVibe, labMode: boolean = true): string {
  const trimmed = (prompt || "").trim().slice(0, MAX_PROMPT_CHARS);
  let retryNote = "";
  if (validatorErrors?.length) {
    retryNote = `\n\nIMPORTANT: your previous response was rejected by the structural validator with these errors:
${validatorErrors.map((e) => `  - ${e}`).join("\n")}

Fix the errors and try again. Stay within the schema above; do not invent new fields.\n`;
  }
  let plannerNote = "";
  if (plannerVibe) {
    plannerNote = `\nDesign brief from the planner (use as creative context; the user's prompt above is still primary):
- Fighting style: ${plannerVibe.fighting_style}
- Signature mechanic: ${plannerVibe.signature_mechanic}
- Under pressure: ${plannerVibe.under_pressure}
`;
  }
  // Lab gate: outside the crazy-arena lab, only "destroy"/"capture"
  // effects are available. The system prompt documents the full
  // primitive set, but the user-context here tells Gemini to ignore
  // everything except the basic shape so we don't waste retry
  // budget on rejected responses.
  let labNote = "";
  if (!labMode) {
    labNote = `\n\nIMPORTANT (Ship #1 lobby mode): the composable primitives (displace, relocate_self, spawn, transform, mark, aoe_wrap) are NOT available to this user. Use ONLY effect.kind = "destroy" (or its alias "capture"). Status effects, summons, displacement, charm, etc. are not selectable - if the user prompts for them, translate the intent into a thematically-named "destroy" ability with optional AOE. This is enforced by the server validator; ignoring it will fail the response.\n`;
  }
  return `User's variant description:
"""
${trimmed}
"""
${plannerNote}${retryNote}${labNote}
Produce a JSON rule diff matching the schema. ONLY the JSON object. No prose, no markdown fences.`;
}

// ── Step 1: Behaviour Planner ──
//
// Cheap prose-only call. We give Gemini the user's variant
// description and ask for three short prose fields describing
// the variant's vibe. Output feeds into the factory step's
// prompt as "design brief" context.
//
// Failure mode: if the planner errors or the response is
// malformed, we skip it entirely and the factory just runs on
// the user's prompt. The factory works fine without the
// planner - it just produces less-cohesive variants.

interface PlannerVibe {
  fighting_style: string;
  signature_mechanic: string;
  under_pressure: string;
}

const PLANNER_SYSTEM_PROMPT = `You are a chess-variant choreographer. The user describes a chess variant they want to play. Your job is to translate their request into THREE short prose fields that capture how the variant FEELS in play.

Reply with ONLY a JSON object of this exact shape:
{
  "fighting_style":     "1-2 sentences. How does this army feel to play? Aggressive, defensive, sneaky, raw firepower, etc.",
  "signature_mechanic": "1-2 sentences. What's the headline ability or rule that makes this variant memorable? Be concrete (e.g. 'queens cast fireballs that deal AOE damage every 4 turns', not 'unique magic system').",
  "under_pressure":     "1-2 sentences. What does the army do when losing? Do pieces panic, rally, scatter, suicide-charge?"
}

No markdown, no fences, no extra prose. Each field is plain English, 1-2 sentences max. Stay focused on the user's request - do NOT introduce mechanics they didn't ask for.`;

const PLANNER_MAX_TOKENS = 500;

async function callPlanner(userPrompt: string, model: string): Promise<{ ok: boolean; vibe?: PlannerVibe; inputTokens?: number; outputTokens?: number; error?: string }> {
  const trimmed = (userPrompt || "").trim().slice(0, MAX_PROMPT_CHARS);
  const result = await callGemini(
    PLANNER_SYSTEM_PROMPT,
    `User's variant description:\n"""\n${trimmed}\n"""\n\nReply with the JSON object described in the system prompt.`,
    model,
    PLANNER_MAX_TOKENS,
  );
  if (!result.ok || !result.content) {
    return { ok: false, error: result.error };
  }
  const parsed = tolerantParseJson(result.content);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { ok: false, error: "planner response not parseable" };
  }
  const v = parsed.value as Record<string, unknown>;
  const vibe: PlannerVibe = {
    fighting_style: typeof v.fighting_style === "string" ? v.fighting_style : "",
    signature_mechanic: typeof v.signature_mechanic === "string" ? v.signature_mechanic : "",
    under_pressure: typeof v.under_pressure === "string" ? v.under_pressure : "",
  };
  // Reject empty fields - if any one is missing, the planner
  // didn't actually plan, so don't pass garbage to the factory.
  if (!vibe.fighting_style || !vibe.signature_mechanic || !vibe.under_pressure) {
    return { ok: false, error: "planner missing required fields" };
  }
  return {
    ok: true,
    vibe,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

// ── Gemini call + cost estimation ──

interface GeminiResult {
  ok: boolean;
  content?: string;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

// Gemini 2.5 Flash pricing (per 1M tokens, USD).
// As of late 2025 - check https://ai.google.dev/pricing if
// these change. Also used for the post-call cost log.
const GEMINI_FLASH_INPUT_USD_PER_M = 0.075;
const GEMINI_FLASH_OUTPUT_USD_PER_M = 0.30;

/** Convert (in, out) token counts to micro-USD using Flash pricing. */
function estimateMicroUsd(inputTokens: number, outputTokens: number): number {
  const inUsd = (inputTokens * GEMINI_FLASH_INPUT_USD_PER_M) / 1_000_000;
  const outUsd = (outputTokens * GEMINI_FLASH_OUTPUT_USD_PER_M) / 1_000_000;
  return Math.ceil((inUsd + outUsd) * 1_000_000);
}

/**
 * Conservative pre-call cost estimate. Rough heuristic: 1 token
 * ~= 4 characters. Multiply by 2 for safety so the budget guard
 * never under-counts. Output tokens are capped by max_tokens
 * below, but we use that ceiling for the estimate.
 */
function estimateMicroUsdFromPromptChars(promptChars: number, maxOutputTokens: number): number {
  const estIn = Math.ceil((promptChars / 4) * 2);
  return estimateMicroUsd(estIn, maxOutputTokens);
}

async function callGemini(systemPrompt: string, userPrompt: string, model: string, maxTokens = 16000): Promise<GeminiResult> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return { ok: false, error: "GEMINI_API_KEY not configured" };
  const url = `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.5,
        max_tokens: maxTokens,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { ok: false, error: `Gemini returned ${resp.status}: ${body.slice(0, 300)}` };
    }
    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: "Empty response from Gemini" };
    // OpenAI-compat usage object. Gemini may or may not include it
    // depending on model version - default to 0 if missing.
    const usage = json?.usage || {};
    return {
      ok: true,
      content,
      inputTokens: Number(usage.prompt_tokens) || 0,
      outputTokens: Number(usage.completion_tokens) || 0,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Monthly $-cap guard ──

interface SpendCheckResult {
  ok: boolean;
  allowed: boolean;
  usedMicroUsd: number;
  capMicroUsd: number;
  remainingMicroUsd: number;
  error?: string;
}

const MONTHLY_CAP_MICRO_USD = 200_000_000; // $200.00 per calendar month (shared with coach)

/**
 * Atomically check + record an AI spend event. Pre-call use:
 * pass an estimate; if denied, do NOT make the API call.
 * Post-call use: pass the actual cost as a true-up, ignoring
 * the result.
 */
async function recordSpendOrBlock(
  req: Request,
  feature: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  microUsd: number,
): Promise<SpendCheckResult> {
  const supabase = makeAuthedClient(req);
  if (!supabase) {
    return { ok: false, allowed: false, usedMicroUsd: 0, capMicroUsd: MONTHLY_CAP_MICRO_USD, remainingMicroUsd: MONTHLY_CAP_MICRO_USD, error: "Supabase client unavailable" };
  }
  const { data, error } = await supabase.rpc("record_ai_spend_or_block", {
    p_feature: feature,
    p_provider: "gemini",
    p_model: model,
    p_input_tokens: inputTokens,
    p_output_tokens: outputTokens,
    p_micro_usd: microUsd,
    p_monthly_cap_micro_usd: MONTHLY_CAP_MICRO_USD,
  });
  if (error) {
    return { ok: false, allowed: false, usedMicroUsd: 0, capMicroUsd: MONTHLY_CAP_MICRO_USD, remainingMicroUsd: MONTHLY_CAP_MICRO_USD, error: error.message };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return { ok: false, allowed: false, usedMicroUsd: 0, capMicroUsd: MONTHLY_CAP_MICRO_USD, remainingMicroUsd: MONTHLY_CAP_MICRO_USD, error: "Empty spend response" };
  }
  return {
    ok: true,
    allowed: !!row.allowed,
    usedMicroUsd: Number(row.used_micro_usd) || 0,
    capMicroUsd: Number(row.cap_micro_usd) || MONTHLY_CAP_MICRO_USD,
    remainingMicroUsd: Number(row.remaining_micro_usd) || 0,
  };
}

/**
 * Parse Gemini's textual response into a rules object. Tolerant
 * of common LLM output mistakes:
 *
 *   1. Markdown fences (```json ... ```)
 *   2. Trailing commas before } or ]
 *   3. JavaScript-style comments (// ... and / * ... * /)
 *   4. Prose wrapping the JSON object (e.g. "Here you go:\n{...}")
 *
 * Strategy: try strict JSON.parse first (the happy path is fast).
 * On failure, sanitize step-by-step and retry. As a last resort,
 * extract the largest balanced {...} substring and parse that.
 *
 * Exported separately from `parseRulesJson` so the unit tests can
 * exercise the sanitizer directly without standing up a Deno
 * runtime.
 */
export function tolerantParseJson(input: string): { ok: boolean; value?: unknown; error?: string } {
  if (typeof input !== "string") {
    return { ok: false, error: "input is not a string" };
  }

  // Pass 1: strict.
  const trimmed = input.trim();
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch { /* fall through */ }

  // Pass 2: strip markdown fences + retry strict.
  let cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch { /* fall through */ }

  // Pass 3: strip JS comments. Skip strings so a "//" inside a
  // value doesn't trip us up.
  cleaned = stripJsComments(cleaned);
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch { /* fall through */ }

  // Pass 4: strip trailing commas (also string-aware).
  cleaned = stripTrailingCommas(cleaned);
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch { /* fall through */ }

  // Pass 5: extract the outermost balanced {...} object and try
  // again. Catches "Here's your JSON:\n{...}\nHope it helps!".
  const objSlice = extractFirstJsonObject(cleaned);
  if (objSlice) {
    try {
      return { ok: true, value: JSON.parse(objSlice) };
    } catch (e) {
      return { ok: false, error: `Couldn't parse JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Last attempt to surface a helpful error message.
  try {
    JSON.parse(cleaned);
    return { ok: false, error: "Unknown parse failure" };
  } catch (e) {
    return { ok: false, error: `Couldn't parse JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Remove // line comments and /* block comments * / outside string literals. */
function stripJsComments(src: string): string {
  let out = "";
  let i = 0;
  let inString: false | '"' | "'" = false;
  let escape = false;
  while (i < src.length) {
    const c = src[i];
    if (inString) {
      out += c;
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === inString) {
        inString = false;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      out += c;
      i++;
      continue;
    }
    // Line comment.
    if (c === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    // Block comment.
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Remove trailing commas before } or ] outside string literals. */
function stripTrailingCommas(src: string): string {
  let out = "";
  let i = 0;
  let inString: false | '"' | "'" = false;
  let escape = false;
  while (i < src.length) {
    const c = src[i];
    if (inString) {
      out += c;
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === inString) {
        inString = false;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      out += c;
      i++;
      continue;
    }
    if (c === ",") {
      // Look ahead past whitespace; if the next non-ws char is }
      // or ], drop the comma.
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === "}" || src[j] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Find the first balanced {...} object in src and return that slice, or null. */
function extractFirstJsonObject(src: string): string | null {
  const start = src.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString: false | '"' | "'" = false;
  let escape = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === inString) inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function parseRulesJson(content: string): { ok: boolean; rules?: Record<string, unknown>; error?: string } {
  const result = tolerantParseJson(content);
  if (!result.ok) {
    return { ok: false, error: result.error || "Couldn't parse JSON" };
  }
  if (!result.value || typeof result.value !== "object" || Array.isArray(result.value)) {
    return { ok: false, error: "Top-level JSON wasn't an object" };
  }
  return { ok: true, rules: result.value as Record<string, unknown> };
}

// ── Server-side structural validator ──
//
// Mirrors lib/arena/validator.js's layer-1 checks - just
// enough to reject obviously-broken rules without needing the
// engine. The client runs a full validator (including
// simulation) on receipt as defense in depth.

const KNOWN_PRIMITIVE_KINDS = new Set(["slide", "leap", "step"]);
const KNOWN_WIN_CONDITIONS = new Set([
  "checkmate", "capture_king", "first_to_n_captures", "race_to_squares", "last_standing",
]);
const PIECE_TYPES = new Set(["p", "n", "b", "r", "q", "k"]);
// Active-ability vocabulary. Mirror of `validatePieceAbilities` and
// `validateEffectPrimitive` in ochess-app/src/lib/arena/validator.js -
// kept in sync by hand. Ship #2: composable primitives.
const KNOWN_ABILITY_TARGET_KINDS = new Set(["ranged", "leap", "slide"]);
const KNOWN_ABILITY_EFFECT_KINDS = new Set([
  "capture", "destroy", "displace", "relocate_self",
  "spawn", "transform", "mark", "aoe_wrap",
]);
const KNOWN_INTENSITIES = new Set(["brief", "medium", "dramatic"]);
const ABILITY_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const TAG_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SPAWNABLE_PIECE_TYPES = new Set(["p", "n", "b", "r", "q"]);
const ALL_PIECE_TYPES = new Set(["p", "n", "b", "r", "q", "k"]);

function validateStructure(rules: Record<string, unknown>, labMode: boolean = true): string[] {
  const errors: string[] = [];

  if (rules.extends !== "vanilla") {
    errors.push(`extends must be "vanilla" (got ${JSON.stringify(rules.extends)})`);
  }

  // Pieces
  if (rules.pieces !== undefined) {
    if (typeof rules.pieces !== "object" || rules.pieces === null || Array.isArray(rules.pieces)) {
      errors.push("pieces must be an object keyed by piece type");
    } else {
      for (const [pt, spec] of Object.entries(rules.pieces as Record<string, unknown>)) {
        if (!PIECE_TYPES.has(pt)) {
          errors.push(`pieces.${pt}: unknown piece type (must be one of p/n/b/r/q/k)`);
          continue;
        }
        validatePieceSpec(`pieces.${pt}`, spec, errors, labMode);
      }
    }
  }

  // byColor
  if (rules.byColor !== undefined) {
    if (typeof rules.byColor !== "object" || rules.byColor === null) {
      errors.push("byColor must be an object");
    } else {
      for (const [color, perColor] of Object.entries(rules.byColor as Record<string, unknown>)) {
        if (color !== "w" && color !== "b") {
          errors.push(`byColor.${color}: unknown color (must be "w" or "b")`);
          continue;
        }
        if (typeof perColor !== "object" || perColor === null) continue;
        for (const [pt, spec] of Object.entries(perColor as Record<string, unknown>)) {
          if (!PIECE_TYPES.has(pt)) {
            errors.push(`byColor.${color}.${pt}: unknown piece type`);
            continue;
          }
          validatePieceSpec(`byColor.${color}.${pt}`, spec, errors, labMode);
        }
      }
    }
  }

  // Win conditions
  if (rules.winConditions !== undefined) {
    if (!Array.isArray(rules.winConditions) || rules.winConditions.length === 0) {
      errors.push("winConditions must be a non-empty array");
    } else {
      for (let i = 0; i < (rules.winConditions as unknown[]).length; i++) {
        const wc = (rules.winConditions as Record<string, unknown>[])[i];
        if (!wc || typeof wc !== "object" || !KNOWN_WIN_CONDITIONS.has(String(wc.type))) {
          errors.push(`winConditions[${i}].type "${(wc as Record<string, unknown>)?.type}" is unknown`);
          continue;
        }
        if (wc.type === "first_to_n_captures") {
          const target = Number(wc.target);
          if (!Number.isFinite(target) || target < 1 || target > 64) {
            errors.push(`winConditions[${i}].target must be 1..64`);
          }
        }
        if (wc.type === "race_to_squares") {
          if (!Array.isArray(wc.squaresWhite) || (wc.squaresWhite as unknown[]).length === 0) {
            errors.push(`winConditions[${i}].squaresWhite must be a non-empty array`);
          }
          if (!Array.isArray(wc.squaresBlack) || (wc.squaresBlack as unknown[]).length === 0) {
            errors.push(`winConditions[${i}].squaresBlack must be a non-empty array`);
          }
        }
      }
    }
  }

  // Capture effects
  if (rules.capture !== undefined) {
    const cap = rules.capture as Record<string, unknown>;
    if (cap?.explosionRadius !== undefined) {
      const r = Number(cap.explosionRadius);
      if (!Number.isFinite(r) || r < 0 || r > 3) {
        errors.push("capture.explosionRadius must be 0..3");
      }
    }
  }

  // overrides.startingFen + maxPlies
  const ov = (rules.overrides as Record<string, unknown>) || {};
  if (ov.startingFen !== undefined && typeof ov.startingFen !== "string") {
    errors.push("overrides.startingFen must be a string");
  }
  if (ov.maxPlies !== undefined) {
    const m = Number(ov.maxPlies);
    if (!Number.isFinite(m) || m < 10 || m > 2000) {
      errors.push("overrides.maxPlies must be 10..2000");
    }
  }

  // Top-level startingFen / maxPlies / name / description
  if (rules.startingFen !== undefined && typeof rules.startingFen !== "string") {
    errors.push("startingFen must be a string");
  }
  if (rules.maxPlies !== undefined) {
    const m = Number(rules.maxPlies);
    if (!Number.isFinite(m) || m < 10 || m > 2000) {
      errors.push("maxPlies must be 10..2000");
    }
  }
  if (rules.name !== undefined && typeof rules.name !== "string") {
    errors.push("name must be a string");
  }
  if (rules.description !== undefined && typeof rules.description !== "string") {
    errors.push("description must be a string");
  }

  return errors;
}

function validatePieceSpec(path: string, spec: unknown, errors: string[], labMode: boolean = true): void {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  const s = spec as Record<string, unknown>;
  if (s.abilities !== undefined) {
    validateAbilities(`${path}.abilities`, s.abilities, errors, labMode);
  }
  if (s.moves !== undefined) {
    if (!Array.isArray(s.moves)) {
      errors.push(`${path}.moves must be an array`);
    } else {
      for (let i = 0; i < (s.moves as unknown[]).length; i++) {
        const prim = (s.moves as Record<string, unknown>[])[i];
        const subPath = `${path}.moves[${i}]`;
        if (!prim || typeof prim !== "object") {
          errors.push(`${subPath}: must be an object`);
          continue;
        }
        if (!KNOWN_PRIMITIVE_KINDS.has(String(prim.kind))) {
          errors.push(`${subPath}.kind "${prim.kind}" is unknown (must be slide/leap/step)`);
          continue;
        }
        if (prim.kind === "slide" || prim.kind === "step") {
          if (!Array.isArray(prim.dirs) || (prim.dirs as unknown[]).length === 0) {
            errors.push(`${subPath}.dirs must be a non-empty array of [df,dr] tuples`);
          } else {
            for (let j = 0; j < (prim.dirs as unknown[]).length; j++) {
              const d = (prim.dirs as unknown[])[j];
              if (!Array.isArray(d) || d.length !== 2 || !Number.isFinite(d[0]) || !Number.isFinite(d[1])) {
                errors.push(`${subPath}.dirs[${j}]: must be a [df,dr] tuple of finite numbers`);
              } else if ((d as number[])[0] === 0 && (d as number[])[1] === 0) {
                errors.push(`${subPath}.dirs[${j}]: [0,0] would loop forever`);
              }
            }
          }
          if (prim.kind === "slide" && prim.maxRange !== undefined) {
            const r = Number(prim.maxRange);
            if (!Number.isFinite(r) || r < 1 || r > 8) {
              errors.push(`${subPath}.maxRange must be 1..8`);
            }
          }
        } else if (prim.kind === "leap") {
          if (!Array.isArray(prim.offsets) || (prim.offsets as unknown[]).length === 0) {
            errors.push(`${subPath}.offsets must be a non-empty array of [df,dr] tuples`);
          } else {
            for (let j = 0; j < (prim.offsets as unknown[]).length; j++) {
              const off = (prim.offsets as unknown[])[j];
              if (!Array.isArray(off) || off.length !== 2 || !Number.isFinite(off[0]) || !Number.isFinite(off[1])) {
                errors.push(`${subPath}.offsets[${j}]: must be a [df,dr] tuple of finite numbers`);
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Validate the `abilities` array on a piece spec. Mirrors
 * `validatePieceAbilities` in
 * ochess-app/src/lib/arena/validator.js - any rule we add
 * here MUST also land there (the client validator is the
 * authoritative defense against a stale Edge Function deploy).
 */
function validateAbilities(path: string, abilities: unknown, errors: string[], labMode: boolean = true): void {
  if (!Array.isArray(abilities)) {
    errors.push(`${path}: must be an array`);
    return;
  }
  if (abilities.length > 8) {
    errors.push(`${path}: caps at 8 abilities per piece (got ${abilities.length})`);
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < abilities.length; i++) {
    const ab = abilities[i] as Record<string, unknown>;
    const sub = `${path}[${i}]`;
    if (!ab || typeof ab !== "object" || Array.isArray(ab)) {
      errors.push(`${sub}: must be an object`);
      continue;
    }
    if (typeof ab.id !== "string" || !ABILITY_ID_RE.test(ab.id as string)) {
      errors.push(`${sub}.id must be lowercase letters/digits/underscores, 1-32 chars (got ${JSON.stringify(ab.id)})`);
    } else if (seenIds.has(ab.id as string)) {
      errors.push(`${sub}.id "${ab.id}" is duplicated within the same piece`);
    } else {
      seenIds.add(ab.id as string);
    }
    if (ab.label !== undefined && typeof ab.label !== "string") {
      errors.push(`${sub}.label must be a string when set`);
    }
    if (ab.intensity !== undefined && !KNOWN_INTENSITIES.has(String(ab.intensity))) {
      errors.push(`${sub}.intensity must be one of ${[...KNOWN_INTENSITIES].join("/")} when set`);
    }

    const tgt = ab.target as Record<string, unknown> | undefined;
    if (!tgt || typeof tgt !== "object") {
      errors.push(`${sub}.target is required and must be an object`);
    } else if (!KNOWN_ABILITY_TARGET_KINDS.has(String(tgt.kind))) {
      errors.push(`${sub}.target.kind "${tgt.kind}" is unknown (must be ranged/leap/slide)`);
    } else if (tgt.kind === "ranged" || tgt.kind === "leap") {
      if (!Array.isArray(tgt.offsets) || (tgt.offsets as unknown[]).length === 0) {
        errors.push(`${sub}.target.offsets must be a non-empty array for kind=${tgt.kind}`);
      } else if ((tgt.offsets as unknown[]).length > 128) {
        errors.push(`${sub}.target.offsets caps at 128 entries`);
      } else {
        for (let j = 0; j < (tgt.offsets as unknown[]).length; j++) {
          const off = (tgt.offsets as unknown[])[j];
          if (!Array.isArray(off) || off.length !== 2 || !Number.isFinite((off as number[])[0]) || !Number.isFinite((off as number[])[1])) {
            errors.push(`${sub}.target.offsets[${j}] must be a [df,dr] tuple of finite numbers`);
          } else if ((off as number[])[0] === 0 && (off as number[])[1] === 0) {
            errors.push(`${sub}.target.offsets[${j}] is [0,0] - cannot target your own square`);
          }
        }
      }
    } else if (tgt.kind === "slide") {
      if (!Array.isArray(tgt.dirs) || (tgt.dirs as unknown[]).length === 0) {
        errors.push(`${sub}.target.dirs must be a non-empty array for kind=slide`);
      } else {
        for (let j = 0; j < (tgt.dirs as unknown[]).length; j++) {
          const d = (tgt.dirs as unknown[])[j];
          if (!Array.isArray(d) || d.length !== 2 || !Number.isFinite((d as number[])[0]) || !Number.isFinite((d as number[])[1])) {
            errors.push(`${sub}.target.dirs[${j}] must be a [df,dr] tuple of finite numbers`);
          } else if ((d as number[])[0] === 0 && (d as number[])[1] === 0) {
            errors.push(`${sub}.target.dirs[${j}] is [0,0] - zero-vector direction loops forever`);
          }
        }
      }
      if (tgt.maxRange !== undefined) {
        const r = Number(tgt.maxRange);
        if (!Number.isFinite(r) || r < 1 || r > 8) {
          errors.push(`${sub}.target.maxRange must be 1..8 when set`);
        }
      }
    }

    if (!ab.effect || typeof ab.effect !== "object") {
      errors.push(`${sub}.effect is required and must be an object`);
    } else {
      validateEffectPrimitive(`${sub}.effect`, ab.effect as Record<string, unknown>, errors, /*nested*/ false, labMode);
    }

    const gating = ab.gating as Record<string, unknown> | undefined;
    if (gating !== undefined) {
      if (!gating || typeof gating !== "object") {
        errors.push(`${sub}.gating must be an object when set`);
      } else {
        if (gating.charges !== undefined) {
          const c = Number(gating.charges);
          if (!Number.isFinite(c) || c < 1 || c > 99) {
            errors.push(`${sub}.gating.charges must be 1..99 when set`);
          }
        }
        if (gating.cooldownPlies !== undefined) {
          const c = Number(gating.cooldownPlies);
          if (!Number.isFinite(c) || c < 1 || c > 20) {
            errors.push(`${sub}.gating.cooldownPlies must be 1..20 when set`);
          }
        }
      }
    }
  }
}

/**
 * Validate a composable effect primitive (Ship #2). Mirror of the same
 * function in ochess-app/src/lib/arena/validator.js. Any rule we add here
 * MUST also land there.
 *
 * `nested` is true when this primitive is INSIDE an aoe_wrap.inner;
 * forbids further nesting.
 */
function validateEffectPrimitive(path: string, eff: Record<string, unknown>, errors: string[], nested: boolean, labMode: boolean = true): void {
  if (!eff || typeof eff !== "object") {
    errors.push(`${path}: must be an object`);
    return;
  }
  const kind = String(eff.kind);
  if (!KNOWN_ABILITY_EFFECT_KINDS.has(kind)) {
    errors.push(`${path}.kind "${eff.kind}" is unknown (must be one of ${[...KNOWN_ABILITY_EFFECT_KINDS].join("/")})`);
    return;
  }
  // Lab gate: outside the lab, only Ship #1 effect kinds are
  // accepted. The composable primitives (displace/relocate_self/
  // spawn/transform/mark/aoe_wrap) are gated until the visuals
  // layer (Ship #3) lands. Inside the lab, all primitives are
  // available.
  if (!labMode && kind !== "capture" && kind !== "destroy") {
    errors.push(`${path}.kind "${kind}" is not available outside the crazy-arena lab (Ship #1 supports capture/destroy only)`);
    return;
  }

  if (kind === "destroy" || kind === "capture") {
    if (eff.aoe !== undefined) {
      const aoe = eff.aoe as Record<string, unknown>;
      if (!aoe || typeof aoe !== "object") {
        errors.push(`${path}.aoe must be an object when set`);
      } else {
        if (aoe.radius !== undefined) {
          const r = Number(aoe.radius);
          if (!Number.isFinite(r) || r < 0 || r > 3) {
            errors.push(`${path}.aoe.radius must be 0..3 when set`);
          }
        }
        if (aoe.hitsPawns !== undefined && typeof aoe.hitsPawns !== "boolean") {
          errors.push(`${path}.aoe.hitsPawns must be a boolean when set`);
        }
        if (aoe.hitsFriendly !== undefined && typeof aoe.hitsFriendly !== "boolean") {
          errors.push(`${path}.aoe.hitsFriendly must be a boolean when set`);
        }
      }
    }
    return;
  }

  if (kind === "displace") {
    const hasDelta = Array.isArray(eff.delta);
    const hasDir = typeof eff.direction === "string";
    if (!hasDelta && !hasDir) {
      errors.push(`${path} must specify either 'delta' or 'direction'+'distance'`);
    }
    if (hasDelta) {
      const d = eff.delta as unknown[];
      if (d.length !== 2 || !Number.isFinite(d[0]) || !Number.isFinite(d[1])) {
        errors.push(`${path}.delta must be a [df,dr] tuple of finite numbers`);
      } else if ((d as number[])[0] === 0 && (d as number[])[1] === 0) {
        errors.push(`${path}.delta is [0,0]`);
      } else if (Math.abs((d as number[])[0]) > 7 || Math.abs((d as number[])[1]) > 7) {
        errors.push(`${path}.delta components must be -7..7`);
      }
    }
    if (hasDir) {
      const validDirs = ["from_caster", "toward_caster", "toward_target_from_origin"];
      if (!validDirs.includes(String(eff.direction))) {
        errors.push(`${path}.direction must be one of ${validDirs.join("/")}`);
      }
      const dist = Number(eff.distance);
      if (!Number.isFinite(dist) || dist < 1 || dist > 7) {
        errors.push(`${path}.distance must be 1..7 when direction is set`);
      }
    }
    if (eff.onCollision !== undefined) {
      const validCollision = ["stop", "destroy_target", "destroy_collider", "destroy_both"];
      if (!validCollision.includes(String(eff.onCollision))) {
        errors.push(`${path}.onCollision must be one of ${validCollision.join("/")}`);
      }
    }
    if (eff.bounceOffEdge !== undefined && typeof eff.bounceOffEdge !== "boolean") {
      errors.push(`${path}.bounceOffEdge must be a boolean when set`);
    }
    return;
  }

  if (kind === "relocate_self") {
    if (eff.destination !== undefined) {
      const valid = ["target", "adjacent_to_target", "caster_origin"];
      if (!valid.includes(String(eff.destination))) {
        errors.push(`${path}.destination must be one of ${valid.join("/")} when set`);
      }
    }
    return;
  }

  if (kind === "spawn") {
    if (typeof eff.pieceType !== "string" || !SPAWNABLE_PIECE_TYPES.has(eff.pieceType as string)) {
      errors.push(`${path}.pieceType must be one of ${[...SPAWNABLE_PIECE_TYPES].join("/")} (kings can't be spawned)`);
    }
    if (eff.color !== undefined && eff.color !== "caster" && eff.color !== "enemy") {
      errors.push(`${path}.color must be 'caster' or 'enemy' when set`);
    }
    if (eff.lifespan !== undefined) {
      const l = Number(eff.lifespan);
      if (!Number.isFinite(l) || l < 1 || l > 30) {
        errors.push(`${path}.lifespan must be 1..30 when set`);
      }
    }
    return;
  }

  if (kind === "transform") {
    const hasTypeChange = typeof eff.pieceType === "string";
    const hasColorChange = typeof eff.color === "string";
    if (!hasTypeChange && !hasColorChange) {
      errors.push(`${path} must specify at least one of 'pieceType' or 'color'`);
    }
    if (hasTypeChange && !ALL_PIECE_TYPES.has(eff.pieceType as string)) {
      errors.push(`${path}.pieceType must be one of ${[...ALL_PIECE_TYPES].join("/")}`);
    }
    if (hasColorChange && !["flip", "caster", "enemy"].includes(String(eff.color))) {
      errors.push(`${path}.color must be 'flip'/'caster'/'enemy'`);
    }
    if (eff.duration !== undefined) {
      const d = Number(eff.duration);
      if (!Number.isFinite(d) || d < 1 || d > 30) {
        errors.push(`${path}.duration must be 1..30 when set`);
      }
    }
    if (eff.revertOnCapture !== undefined && typeof eff.revertOnCapture !== "boolean") {
      errors.push(`${path}.revertOnCapture must be a boolean when set`);
    }
    return;
  }

  if (kind === "mark") {
    if (typeof eff.tag !== "string" || !TAG_RE.test(eff.tag as string)) {
      errors.push(`${path}.tag must be lowercase letters/digits/underscores, 1-32 chars (got ${JSON.stringify(eff.tag)})`);
    }
    if (eff.duration !== undefined) {
      const d = Number(eff.duration);
      if (!Number.isFinite(d) || d < 1 || d > 30) {
        errors.push(`${path}.duration must be 1..30 when set`);
      }
    }
    if (eff.skipTurns !== undefined && typeof eff.skipTurns !== "boolean") {
      errors.push(`${path}.skipTurns must be boolean when set`);
    }
    if (eff.silenceAbilities !== undefined && typeof eff.silenceAbilities !== "boolean") {
      errors.push(`${path}.silenceAbilities must be boolean when set`);
    }
    if (eff.absorbCaptures !== undefined) {
      const a = Number(eff.absorbCaptures);
      if (!Number.isFinite(a) || a < 1 || a > 9) {
        errors.push(`${path}.absorbCaptures must be 1..9 when set`);
      }
    }
    if (eff.extraMoves !== undefined) {
      const e = Number(eff.extraMoves);
      if (!Number.isFinite(e) || e < 1 || e > 2) {
        errors.push(`${path}.extraMoves must be 1..2 when set`);
      }
    }
    if (eff.destroyOnExpire !== undefined && typeof eff.destroyOnExpire !== "boolean") {
      errors.push(`${path}.destroyOnExpire must be boolean when set`);
    }
    if (eff.expireOnCapture !== undefined && typeof eff.expireOnCapture !== "boolean") {
      errors.push(`${path}.expireOnCapture must be boolean when set`);
    }
    return;
  }

  if (kind === "aoe_wrap") {
    if (nested) {
      errors.push(`${path}: aoe_wrap cannot be nested inside another aoe_wrap`);
      return;
    }
    const r = Number(eff.radius);
    if (!Number.isFinite(r) || r < 1 || r > 3) {
      errors.push(`${path}.radius must be 1..3`);
    }
    if (!eff.inner || typeof eff.inner !== "object") {
      errors.push(`${path}.inner must be an effect object`);
    } else {
      validateEffectPrimitive(`${path}.inner`, eff.inner as Record<string, unknown>, errors, /*nested*/ true, labMode);
    }
    if (eff.hitsPawns !== undefined && typeof eff.hitsPawns !== "boolean") {
      errors.push(`${path}.hitsPawns must be boolean when set`);
    }
    if (eff.hitsFriendly !== undefined && typeof eff.hitsFriendly !== "boolean") {
      errors.push(`${path}.hitsFriendly must be boolean when set`);
    }
    return;
  }
}

// ── CORS ──

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Handler ──

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let body: ArenaRulesRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Body must be JSON" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (!body.prompt || typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return new Response(JSON.stringify({ ok: false, error: "prompt is required" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Rate limit (also serves as auth gate - non-authed users
  // can't make the RPC succeed).
  const rl = await recordRateLimitedCall(req);
  if (!rl.ok) {
    return new Response(JSON.stringify({ ok: false, error: rl.error || "Rate limit failed" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  if (!rl.allowed) {
    const resp: ArenaRulesResponse = {
      ok: false,
      error: `You can request up to ${rl.maxCalls} variant rules per ${Math.round(rl.windowSeconds / 60)} min. Try again in ${rl.retryAfterSeconds}s.`,
      retry_after_seconds: rl.retryAfterSeconds,
      rate_limit: {
        calls_in_window: rl.callsInWindow,
        max_calls: rl.maxCalls,
        window_seconds: rl.windowSeconds,
      },
    };
    return new Response(JSON.stringify(resp), {
      status: 429,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const model = Deno.env.get("GEMINI_MODEL") || DEFAULT_MODEL;

  // ── Pre-flight $-cap check ──
  // Worst-case estimate: full system prompt (~3-4 KB chars) +
  // user prompt + the auto-retry budget (~2x output). If the
  // estimated cost would push us over the monthly cap, refuse
  // BEFORE making the API call so we never get billed for it.
  const promptCharsEst = SYSTEM_PROMPT.length + body.prompt.length + 500;
  // Output budget matches the callGemini default (4000). x2 for
  // the auto-retry path so we never under-estimate when the
  // first response gets truncated and we retry.
  const estMicroUsd = estimateMicroUsdFromPromptChars(promptCharsEst, 16000) * 2;
  const preCheck = await recordSpendOrBlock(req, "arena_rules", model, 0, 0, 0);
  if (preCheck.ok && !preCheck.allowed && preCheck.usedMicroUsd + estMicroUsd > preCheck.capMicroUsd) {
    return new Response(JSON.stringify({
      ok: false,
      error: "AI variant generation is temporarily unavailable - the monthly spending budget has been reached. Try again next month.",
      model,
    }), {
      status: 503,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  // Hard pre-block when over cap regardless. The 0-cost row
  // above just lets us inspect the current spend; the real
  // cost-bearing record happens after each successful call.
  if (preCheck.ok && preCheck.usedMicroUsd >= preCheck.capMicroUsd) {
    return new Response(JSON.stringify({
      ok: false,
      error: "AI variant generation is temporarily unavailable - the monthly spending budget has been reached. Try again next month.",
      model,
    }), {
      status: 503,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // ── Lab flag (Ship #2). Determines whether the composable-
  // primitive vocabulary is available to this user. Outside the
  // lab, only destroy/capture effects are accepted by the server
  // validator AND the prompt instructs Gemini to ignore the rest.
  const labMode = await getCrazyArenaLabFlag(req);

  // ── STEP 1: Behaviour Planner (prose vibe) ──
  // Cheap, fast (~500 tokens out). Failure is non-fatal -
  // we just skip the planner context and pass the user's raw
  // prompt straight to the factory.
  let plannerVibe: PlannerVibe | undefined;
  const planner = await callPlanner(body.prompt, model);
  if (planner.ok && planner.vibe) {
    plannerVibe = planner.vibe;
  }
  if (planner.inputTokens || planner.outputTokens) {
    const cost = estimateMicroUsd(planner.inputTokens || 0, planner.outputTokens || 0);
    await recordSpendOrBlock(req, "arena_rules", model, planner.inputTokens || 0, planner.outputTokens || 0, cost);
  }

  // ── STEP 2: Variant Factory (structured rules JSON) ──
  // First attempt. Planner output is fed in as creative
  // context, not as instructions to copy verbatim.
  const firstPrompt = buildPrompt(body.prompt, undefined, plannerVibe, labMode);
  const first = await callGemini(SYSTEM_PROMPT, firstPrompt, model);
  if (!first.ok) {
    return new Response(JSON.stringify({ ok: false, error: first.error || "AI call failed", model }), {
      status: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  if (first.inputTokens || first.outputTokens) {
    const cost = estimateMicroUsd(first.inputTokens || 0, first.outputTokens || 0);
    await recordSpendOrBlock(req, "arena_rules", model, first.inputTokens || 0, first.outputTokens || 0, cost);
  }
  const parsedFirst = parseRulesJson(first.content!);
  if (!parsedFirst.ok) {
    return new Response(JSON.stringify({ ok: false, error: parsedFirst.error || "Bad AI output", model }), {
      status: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  let rules = parsedFirst.rules!;
  let errors = validateStructure(rules, labMode);

  // Auto-retry once with the validator errors fed back. The
  // planner vibe stays the same on retry - only the structural
  // errors are new context.
  if (errors.length > 0) {
    const retryPrompt = buildPrompt(body.prompt, errors, plannerVibe, labMode);
    const second = await callGemini(SYSTEM_PROMPT, retryPrompt, model);
    if (second.ok) {
      if (second.inputTokens || second.outputTokens) {
        const cost = estimateMicroUsd(second.inputTokens || 0, second.outputTokens || 0);
        await recordSpendOrBlock(req, "arena_rules", model, second.inputTokens || 0, second.outputTokens || 0, cost);
      }
      const parsedSecond = parseRulesJson(second.content!);
      if (parsedSecond.ok) {
        rules = parsedSecond.rules!;
        errors = validateStructure(rules, labMode);
      }
    }
  }

  if (errors.length > 0) {
    const resp: ArenaRulesResponse = {
      ok: false,
      error: "AI couldn't produce valid rules. Try rephrasing your prompt.",
      validatorErrors: errors,
      model,
      rate_limit: {
        calls_in_window: rl.callsInWindow,
        max_calls: rl.maxCalls,
        window_seconds: rl.windowSeconds,
      },
    };
    return new Response(JSON.stringify(resp), {
      status: 422,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Defensive: ensure extends="vanilla" so the client resolver
  // doesn't reject. The validator above already enforces this
  // but a future loosening of the validator shouldn't open the
  // hole.
  rules.extends = "vanilla";

  const summary = typeof rules.description === "string" ? rules.description : undefined;

  const resp: ArenaRulesResponse = {
    ok: true,
    rules,
    summary,
    planner: plannerVibe,
    model,
    rate_limit: {
      calls_in_window: rl.callsInWindow,
      max_calls: rl.maxCalls,
      window_seconds: rl.windowSeconds,
    },
  };
  return new Response(JSON.stringify(resp), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
});
