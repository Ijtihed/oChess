/**
 * Match-seeded PRNG for deterministic, replay-friendly visuals.
 *
 * Both clients in a multiplayer match render the SAME visuals
 * by seeding from the match id (passed via INIT). Same applies
 * to spectators and replay viewers - the animation a queen's
 * fireball draws is byte-for-byte identical on every screen
 * showing the same cast.
 *
 * Why xoshiro128+: small state, fast, statistically excellent,
 * no security claims (we don't need cryptographic randomness;
 * we just need deterministic noise that doesn't look obviously
 * patterned). And it's tiny - the whole implementation is ~30
 * lines.
 *
 * The seed is derived from a string (typically `match_id` plus
 * an optional `cast_id` so per-cast randomness doesn't visually
 * collide with per-piece-aura randomness).
 */

/**
 * Build a draw-friendly random function from a string seed.
 *
 * @param {string} seedStr  Any deterministic string (e.g. match id,
 *                          or `${match_id}:cast:${cast_id}`).
 * @returns {() => number}  A function returning a number in [0, 1).
 */
export function makeRandom(seedStr) {
  const state = stringToSeedTuple(String(seedStr || "default-seed"));
  let s0 = state[0], s1 = state[1], s2 = state[2], s3 = state[3];

  // xoshiro128+ next: returns a uint32, then we map to [0, 1).
  return function next() {
    const result = (s0 + s3) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = (s3 << 11) | (s3 >>> 21);
    return result / 0x100000000;
  };
}

/**
 * Hash a string into a 4-uint32 tuple suitable for seeding
 * xoshiro128+. We use a small FNV-like mixer; not collision-
 * resistant but fine for non-cryptographic seeding.
 *
 * Important: the four state words must not all be zero, or
 * xoshiro outputs nothing but zero forever. We fold a constant
 * into one slot to avoid that degenerate case.
 */
function stringToSeedTuple(str) {
  let h0 = 0x9E3779B1; // golden-ratio-derived constants used by
  let h1 = 0xBB67AE85; // various splittables; arbitrary nonzero.
  let h2 = 0x3C6EF372;
  let h3 = 0xA54FF53A;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h0 = mix32(h0 ^ c) >>> 0;
    h1 = mix32(h1 + c) >>> 0;
    h2 = mix32(h2 ^ ((c << 8) | (c >>> 24))) >>> 0;
    h3 = mix32(h3 + h0 + c) >>> 0;
  }
  // Avoid the all-zero degenerate case.
  if ((h0 | h1 | h2 | h3) === 0) {
    h0 = 1;
  }
  return [h0, h1, h2, h3];
}

/**
 * 32-bit integer mixer (Murmur3 finalizer). Spreads input bits
 * uniformly across the output.
 */
function mix32(x) {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}
