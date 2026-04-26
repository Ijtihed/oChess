/**
 * VariantGameScreen smoke test.
 *
 * Mirrors the OnlineGameScreen smoke harness — mocks bot-engine, sounds,
 * variants, and InteractiveBoard so we can mount the default-export and
 * verify the basic UI renders without crashing for the supported variants.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import VariantGameScreen from "./VariantGameScreen";

vi.mock("../lib/sounds", () => ({
  playMoveSound: vi.fn(),
  playGameStart: vi.fn(),
  playVictory: vi.fn(),
  playDefeat: vi.fn(),
  playDraw: vi.fn(),
  preloadAll: vi.fn(),
}));

vi.mock("../lib/bot-engine", () => ({
  getBotMove: vi.fn(() => Promise.resolve(null)),
  getThinkDelay: vi.fn(() => 0),
}));

vi.mock("../lib/bot-chat", () => ({
  getBotChatMessage: vi.fn(() => null),
}));

// Variant game state — the screen reads `.fen()` / `.move()` /
// `.history()` / `.checkEnd()` from this object. A minimal stub
// is enough for the smoke render.
function makeVariantGame() {
  // The screen reaches into a wide variant-game contract; stub every
  // method it touches during mount so we don't have to react to each
  // missing call individually.
  return {
    def: { id: "antichess", name: "Antichess", description: "Lose all your pieces to win." },
    fen: () => "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    history: () => [],
    move: () => null,
    moves: () => [],
    turn: () => "w",
    isGameOver: () => false,
    isCheckmate: () => false,
    isDraw: () => false,
    pgn: () => "",
    checkEnd: () => null,
    legalMovesFrom: () => [],
    isMultiMove: () => false,
    isFogOfWar: () => false,
    getMaskedFen: () => "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    onTurnStart: () => 1,
    onTurnEnd: () => {},
    onSubMoveComplete: () => {},
    shouldEndSequence: () => false,
    getHillSquares: () => [],
    getCheckCounts: () => ({ white: 0, black: 0 }),
  };
}

vi.mock("../lib/variants", () => ({
  createVariantGame: vi.fn(() => makeVariantGame()),
  getVariant: vi.fn(() => ({
    id: "antichess",
    name: "Antichess",
    description: "Lose all your pieces to win.",
  })),
  VARIANTS: [
    { id: "antichess", name: "Antichess", description: "Lose all your pieces." },
  ],
}));

vi.mock("./SocialPanel", () => ({ default: () => null }));
vi.mock("./InteractiveBoard", () => ({
  default: ({ fen }) => <div data-testid="board" data-fen={fen || ""}>board</div>,
}));

function mount(variantId = "antichess", playerColor = "w") {
  return render(
    <MemoryRouter>
      <VariantGameScreen
        variantId={variantId}
        opponent={{ name: "Bot Antichess", elo: 1200 }}
        playerColor={playerColor}
      />
    </MemoryRouter>
  );
}

describe("VariantGameScreen (smoke)", () => {
  it("mounts and renders the board for a known variant", () => {
    mount();
    const board = screen.getByTestId("board");
    expect(board.getAttribute("data-fen")).toMatch(/^rnbqkbnr/);
  });

  it("renders the opponent name", () => {
    mount();
    expect(screen.getAllByText(/Bot Antichess/).length).toBeGreaterThan(0);
  });

  it("does not show a result panel before the game ends", () => {
    mount();
    expect(screen.queryByText(/^You win!$/)).toBeNull();
    expect(screen.queryByText(/^You lost$/)).toBeNull();
  });

  it("survives playing as black without crashing", () => {
    mount("antichess", "b");
    expect(screen.getByTestId("board")).toBeDefined();
  });
});
