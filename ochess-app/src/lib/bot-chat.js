/**
 * Bot chat — static personality lines.
 * For custom bots, API-key-based LLM chat will be added later.
 */

const LINES = {
  0: {
    move: ["lol", "wheee", "random goes brrrr", "i have no idea what im doing", "yolo"],
    capture: ["oops took something", "was that important?", "mine now haha"],
    check: ["oh no", "wait what", "is that check?? lol"],
    mate: ["wait i lost? how", "gg i guess"],
    takeback: ["lol ok", "sure haha", "undo go brrrr"],
  },
  1: {
    move: ["hmm ok", "i think this is good?", "am i doing this right", "my coach said develop pieces", "ok your turn"],
    capture: ["oh nice i got a piece!", "was that a blunder? thanks!", "taking that!"],
    check: ["check!", "did i just check you?", "ooh"],
    mate: ["wait... did i win?? no way"],
    takeback: ["ok no problem!", "sure, happens to me too", "take your time"],
  },
  2: {
    move: ["developing...", "i see what you did there", "interesting", "not sure about that one", "ok let me think"],
    capture: ["i'll take that", "thanks for the free piece", "fair trade", "had to grab that"],
    check: ["check!", "watch out", "didn't see that coming did you"],
    mate: ["checkmate! get good"],
    takeback: ["fine, but I saw that blunder", "alright alright", "scared?"],
  },
  3: {
    move: ["solid move", "i like this position", "your structure looks weak", "controlling the center", "tempo"],
    capture: ["good trade", "material advantage now", "that was hanging", "forced capture"],
    check: ["check. now what?", "your king looks exposed", "pressure"],
    mate: ["gg, well fought"],
    takeback: ["takeback granted", "ok, let's see what you've got", "sure"],
  },
  4: {
    move: ["hmm", "noted", "ok", "fine", "logical"],
    capture: ["taken", "material", "forced"],
    check: ["check", "king safety", "exposed"],
    mate: ["that's the game"],
    takeback: ["if you must", "noted"],
  },
  5: {
    move: ["...", "interesting idea", "i see"],
    capture: ["necessary", "material counts"],
    check: ["check"],
    mate: ["well played. or not."],
    takeback: ["...fine"],
  },
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)] || null;
}

function getBotChatMessage(level, moveInfo) {
  if (level >= 6) return null;
  const lines = LINES[level] || LINES[3];
  if (moveInfo.san === "takeback") return pick(lines.takeback);
  if (moveInfo.mate) return pick(lines.mate);
  if (moveInfo.check) return pick(lines.check);
  if (moveInfo.captured) return pick(lines.capture);
  return pick(lines.move);
}

export { getBotChatMessage };
