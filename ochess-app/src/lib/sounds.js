import { Howl, Howler } from "howler";

let enabled = true;
let masterVolume = parseFloat(localStorage.getItem("ochess_volume") || "0.7");
Howler.volume(masterVolume);

const THEME = "standard";

const SOUNDS = {
  move:      new Howl({ src: [`/sound/${THEME}/Move.mp3`],      preload: true }),
  capture:   new Howl({ src: [`/sound/${THEME}/Capture.mp3`],   preload: true }),
  check:     new Howl({ src: [`/sound/${THEME}/Check.mp3`],     preload: true }),
  checkmate: new Howl({ src: [`/sound/${THEME}/Checkmate.mp3`], preload: true }),
  victory:   new Howl({ src: [`/sound/${THEME}/Victory.mp3`],   preload: true }),
  defeat:    new Howl({ src: [`/sound/${THEME}/Defeat.mp3`],    preload: true }),
  draw:      new Howl({ src: [`/sound/${THEME}/Draw.mp3`],      preload: true }),
  start:     new Howl({ src: [`/sound/${THEME}/Confirmation.mp3`], preload: true }),
  error:     new Howl({ src: [`/sound/${THEME}/Error.mp3`],     preload: true }),
  lowTime:   new Howl({ src: [`/sound/${THEME}/LowTime.mp3`],   preload: true }),
  notify:    new Howl({ src: [`/sound/${THEME}/GenericNotify.mp3`], preload: true }),
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

function playMoveSound(moveResult) {
  if (!moveResult) return;
  const san = typeof moveResult === "string" ? moveResult : (moveResult.san || "");
  if (san.includes("#"))       play("checkmate", 1);
  else if (san.includes("+"))  play("check", 0.9);
  else if (moveResult.captured) play("capture", 0.85);
  else                          play("move", 0.75);
}

function playGameStart() { play("start", 0.6); }
function playVictory()   { play("victory", 0.9); }
function playDefeat()    { play("defeat", 0.9); }
function playDraw()      { play("draw", 0.7); }
function playError()     { play("error", 0.7); }
function playLowTime()   { play("lowTime", 0.8); }
function playNotify()    { play("notify", 0.6); }

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
  playNotify,
  setEnabled,
  isEnabled,
  getVolume,
  setVolume,
};
