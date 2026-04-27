import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// Capture the most recent props handed to the underlying chessboard
// so the test bodies can fire its callbacks directly.
const lastProps = { current: null };

vi.mock("react-chessboard", () => ({
  Chessboard: ({ options }) => {
    lastProps.current = options;
    return <div data-testid="cb" />;
  },
}));

vi.mock("../lib/sounds", () => ({
  playMoveSound: vi.fn(),
  playError: vi.fn(),
}));

vi.mock("../lib/board-prefs", () => ({
  load: () => ({ pieceSet: "cburnett", boardTheme: "dark" }),
  getTheme: () => ({ id: "dark", type: "color", light: "#3e3e3e", dark: "#272727" }),
}));

import InteractiveBoard from "./InteractiveBoard";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

beforeEach(() => { lastProps.current = null; });

describe("InteractiveBoard - drag/drop", () => {
  it("forwards a legal pawn move from the mocked chessboard to onMove", () => {
    const onMove = vi.fn(() => true);
    render(<InteractiveBoard fen={START_FEN} onMove={onMove} playerColor="w" />);
    const opts = lastProps.current;
    expect(opts).toBeTruthy();
    const result = opts.onPieceDrop({ sourceSquare: "e2", targetSquare: "e4" });
    expect(result).toBe(true);
    expect(onMove).toHaveBeenCalled();
    const call = onMove.mock.calls[0][0];
    expect(call.from).toBe("e2");
    expect(call.to).toBe("e4");
  });

  it("rejects drops when interactive=false", () => {
    const onMove = vi.fn();
    render(<InteractiveBoard fen={START_FEN} onMove={onMove} playerColor="w" interactive={false} />);
    const opts = lastProps.current;
    const result = opts.onPieceDrop({ sourceSquare: "e2", targetSquare: "e4" });
    expect(result).toBe(false);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("auto-promotes pawn moves to the back rank to a queen by default", () => {
    // White pawn one square from promotion. react-chessboard passes
    // the piece string in the drop payload; we mirror that here.
    const fen = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
    const onMove = vi.fn(() => true);
    render(<InteractiveBoard fen={fen} onMove={onMove} playerColor="w" />);
    const opts = lastProps.current;
    opts.onPieceDrop({ sourceSquare: "a7", targetSquare: "a8", piece: "wP" });
    expect(onMove).toHaveBeenCalled();
    expect(onMove.mock.calls[0][0].promotion).toBe("q");
  });

  it("renders the underlying chessboard with the given fen + orientation", () => {
    render(<InteractiveBoard fen={START_FEN} onMove={vi.fn()} playerColor="w" orientation="black" />);
    const opts = lastProps.current;
    expect(opts.position).toBe(START_FEN);
    expect(opts.boardOrientation).toBe("black");
  });
});

describe("InteractiveBoard - square click sanity", () => {
  it("clicking an empty square with no selection does nothing (does not call onMove)", () => {
    const onMove = vi.fn();
    render(<InteractiveBoard fen={START_FEN} onMove={onMove} playerColor="w" />);
    const opts = lastProps.current;
    // Empty square + nothing selected -> no-op.
    opts.onSquareClick({ square: "e4" });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("hands a highlightSquares prop straight through to the chessboard squareStyles", () => {
    const hl = { e4: { backgroundColor: "rgba(255,0,0,0.2)" } };
    render(<InteractiveBoard fen={START_FEN} onMove={vi.fn()} playerColor="w" highlightSquares={hl} />);
    const opts = lastProps.current;
    expect(opts.squareStyles?.e4).toBeDefined();
  });
});
