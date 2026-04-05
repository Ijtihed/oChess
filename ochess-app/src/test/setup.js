import "@testing-library/jest-dom/vitest";

class AudioMock {
  constructor() { this.src = ""; this.volume = 1; this.currentTime = 0; }
  play() { return Promise.resolve(); }
  pause() {}
  load() {}
  cloneNode() { return new AudioMock(); }
  addEventListener() {}
  removeEventListener() {}
}
globalThis.Audio = AudioMock;

globalThis.Worker = class {
  constructor() {}
  postMessage() {}
  addEventListener() {}
  removeEventListener() {}
  terminate() {}
};

globalThis.matchMedia =
  globalThis.matchMedia ||
  function () {
    return { matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} };
  };

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
