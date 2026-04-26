import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../lib/bot-engine", () => ({
  getBotMove: vi.fn(() => Promise.resolve({ from: "e7", to: "e5", san: "e5" })),
  getThinkDelay: () => 0,
  destroyBotEngines: vi.fn(),
  BOT_CONFIG: Array.from({ length: 8 }, (_, i) => ({ level: i, name: `Bot${i}`, desc: "d", engine: "random" })),
}));

vi.mock("../lib/sounds", () => ({
  playMoveSound: vi.fn(),
  playGameStart: vi.fn(),
  playVictory: vi.fn(),
  playDefeat: vi.fn(),
  playDraw: vi.fn(),
  playLowTime: vi.fn(),
  preloadAll: vi.fn(),
}));

vi.mock("../lib/coach", () => ({
  explainMove: vi.fn(() => Promise.resolve("Good move")),
  evaluatePosition: vi.fn(() => Promise.resolve({ eval_cp: 0 })),
}));

vi.mock("../lib/engine", () => ({
  init: vi.fn(() => Promise.resolve()),
  evaluate: vi.fn(() => Promise.resolve(null)),
  formatEval: vi.fn(() => "0.0"),
  evalToText: vi.fn(() => ""),
  isReady: vi.fn(() => false),
  destroy: vi.fn(),
  unlockEval: vi.fn(),
  lockEval: vi.fn(),
}));

vi.mock("../lib/openings", () => ({
  getOpeningName: vi.fn(() => Promise.resolve(null)),
  resetOpeningCache: vi.fn(),
}));

vi.mock("../lib/bot-chat", () => ({
  getBotChatMessage: vi.fn(() => null),
}));

vi.mock("./InteractiveBoard", () => ({
  default: () => <div data-testid="board">Board</div>,
}));

vi.mock("./SocialPanel", () => ({
  default: () => <div data-testid="social">Social</div>,
}));

import GameScreen from "./GameScreen";

describe("GameScreen", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders without TDZ or initialization errors", () => {
    const opponent = { name: "Rookie", level: 1 };
    const { container } = render(
      <MemoryRouter>
        <GameScreen opponent={opponent} playerColor="w" />
      </MemoryRouter>
    );
    expect(container).toBeDefined();
    expect(container.innerHTML).not.toBe("");
  });

  it("renders with time control", () => {
    const opponent = { name: "Club", level: 3 };
    const tc = { initial: 300000, increment: 3000 };
    const { container } = render(
      <MemoryRouter>
        <GameScreen opponent={opponent} playerColor="w" timeControl={tc} />
      </MemoryRouter>
    );
    expect(container.innerHTML).not.toBe("");
  });

  it("renders black side", () => {
    const opponent = { name: "Expert", level: 4 };
    const { container } = render(
      <MemoryRouter>
        <GameScreen opponent={opponent} playerColor="b" />
      </MemoryRouter>
    );
    expect(container.innerHTML).not.toBe("");
  });

  it("exports getSavedGame and clearSavedGame", async () => {
    const { getSavedGame, clearSavedGame } = await import("./GameScreen");
    expect(typeof getSavedGame).toBe("function");
    expect(typeof clearSavedGame).toBe("function");
    expect(getSavedGame()).toBeNull();
  });
});
