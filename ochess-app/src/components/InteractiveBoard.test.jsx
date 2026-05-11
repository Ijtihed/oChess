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

  it("queues a promotion picker on a back-rank pawn drop and does NOT silently queen by default", () => {
    // Default behavior must surface the promotion choice. Silent
    // queening on rated games is a tournament-losing footgun;
    // callers wanting the old behavior pass autoPromoteToQueen.
    const fen = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
    const onMove = vi.fn(() => true);
    render(<InteractiveBoard fen={fen} onMove={onMove} playerColor="w" />);
    const opts = lastProps.current;
    const result = opts.onPieceDrop({ sourceSquare: "a7", targetSquare: "a8", piece: "wP" });
    // The drop is "accepted" (returns true) so react-chessboard
    // doesn't snap back, but onMove is deferred until the user
    // picks a piece in the overlay.
    expect(result).toBe(true);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("auto-promotes pawn moves to a queen when autoPromoteToQueen=true", () => {
    const fen = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
    const onMove = vi.fn(() => true);
    render(<InteractiveBoard fen={fen} onMove={onMove} playerColor="w" autoPromoteToQueen />);
    const opts = lastProps.current;
    opts.onPieceDrop({ sourceSquare: "a7", targetSquare: "a8", piece: "wP" });
    expect(onMove).toHaveBeenCalled();
    expect(onMove.mock.calls[0][0].promotion).toBe("q");
  });

  it("uses silent-queen for premoves regardless of picker default", () => {
    // Premoves are issued on the OPPONENT's turn. The picker would
    // interrupt bullet-chess flow, so premove promotions stay
    // silent-queen even with the picker enabled.
    // White's pawn on a7 ready to promote, but it's black to move
    // so this is a premove from white's perspective.
    const fenBlack = "4k3/P7/8/8/8/8/8/4K3 b - - 0 1";
    const onMove = vi.fn(() => true);
    render(<InteractiveBoard fen={fenBlack} onMove={onMove} playerColor="w" />);
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

  it("treats a same-square drop (pick up + drop back) as a silent no-op", async () => {
    // Regression: previously this would call onMove({from:e2,to:e2}),
    // which in Anki review would compare unequal to the expected
    // move and trigger the wrong-attempt red flash. Same-square
    // drops are a "changed my mind" gesture - no move, no error.
    const sounds = await import("../lib/sounds");
    sounds.playError.mockClear();
    const onMove = vi.fn();
    render(<InteractiveBoard fen={START_FEN} onMove={onMove} playerColor="w" />);
    const opts = lastProps.current;
    const result = opts.onPieceDrop({ sourceSquare: "e2", targetSquare: "e2", piece: "wP" });
    expect(result).toBe(false);
    expect(onMove).not.toHaveBeenCalled();
    expect(sounds.playError).not.toHaveBeenCalled();
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
