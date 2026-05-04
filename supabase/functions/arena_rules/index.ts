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
  /**
   * Optional hint added to the factory user-prompt. The client
   * sends this on a verification-retry attempt: "previous
   * response was structurally valid but failed the playability
   * check; please fix THESE specific issues." Capped at 1KB so a
   * malicious caller can't pad the prompt with garbage.
   */
  retryHint?: string;
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
  /**
   * True when month-to-date spend has crossed the soft-warning
   * threshold but not yet the hard cap. The lobby surfaces a
   * small notice ("AI service is approaching its monthly limit")
   * so users aren't surprised when the hard cap eventually hits.
   * Generation still works.
   */
  spend_warning?: boolean;
  /**
   * True when the request was blocked because the monthly hard
   * cap is exhausted. The friendly user-facing reason in
   * `error` includes the date the cap resets.
   */
  capExhausted?: boolean;
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
  "intensity": "brief" | "medium" | "dramatic",  // animation tier; default "medium"
  "visualTheme": "fire|ice|shadow|lightning|poison|holy|shield|teleport|gravity|water|wind|time|nature|impact|magic",
  "visualIntent": "short prose describing exactly what it should look like"
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

ABILITY TARGETING DESIGN:

A good ability does something the piece's normal moves can't. Pick targeting that makes the ability feel different - reach BEHIND blockers (kind:"ranged"/"leap" ignores them; kind:"slide" doesn't), apply an effect a normal capture can't (mark/transform/displace/spawn), or hit MULTIPLE pieces (aoe_wrap).

Targeting cheat sheet:
- For abilities meant to reach the whole board (queen/rook/bishop "spell" abilities, sniper shots): prefer kind:"slide" with all relevant directions. Slide reaches the back rank automatically without hand-rolled offsets.
- For abilities meant to hit through blockers: kind:"ranged" or kind:"leap" with offsets covering 1..7 squares in every direction (~30-60 offsets). Anything under 12 offsets is suspicious.
- For abilities at fixed range like "knight bolt": kind:"leap" with the appropriate offsets.

Server-side automation handles the worst common mistake (offsets that don't reach turn-1 enemies on the starting board): if your offsets can't reach an enemy in the first 4 plies, the engine extends them to a baseline queen-fan. So aim for the user's intent; you don't need to manually verify board geometry. But DO emit dense coverage when the user asks for "anywhere within N squares" - that's the user's intent and the engine respects it.

PROMPT INTERPRETATION GUIDE:
- "Frost mage / freeze X" → mark with skipTurns. Often paired with aoe_wrap radius 1 for area-freeze.
- "Burn / curse / doom" → mark with destroyOnExpire and a 3-5 ply duration.
- "Mind-control / charm" → transform with color:"caster" and duration:3..6.
- "Necromancer / summon" → spawn with pieceType + lifespan, target.requireEmpty=true.
- "Yeet / knockback / push" → displace with direction:"from_caster" or "toward_caster" and distance.
- "Bowling X" → displace with onCollision:"destroy_collider" so the target plows through pieces.
- "Sniper / long-range kill" → kind:"slide" with destroy effect (line-of-sight is part of the fantasy).
- "Black hole" → aoe_wrap with inner displace toward_caster.
- "Teleport / blink" → relocate_self with target.requireEmpty=true.

VISUAL INTENT ON ABILITIES:
- Always set ability.visualTheme and ability.visualIntent for active abilities.
- visualTheme is a compact machine-readable hint used by the client repair layer if your visuals are missing or invalid.
- visualIntent is prose for future debug / remix UI and should be specific: "a blue ice shard flies from bishop to target and frost crystals grow on frozen squares" is good; "cool" is bad.
- Pick the theme that best matches the user's words, not necessarily the effect.kind. Example: effect.kind="destroy" with label "Poison Dart" should visualTheme="poison", not "impact".

NON-CAPTURE ABILITIES are usually more interesting than capture abilities on slide pieces (queens, rooks, bishops) because the slide piece can already capture via a normal move. Prefer mark/displace/transform/spawn for those, or pair capture with AOE so it hits multiple targets.

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

═══════════════════════════════════════════════════════════
VISUALS (expected for crazy/lab variants):
═══════════════════════════════════════════════════════════

For any variant with abilities, fire, ice, explosions, shadows, summons, teleports, status marks, projectiles, or any strong theme, you SHOULD emit a top-level "visuals" field. The goal is not a vague glow. The goal is to make the prompt physically visible on the board: fire should look like fire, freezing should look like ice crystals, bowling should look like motion trails / impact sparks, necromancy should look like green spirit smoke, etc.

The functions run in a sandboxed iframe with no network/storage access. Emit JavaScript FUNCTION BODY strings only. Do not emit a full function declaration.

The visuals object accepts these keys:
- "slots": object keyed by "<pieceType>.<slotName>". E.g. "q.aura" paints under EVERY queen on the board (both colors). Slot names are: body, head, back, weapon_R, weapon_L, feet, aura. Each value is a JavaScript function body string receiving (ctx, x, y, facing, owner, t, random, state).
- "projectiles": object keyed by projectile id. The key SHOULD match an ability id. If an ability id is "fireball", emit visuals.projectiles.fireball. Each value receives (ctx, p) where p has {x, y, fromX, fromY, toX, toY, progress, age, ttl}.
- "effects": object keyed by cosmetic effect id. These are spawned by visual brains with world.spawnEffect({kind,x,y,ttl,data}). Each value receives (ctx, e, t) where e has {x,y,age,ttl,progress,kind,data}.
- "overlays": array of full-board JS function body strings receiving (ctx, scene) where scene has {width, height, marks, lastCast, t}. Use overlays for board-wide weather, frozen-square crystals, curse smoke, post-cast shockwaves, and status marks.
- "brains": object keyed by piece type ("p","n","b","r","q","k"). Each value is a JavaScript function body receiving (self, world, dt, state, random). Runs about 8 times per second. It can set fields on state, call random(), call world.spawnProjectile({kind,fromX,fromY,toX,toY,ttl}), and call world.spawnEffect({kind,x,y,ttl,data}). It must not try to change game rules or piece positions.

Parameter contract:
- ctx: a canvas 2D context, pre-translated to the slot's center for slot draws. Position (0,0) is the piece's center.
- x, y: in slot draws, always 0 (the canvas is pre-translated). Use them for offsets if you want.
- facing: 1 if owner is white, -1 if owner is black. Useful for direction-sensitive sprites.
- owner: { type: "p"|"n"|"b"|"r"|"q"|"k", color: "w"|"b" }
- t: monotonic time in milliseconds. Use for animations: Math.sin(t * 0.003) etc.
- random: a function returning a number in [0,1). Match-seeded so both clients render identical animations. Use this instead of Math.random for replay determinism.
- state: a per-piece persistent object you can read/write across frames.
- scene.lastCast: null or {from,to,abilityId}. Use it to draw a one-frame shockwave / burn ring / frost burst at the target.
- scene.marks: object keyed by square. Use this for status effects like freeze/burn/curse/shield when your rules emit effect.kind = "mark".
- self in brain hooks: {type,color,square,x,y,facing,t}. x/y are absolute board pixels, so brain-spawned effects/projectiles can use them directly.
- state in brain hooks: persistent object for that piece. Store cooldowns / animation counters there.
- random in brain hooks: match-seeded deterministic random function.
- world in brain hooks: {spawnProjectile, spawnEffect}. Use these for idle embers, charge sparks, ghost wisps, lightning arcs, smoke puffs. They are cosmetic only.

Allowed canvas API (everything else is rejected by the validator):
- Setters: fillStyle, strokeStyle, lineWidth, lineCap, lineJoin, globalAlpha, shadowColor, shadowBlur, shadowOffsetX, shadowOffsetY
- Path methods: beginPath, closePath, moveTo, lineTo, arc, arcTo, ellipse, rect, roundRect, bezierCurveTo, quadraticCurveTo
- Paint methods: fill, stroke, fillRect, strokeRect, clearRect
- Transforms: save, restore, translate, rotate, scale, transform, setTransform
- Gradients: createLinearGradient, createRadialGradient, createConicGradient (the returned object has only addColorStop)

Allowed JS surface: Math.* (PI, E, sin, cos, tan, sqrt, pow, abs, min, max, floor, ceil, round, atan2, hypot, log, exp, random), Number.isFinite, Array.from, Array.isArray, JSON.stringify, JSON.parse, parseInt, parseFloat, Infinity, NaN. Standard control flow (if/else, for/while/do-while, switch). const/let/var. Function expressions / arrow functions. try/catch (catch must be parameterless, written as: catch {} with no parentheses).

NEVER do these things (they will be rejected by the validator):
- fetch, XMLHttpRequest, WebSocket, fetchSync, navigator, Image, Audio
- eval, Function constructor, setTimeout, setInterval, requestAnimationFrame
- document, window, globalThis, parent, top
- localStorage, sessionStorage, indexedDB, cookies, crypto
- Date, Date.now (use the t parameter instead)
- ctx.fillText, ctx.strokeText, ctx.drawImage, ctx.measureText
- this, async/await, classes, generators, import/export
- Dynamic property access like ctx[someVar] - use ctx.fillStyle directly

Performance: each per-frame draw has a 15ms budget. For per-piece slots that means roughly 1-2ms each. Keep draws lean: <100 lines, no nested loops > 32 iterations total.

Visual quality requirements:
- If you define an active ability, emit at least one slot draw on the caster piece type AND, when the ability travels from caster to target, a projectile draw whose key equals the ability id.
- If the visual needs ambient particles or temporary effects, emit a brain hook plus matching effects/projectiles. Example: visuals.brains.q spawns "ember" effects; visuals.effects.ember draws fading sparks.
- For a themed caster piece, prefer 3-5 slots, not just aura. Example for a fireball queen: q.aura for heat shimmer, q.weapon_R for flame staff, q.back for cape sparks, q.feet for ember trail, q.body for molten core.
- Do NOT draw letters or text. Do NOT use generic circles only. Combine gradients, arcs, triangles, jagged lines, particles, alpha, rotation, and time-based pulsing.
- Slot drawings are centered on the piece. Keep most marks within radius 35 so they sit around the chess sprite, not over the whole board.
- Projectile drawings use absolute board coordinates through p.x and p.y; draw a head and a tail using p.progress.
- Overlay drawings should be subtle but specific: snowflake cracks for freeze, smoky purple corners for curse, red-orange flash rings for explosion.

═══════════════════════════════════════════════════════════
Worked visual examples (copy these patterns, but theme them to the user prompt):
═══════════════════════════════════════════════════════════

Fire caster aura and weapon:
  "q.aura": "const phase=Math.sin(t*0.006)*0.5+0.5; const r=25+phase*7; const g=ctx.createRadialGradient(0,0,0,0,0,r); g.addColorStop(0,'rgba(255,230,80,0.45)'); g.addColorStop(0.45,'rgba(255,90,0,0.22)'); g.addColorStop(1,'rgba(120,0,0,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.fill(); for(let i=0;i<6;i++){ const a=i*Math.PI/3+t*0.004; ctx.strokeStyle='rgba(255,120,0,0.55)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(Math.cos(a)*15,Math.sin(a)*15); ctx.lineTo(Math.cos(a)*28,Math.sin(a)*28); ctx.stroke(); }"
  "q.weapon_R": "ctx.save(); ctx.rotate(0.35*facing); const flick=Math.sin(t*0.012)*3; ctx.strokeStyle='rgba(120,45,0,0.9)'; ctx.lineWidth=3; ctx.beginPath(); ctx.moveTo(10*facing,-16); ctx.lineTo(22*facing,-2); ctx.stroke(); const g=ctx.createRadialGradient(25*facing,-2,0,25*facing,-2,9+flick); g.addColorStop(0,'rgba(255,255,180,0.95)'); g.addColorStop(0.4,'rgba(255,110,0,0.75)'); g.addColorStop(1,'rgba(255,0,0,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(25*facing,-2,10+flick,0,Math.PI*2); ctx.fill(); ctx.restore();"

Ice/freeze caster crystals:
  "b.aura": "const pulse=Math.sin(t*0.003)*0.5+0.5; ctx.strokeStyle='rgba(170,230,255,'+(0.45+pulse*0.25)+')'; ctx.lineWidth=1.5; for(let i=0;i<8;i++){ const a=i*Math.PI/4; const r1=13; const r2=27+pulse*4; ctx.beginPath(); ctx.moveTo(Math.cos(a)*r1,Math.sin(a)*r1); ctx.lineTo(Math.cos(a)*r2,Math.sin(a)*r2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(Math.cos(a)*r2,Math.sin(a)*r2); ctx.lineTo(Math.cos(a+0.22)*(r2-7),Math.sin(a+0.22)*(r2-7)); ctx.moveTo(Math.cos(a)*r2,Math.sin(a)*r2); ctx.lineTo(Math.cos(a-0.22)*(r2-7),Math.sin(a-0.22)*(r2-7)); ctx.stroke(); }"
  "b.back": "ctx.fillStyle='rgba(180,240,255,0.22)'; for(let i=0;i<4;i++){ const a=t*0.001+i*Math.PI/2; ctx.beginPath(); ctx.ellipse(Math.cos(a)*12,Math.sin(a)*8-6,5,14,a,0,Math.PI*2); ctx.fill(); }"

Projectile (fireball trail):
  "fireball": "const dx = p.toX - p.fromX, dy = p.toY - p.fromY; const len = Math.sqrt(dx*dx + dy*dy) || 1; for (let i = 0; i < 6; i++) { const back = i / 6; const tx = p.x - (dx/len) * back * 12; const ty = p.y - (dy/len) * back * 12; ctx.fillStyle = 'rgba(255,' + (180 - i*20) + ',0,' + (0.8 - back) + ')'; ctx.beginPath(); ctx.arc(tx, ty, 6 - i*0.6, 0, Math.PI*2); ctx.fill(); }"

Projectile (ice shard):
  "freeze": "const dx=p.toX-p.fromX, dy=p.toY-p.fromY; const a=Math.atan2(dy,dx); ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(a); ctx.fillStyle='rgba(190,240,255,0.9)'; ctx.beginPath(); ctx.moveTo(12,0); ctx.lineTo(-8,-5); ctx.lineTo(-3,0); ctx.lineTo(-8,5); ctx.closePath(); ctx.fill(); ctx.strokeStyle='rgba(80,180,255,0.55)'; ctx.lineWidth=1; ctx.stroke(); ctx.restore();"

Overlay (last-cast fire burst):
  "const c=scene.lastCast; if(c){ const files='abcdefgh'; const f=files.indexOf(c.to[0]); const r=parseInt(c.to[1],10)-1; if(f>=0){ const sq=scene.width/8; const x=f*sq+sq/2; const y=(7-r)*sq+sq/2; const age=(scene.t%500)/500; ctx.strokeStyle='rgba(255,90,0,'+(0.55*(1-age))+')'; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(x,y,12+age*38,0,Math.PI*2); ctx.stroke(); } }"

Overlay (marked frozen squares):
  "const sq=scene.width/8; const files='abcdefgh'; for(const key of Object.keys(scene.marks||{})){ const marks=scene.marks[key]||[]; let frozen=false; for(let i=0;i<marks.length;i++){ if(String(marks[i].tag||'').includes('freeze')||String(marks[i].tag||'').includes('ice')) frozen=true; } if(!frozen) continue; const f=files.indexOf(key[0]); const r=parseInt(key[1],10)-1; if(f<0) continue; const x=f*sq+sq/2, y=(7-r)*sq+sq/2; ctx.strokeStyle='rgba(170,230,255,0.65)'; ctx.lineWidth=1.5; for(let i=0;i<6;i++){ const a=i*Math.PI/3+scene.t*0.002; ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+Math.cos(a)*22,y+Math.sin(a)*22); ctx.stroke(); } }"

Brain + effect (idle ember sparks around a fire queen):
  "brains": { "q": "if(!state.nextSpark||state.nextSpark<=0){ world.spawnEffect({kind:'ember',x:self.x+(random()*24-12),y:self.y+(random()*24-12),ttl:500,data:{rise:10+random()*12}}); state.nextSpark=0.25; } state.nextSpark=state.nextSpark-dt;" },
  "effects": { "ember": "const a=1-e.progress; const rise=e.data&&e.data.rise?e.data.rise:14; ctx.fillStyle='rgba(255,120,0,'+a+')'; ctx.beginPath(); ctx.arc(e.x,e.y-rise*e.progress,2+2*(1-e.progress),0,Math.PI*2); ctx.fill();" }

If the user prompts for a "fireball queen" or "freezing bishop" or "neon knights" or anything visual, MATCH the visual to the ability. Examples:
- "freezing" -> ice crystals: sharp blue-white spokes, faceted polygons, slow shimmer, overlay on marked frozen squares
- "burning" -> flame: orange/yellow gradients, flicker, smoke particles, ember trails, target impact ring
- "stone" -> grey slab armor, cracks, angular rectangles, dust on movement
- "shadow" -> purple/black low-alpha smoke, crescent shapes, slow drift, fading afterimages
- "necromancy" -> green spirit wisps, bone-white arcs, grave-smoke at summoned pieces
- "bowling/throwing" -> motion streaks, impact sparks, dust trail, projectile keyed to ability id
- "lightning" -> jagged cyan/white lines, branching arcs, fast flicker

Do not omit visuals for crazy arena lab variants unless the prompt is extremely plain and has no theme. If you emit a "visuals" field, make it useful: at minimum one caster slot AND one projectile or overlay for each active ability theme. NEVER emit a "visuals" field with empty contents.

Reply with ONLY a JSON object, no prose around it.`;

function buildPrompt(
  prompt: string,
  validatorErrors?: string[],
  plannerVibe?: PlannerVibe,
  labMode: boolean = true,
  retryHint?: string,
): string {
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
  // effects are available.
  let labNote = "";
  if (!labMode) {
    labNote = `\n\nIMPORTANT (Ship #1 lobby mode): the composable primitives (displace, relocate_self, spawn, transform, mark, aoe_wrap) are NOT available to this user. Use ONLY effect.kind = "destroy" (or its alias "capture"). Status effects, summons, displacement, charm, etc. are not selectable - if the user prompts for them, translate the intent into a thematically-named "destroy" ability with optional AOE. This is enforced by the server validator; ignoring it will fail the response.\n`;
  }
  // Verification-retry hint: the client passes this on the second
  // attempt when a structurally-valid response failed playability.
  // Gets the same "fix THIS specifically" weight as a structural
  // validator retry, but the failure modes are different (the
  // structural validator catches type errors; the playability
  // verifier catches "ability is invisible at game start").
  let hintNote = "";
  if (retryHint && typeof retryHint === "string") {
    const safe = retryHint.slice(0, 1000);
    hintNote = `\n\n${safe}\n`;
  }
  return `User's variant description:
"""
${trimmed}
"""
${plannerNote}${retryNote}${labNote}${hintNote}
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

// Models we'll fall back to if the primary one 404s (deprecated /
// renamed). Order matters: try the most-similar known-good model
// first. The list is hand-curated; update when Google publishes
// new stable models.
const GEMINI_FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-1.5-flash",
];

async function callGemini(systemPrompt: string, userPrompt: string, model: string, maxTokens = 16000): Promise<GeminiResult> {
  // Try the primary model. If it returns 404 (model not found /
  // deprecated), iterate through fallbacks. ANY other error is
  // returned immediately - we don't want to mask transient
  // upstream issues by silently switching models.
  const result = await callGeminiOne(systemPrompt, userPrompt, model, maxTokens);
  if (result.ok || !result.modelNotFound) return result;

  log("model_fallback", { primary: model });
  for (const fb of GEMINI_FALLBACK_MODELS) {
    if (fb === model) continue; // don't retry the same one
    const r = await callGeminiOne(systemPrompt, userPrompt, fb, maxTokens);
    if (r.ok) {
      log("model_fallback_succeeded", { primary: model, fallback: fb });
      return r;
    }
    if (!r.modelNotFound) return r;
  }
  return { ok: false, error: `All Gemini models returned 404. Update GEMINI_MODEL secret.` };
}

async function callGeminiOne(systemPrompt: string, userPrompt: string, model: string, maxTokens: number): Promise<GeminiResult & { modelNotFound?: boolean }> {
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
      // 404 means the model name is wrong/deprecated. Surface it
      // with a marker so the caller can try a fallback.
      const modelNotFound = resp.status === 404 || /model.*not.*found/i.test(body);
      return {
        ok: false,
        error: `Gemini returned ${resp.status}: ${body.slice(0, 300)}`,
        modelNotFound,
      };
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
  warningActive: boolean;
  error?: string;
}

// Conservative fallback if the ai_settings table read fails for
// any reason. The DB row is the source of truth; this is just
// here so a transient DB hiccup doesn't accidentally let through
// a $1000 month.
const FALLBACK_CAP_MICRO_USD = 100_000_000;

/**
 * Atomically check + record an AI spend event. Pre-call use:
 * pass an estimate; if denied, do NOT make the API call.
 * Post-call use: pass the actual cost as a true-up, ignoring
 * the result.
 *
 * The cap is read from the ai_settings table (single source of
 * truth). The legacy p_monthly_cap_micro_usd RPC parameter is
 * IGNORED by the SQL function but still passed for backwards
 * compatibility with any older deploy of this Edge Function
 * that didn't read it from the DB.
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
    return { ok: false, allowed: false, usedMicroUsd: 0, capMicroUsd: FALLBACK_CAP_MICRO_USD, remainingMicroUsd: FALLBACK_CAP_MICRO_USD, warningActive: false, error: "Supabase client unavailable" };
  }
  const { data, error } = await supabase.rpc("record_ai_spend_or_block", {
    p_feature: feature,
    p_provider: "gemini",
    p_model: model,
    p_input_tokens: inputTokens,
    p_output_tokens: outputTokens,
    p_micro_usd: microUsd,
    p_monthly_cap_micro_usd: 0,   // ignored by the SQL function
  });
  if (error) {
    return { ok: false, allowed: false, usedMicroUsd: 0, capMicroUsd: FALLBACK_CAP_MICRO_USD, remainingMicroUsd: FALLBACK_CAP_MICRO_USD, warningActive: false, error: error.message };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return { ok: false, allowed: false, usedMicroUsd: 0, capMicroUsd: FALLBACK_CAP_MICRO_USD, remainingMicroUsd: FALLBACK_CAP_MICRO_USD, warningActive: false, error: "Empty spend response" };
  }
  return {
    ok: true,
    allowed: !!row.allowed,
    usedMicroUsd: Number(row.used_micro_usd) || 0,
    capMicroUsd: Number(row.cap_micro_usd) || FALLBACK_CAP_MICRO_USD,
    remainingMicroUsd: Number(row.remaining_micro_usd) || 0,
    warningActive: row.warning_active === true,
  };
}

/**
 * Build a friendly user-facing message when the monthly cap has
 * been exhausted. Includes the date the cap resets so the user
 * knows when AI features will return.
 */
function capExhaustedMessage(): string {
  const now = new Date();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const day = nextMonth.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  return `AI variant generation is paused for the rest of the month — the global spending budget has been reached. It will return on ${day}.`;
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

export function validateStructure(rules: Record<string, unknown>, labMode: boolean = true): string[] {
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

  // Visuals (Ship #3). Server-side does structural
  // checks: keys are well-formed, draws are non-empty strings,
  // sizes are sane. Full AST validation runs client-side
  // (visual-sandbox/ast-validator.js) before any draw reaches
  // the iframe - that's the actual security boundary. The
  // server check is just to block obviously-bad payloads from
  // being persisted on a room row.
  if (rules.visuals !== undefined) {
    validateVisualsBlock(rules.visuals, errors);
  }

  return errors;
}

const SLOT_NAMES = new Set(["body", "head", "back", "weapon_R", "weapon_L", "feet", "aura"]);
const SLOT_KEY_RE = /^([pnbrqk])\.(body|head|back|weapon_R|weapon_L|feet|aura)$/;
const PROJECTILE_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_DRAW_SOURCE_LEN = 8192;
const MAX_SLOTS = 28;
const MAX_PROJECTILES = 12;
const MAX_EFFECTS = 12;
const MAX_OVERLAYS = 6;

export function validateVisualsBlock(v: unknown, errors: string[]): void {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    errors.push("visuals: must be an object");
    return;
  }
  const block = v as Record<string, unknown>;

  // slots
  if (block.slots !== undefined) {
    if (!block.slots || typeof block.slots !== "object" || Array.isArray(block.slots)) {
      errors.push("visuals.slots: must be an object");
    } else {
      const slots = block.slots as Record<string, unknown>;
      const keys = Object.keys(slots);
      if (keys.length > MAX_SLOTS) {
        errors.push(`visuals.slots: too many entries (${keys.length} > ${MAX_SLOTS})`);
      }
      for (const k of keys) {
        if (!SLOT_KEY_RE.test(k)) {
          errors.push(`visuals.slots.${k}: key must match <pieceType>.<slot> where slot is one of body/head/back/weapon_R/weapon_L/feet/aura`);
          continue;
        }
        const src = slots[k];
        if (typeof src !== "string" || src.length === 0) {
          errors.push(`visuals.slots.${k}: must be a non-empty string`);
          continue;
        }
        if (src.length > MAX_DRAW_SOURCE_LEN) {
          errors.push(`visuals.slots.${k}: source too long (${src.length} > ${MAX_DRAW_SOURCE_LEN})`);
        }
      }
    }
  }

  // projectiles
  if (block.projectiles !== undefined) {
    if (!block.projectiles || typeof block.projectiles !== "object" || Array.isArray(block.projectiles)) {
      errors.push("visuals.projectiles: must be an object");
    } else {
      const projs = block.projectiles as Record<string, unknown>;
      const keys = Object.keys(projs);
      if (keys.length > MAX_PROJECTILES) {
        errors.push(`visuals.projectiles: too many entries (${keys.length} > ${MAX_PROJECTILES})`);
      }
      for (const k of keys) {
        if (!PROJECTILE_ID_RE.test(k)) {
          errors.push(`visuals.projectiles.${k}: id must match ${PROJECTILE_ID_RE}`);
          continue;
        }
        const src = projs[k];
        if (typeof src !== "string" || src.length === 0) {
          errors.push(`visuals.projectiles.${k}: must be a non-empty string`);
          continue;
        }
        if (src.length > MAX_DRAW_SOURCE_LEN) {
          errors.push(`visuals.projectiles.${k}: source too long (${src.length} > ${MAX_DRAW_SOURCE_LEN})`);
        }
      }
    }
  }

  // effects (brain-spawned cosmetic effects)
  if (block.effects !== undefined) {
    if (!block.effects || typeof block.effects !== "object" || Array.isArray(block.effects)) {
      errors.push("visuals.effects: must be an object");
    } else {
      const effs = block.effects as Record<string, unknown>;
      const keys = Object.keys(effs);
      if (keys.length > MAX_EFFECTS) {
        errors.push(`visuals.effects: too many entries (${keys.length} > ${MAX_EFFECTS})`);
      }
      for (const k of keys) {
        if (!PROJECTILE_ID_RE.test(k)) {
          errors.push(`visuals.effects.${k}: id must match ${PROJECTILE_ID_RE}`);
          continue;
        }
        const src = effs[k];
        if (typeof src !== "string" || src.length === 0) {
          errors.push(`visuals.effects.${k}: must be a non-empty string`);
          continue;
        }
        if (src.length > MAX_DRAW_SOURCE_LEN) {
          errors.push(`visuals.effects.${k}: source too long (${src.length} > ${MAX_DRAW_SOURCE_LEN})`);
        }
      }
    }
  }

  // overlays
  if (block.overlays !== undefined) {
    if (!Array.isArray(block.overlays)) {
      errors.push("visuals.overlays: must be an array");
    } else {
      if (block.overlays.length > MAX_OVERLAYS) {
        errors.push(`visuals.overlays: too many entries (${block.overlays.length} > ${MAX_OVERLAYS})`);
      }
      for (let i = 0; i < block.overlays.length; i++) {
        const src = block.overlays[i];
        if (typeof src !== "string" || src.length === 0) {
          errors.push(`visuals.overlays[${i}]: must be a non-empty string`);
          continue;
        }
        if (src.length > MAX_DRAW_SOURCE_LEN) {
          errors.push(`visuals.overlays[${i}]: source too long (${src.length} > ${MAX_DRAW_SOURCE_LEN})`);
        }
      }
    }
  }

  // brains (cosmetic per-piece hooks)
  if (block.brains !== undefined) {
    if (!block.brains || typeof block.brains !== "object" || Array.isArray(block.brains)) {
      errors.push("visuals.brains: must be an object");
    } else {
      const brains = block.brains as Record<string, unknown>;
      for (const k of Object.keys(brains)) {
        if (!ALL_PIECE_TYPES.has(k)) {
          errors.push(`visuals.brains.${k}: key must be one of p/n/b/r/q/k`);
          continue;
        }
        const src = brains[k];
        if (typeof src !== "string" || src.length === 0) {
          errors.push(`visuals.brains.${k}: must be a non-empty string`);
          continue;
        }
        if (src.length > MAX_DRAW_SOURCE_LEN) {
          errors.push(`visuals.brains.${k}: source too long (${src.length} > ${MAX_DRAW_SOURCE_LEN})`);
        }
      }
    }
  }
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
          // Tolerate 0 as "no cooldown" - Gemini emits this
          // shape sometimes instead of omitting the field.
          if (!Number.isFinite(c) || c < 0 || c > 20) {
            errors.push(`${sub}.gating.cooldownPlies must be 0..20 when set (0 = no cooldown)`);
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

// ── Structured logging ──
//
// Supabase aggregates Edge Function stdout/stderr but the format
// is freeform unless we shape it ourselves. Emitting JSON lines
// makes filtering easy in the dashboard's Logs Explorer:
//   filter by event_type=ai_call_failed
//   filter by user_id=...
//   group by event_type for an at-a-glance breakdown
//
// The fields are minimal on purpose - logs cost money on the
// Supabase free tier (10GB/month) and we want them to stay
// useful without becoming noise.
function log(eventType: string, fields: Record<string, unknown> = {}) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      fn: "arena_rules",
      event: eventType,
      ...fields,
    });
    // stderr instead of stdout because Supabase routes stderr
    // separately and lets you grep on log_level=error/warning,
    // which is what these structured events feel most like.
    console.log(line);
  } catch {
    // Don't throw from a logger.
  }
}

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

  const t0 = performance.now();
  log("request_received", { prompt_chars: body.prompt.length, has_retry_hint: !!body.retryHint });

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
    log("rate_limited", { calls_in_window: rl.callsInWindow, max_calls: rl.maxCalls });
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
  // Hard cap. Either we're already over OR this call would
  // push us over - both block the same way with a friendly
  // dated message.
  if (preCheck.ok && (
    preCheck.usedMicroUsd >= preCheck.capMicroUsd ||
    preCheck.usedMicroUsd + estMicroUsd > preCheck.capMicroUsd
  )) {
    log("cap_exhausted", {
      used_micro_usd: preCheck.usedMicroUsd,
      cap_micro_usd: preCheck.capMicroUsd,
      est_micro_usd: estMicroUsd,
    });
    return new Response(JSON.stringify({
      ok: false,
      error: capExhaustedMessage(),
      capExhausted: true,
      model,
    }), {
      status: 503,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  // Soft warning: we're past the soft threshold but still under
  // the hard cap. Stash a flag on the eventual response so the
  // lobby can show "AI service is approaching its monthly limit"
  // without blocking generation.
  const softWarningActive = preCheck.ok && preCheck.warningActive;

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
  const firstPrompt = buildPrompt(body.prompt, undefined, plannerVibe, labMode, body.retryHint);
  const first = await callGemini(SYSTEM_PROMPT, firstPrompt, model);
  if (!first.ok) {
    log("gemini_call_failed", { model, error: first.error, attempt: 1 });
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
    const retryPrompt = buildPrompt(body.prompt, errors, plannerVibe, labMode, body.retryHint);
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
    log("validation_failed_after_retry", { model, error_count: errors.length, first_error: errors[0] });
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
    spend_warning: softWarningActive,
  };
  log("request_succeeded", {
    model,
    elapsed_ms: Math.round(performance.now() - t0),
    has_visuals: !!(rules as Record<string, unknown>).visuals,
    soft_warning: softWarningActive,
  });
  return new Response(JSON.stringify(resp), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
});
