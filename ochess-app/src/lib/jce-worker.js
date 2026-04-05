import { aiMove } from "js-chess-engine";

self.onmessage = (e) => {
  const { fen, level } = e.data;
  try {
    const result = aiMove(fen, level);
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
