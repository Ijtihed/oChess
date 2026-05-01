import { Howl, Howler } from "howler";

let enabled = true;
let masterVolume = parseFloat(localStorage.getItem("ochess_volume") || "0.7");
Howler.volume(masterVolume);

const THEME = "standard";

// One Howl per logical event so we can use the right Lichess sound
// for each context. The dedicated NewPM / NewChallenge / SocialNotify
// files are intentionally distinct from Victory / Defeat / Draw so
// players never confuse "opponent sent chat" with "you lost the
// game" - which was the bug reported on the deployed build.
const SOUNDS = {
  move:           new Howl({ src: [`/sound/${THEME}/Move.mp3`],          preload: true }),
  capture:        new Howl({ src: [`/sound/${THEME}/Capture.mp3`],       preload: true }),
  check:          new Howl({ src: [`/sound/${THEME}/Check.mp3`],         preload: true }),
  checkmate:      new Howl({ src: [`/sound/${THEME}/Checkmate.mp3`],     preload: true }),
  victory:        new Howl({ src: [`/sound/${THEME}/Victory.mp3`],       preload: true }),
  defeat:         new Howl({ src: [`/sound/${THEME}/Defeat.mp3`],        preload: true }),
  draw:           new Howl({ src: [`/sound/${THEME}/Draw.mp3`],          preload: true }),
  start:          new Howl({ src: [`/sound/${THEME}/Confirmation.mp3`],  preload: true }),
  error:          new Howl({ src: [`/sound/${THEME}/Error.mp3`],         preload: true }),
  lowTime:        new Howl({ src: [`/sound/${THEME}/LowTime.mp3`],       preload: true }),
  // Inbound chat - lichess "private message" cue.
  chatNotify:     new Howl({ src: [`/sound/${THEME}/NewPM.mp3`],         preload: true }),
  // Draw offer / rematch offer / incoming challenge cue. Lichess uses
  // this exact file for "someone is offering you a game".
  offerNotify:    new Howl({ src: [`/sound/${THEME}/NewChallenge.mp3`],  preload: true }),
  // Friend-system events (request received, accepted, removed).
  socialNotify:   new Howl({ src: [`/sound/${THEME}/SocialNotify.mp3`],  preload: true }),
  // Generic fallback if nothing more specific fits.
  notify:         new Howl({ src: [`/sound/${THEME}/GenericNotify.mp3`], preload: true }),
};

if (typeof document !== "undefined") {
  const unlock = () => {
    if (Howler.ctx && Howler.ctx.state === "suspended") Howler.ctx.resume();
    for (const e of UNLOCK_EVENTS) document.removeEventListener(e, unlock, true);
  };
  const UNLOCK_EVENTS = ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend", "click", "keydown"];
  for (const e of UNLOCK_EVENTS) document.addEventListener(e, unlock, true);
}

function play(key, volume = 0.7) {
  if (!enabled) return;
  if (Howler.ctx && Howler.ctx.state === "suspended") Howler.ctx.resume();
  const h = SOUNDS[key];
  if (!h) return;
  h.volume(volume);
  h.play();
}

function preloadAll() {
  Object.values(SOUNDS).forEach((h) => h.load());
}

/**
 * Move sound dispatcher.
 *
 * For checkmating moves we deliberately do NOT play the dramatic
 * "checkmate" sound here. Every game-screen calls `playVictory()` /
 * `playDefeat()` immediately after detecting the mate, and stacking
 * Checkmate.mp3 (~1 s) on top of Victory.mp3 (~3 s) creates the
 * "off-feeling" double-trigger players hear at the end of a game.
 *
 * For analysis playback (where there's no follow-up game-end sound)
 * pass `{ allowMateSound: true }` to restore the Checkmate.mp3 cue.
 */
function playMoveSound(moveResult, { allowMateSound = false } = {}) {
  if (!moveResult) return;
  const san = typeof moveResult === "string" ? moveResult : (moveResult.san || "");
  if (san.includes("#")) {
    if (allowMateSound) play("checkmate", 1);
    else if (moveResult.captured) play("capture", 0.85);
    else play("move", 0.75);
  } else if (san.includes("+"))   play("check", 0.9);
  else if (moveResult.captured)  play("capture", 0.85);
  else                            play("move", 0.75);
}

function playGameStart()   { play("start",        0.6); }
function playVictory()     { play("victory",      0.9); }
function playDefeat()      { play("defeat",       0.9); }
function playDraw()        { play("draw",         0.7); }
function playError()       { play("error",        0.7); }
function playLowTime()     { play("lowTime",      0.8); }
function playChatNotify()  { play("chatNotify",   0.6); }
function playOfferNotify() { play("offerNotify",  0.7); }
function playSocialNotify() { play("socialNotify", 0.6); }
function playNotify()      { play("notify",       0.6); }

/**
 * Play a sound when an arena ability is cast. Picks an audible
 * cue from the existing sound library based on the ability's
 * `effect` and (for marks) the user-facing `tag` so that a
 * "frost" mark sounds different from a "fireball" destroy.
 *
 * The Lichess sound set we ship doesn't include thematic
 * spell sounds, so we map by texture:
 *   - capture-y effects (destroy / displace) -> capture sound
 *   - status marks -> a "notify" feel (the engine just changed
 *     state but no piece moved yet)
 *   - spawn / transform -> the "start" confirmation cue
 *   - relocate_self -> the standard move sound
 *
 * Falls back to the generic notify if no specific mapping fits.
 *
 * @param {object} ability  The full ability spec (has `effect.kind` and optional `effect.tag`).
 */
function playAbilityCast(ability) {
  const eff = ability?.effect;
  if (!eff || typeof eff !== "object") {
    play("notify", 0.6);
    return;
  }
  switch (eff.kind) {
    case "capture":
    case "destroy":
      play("capture", 0.85);
      return;
    case "displace":
      play("capture", 0.7);
      return;
    case "spawn":
    case "transform":
      play("start", 0.55);
      return;
    case "relocate_self":
      play("move", 0.75);
      return;
    case "mark":
      play("offerNotify", 0.55);
      return;
    case "aoe_wrap":
      // AOE that destroys feels the most "spell-like" via the
      // capture sound; AOE that marks (e.g. frost burst) uses
      // the lighter notify cue.
      if (eff.inner?.kind === "destroy" || eff.inner?.kind === "capture") {
        play("capture", 0.95);
      } else {
        play("offerNotify", 0.7);
      }
      return;
    default:
      play("notify", 0.6);
  }
}

function setEnabled(v) { enabled = v; }
function isEnabled() { return enabled; }

function getVolume() { return masterVolume; }
function setVolume(v) {
  masterVolume = Math.max(0, Math.min(1, v));
  Howler.volume(masterVolume);
  try { localStorage.setItem("ochess_volume", String(masterVolume)); } catch {}
}

export {
  preloadAll,
  playMoveSound,
  playGameStart,
  playVictory,
  playDefeat,
  playDraw,
  playError,
  playLowTime,
  playChatNotify,
  playOfferNotify,
  playSocialNotify,
  playNotify,
  playAbilityCast,
  setEnabled,
  isEnabled,
  getVolume,
  setVolume,
};
