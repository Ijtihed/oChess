import { useMemo, useState, useEffect, useCallback } from "react";

const INITIAL_POSITION = [
  ["r", "n", "b", "q", "k", "b", "n", "r"],
  ["p", "p", "p", "p", "p", "p", "p", "p"],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  ["P", "P", "P", "P", "P", "P", "P", "P"],
  ["R", "N", "B", "Q", "K", "B", "N", "R"],
];

const PIECE_SETS = [
  "alpha", "anarcandy", "caliente", "california", "cardinal",
  "cburnett", "celtic", "chess7", "chessnut", "companion",
  "cooke", "disguised", "dubrovny", "fantasy", "firi",
  "fresca", "gioco", "governor", "horsey", "icpieces",
  "kiwen-suwi", "kosal", "leipzig", "letter", "maestro",
  "merida", "mpchess", "pirouetti",
  "pixel", "reillycraig", "rhosgfx", "riohacha",
  "shahi-ivory-brown", "shapes", "spatial", "staunty", "tatiana", "xkcd",
];

// ── Board images from /public/images/board/ ──
const IMAGE_BOARDS = [
  "blue-marble.jpg", "blue.png", "blue2.jpg", "blue3.jpg",
  "brown.png", "canvas2.jpg", "green-plastic.png", "green.png",
  "grey.jpg", "horsey.jpg", "leather.jpg",
  "maple.jpg", "maple2.jpg", "marble.jpg", "metal.jpg",
  "olive.jpg", "pink-pyramid.png", "purple-diag.png", "purple.png",
  "wood.jpg", "wood2.jpg", "wood3.jpg", "wood4.jpg",
].map((file) => {
  const name = file.replace(/\.\w+$/, "");
  return { id: name, name, src: `/images/board/${file}`, type: "image" };
});

const SVG_BOARDS = [
  { id: "newspaper", name: "newspaper", src: "/images/board/svg/newspaper.svg", type: "image" },
];

const ALL_BOARDS = [...IMAGE_BOARDS, ...SVG_BOARDS];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildStyles() {
  const boards = shuffle(ALL_BOARDS);
  const pieces = shuffle(PIECE_SETS);
  return boards.map((board, i) => ({
    board,
    pieceSet: pieces[i % pieces.length],
  }));
}

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"];

function pieceToFile(piece) {
  const color = piece === piece.toUpperCase() ? "w" : "b";
  return `${color}${piece.toUpperCase()}.svg`;
}

function displayName(name) {
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default function ChessBoard({
  position = INITIAL_POSITION,
  board: fixedBoard,
  pieceSet: fixedPieceSet,
  cycling = false,
  cycleInterval = 2500,
  onClick,
  className = "",
}) {
  const [styles] = useState(buildStyles);
  const [styleIndex, setStyleIndex] = useState(0);

  useEffect(() => {
    if (!cycling) return;
    const id = setInterval(() => {
      setStyleIndex((prev) => (prev + 1) % styles.length);
    }, cycleInterval);
    return () => clearInterval(id);
  }, [cycling, cycleInterval, styles.length]);

  const current = styles[styleIndex];
  const board = fixedBoard || current.board;
  const pieceSet = fixedPieceSet || current.pieceSet;

  const squares = useMemo(() => {
    const result = [];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const piece = position[row]?.[col];
        result.push({ row, col, piece });
      }
    }
    return result;
  }, [position]);

  return (
    <div
      className={`relative select-none ${onClick ? "cursor-pointer" : ""} ${className}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter") onClick(); } : undefined}
    >
      <div className="p-[2px] bg-white/[0.04]">
        <div
          className="aspect-square"
          style={{
            backgroundImage: `url(${board.src})`,
            backgroundSize: "100% 100%",
          }}
          role="img"
          aria-label="Chess board"
        >
          <div
            className="grid w-full h-full"
            style={{
              gridTemplateColumns: "repeat(8, 1fr)",
              gridTemplateRows: "repeat(8, 1fr)",
            }}
          >
            {squares.map(({ row, col, piece }) => (
              <div key={`${row}-${col}`} className="relative overflow-hidden">
                {piece && (
                  <img
                    src={`/piece/${pieceSet}/${pieceToFile(piece)}`}
                    alt=""
                    draggable={false}
                    className="absolute inset-[3%] w-[94%] h-[94%] object-contain pointer-events-none"
                  />
                )}
                {row === 7 && (
                  <span className="absolute bottom-[2px] right-[3px] text-[7px] font-headline font-bold leading-none text-black/20">
                    {FILES[col]}
                  </span>
                )}
                {col === 0 && (
                  <span className="absolute top-[2px] left-[3px] text-[7px] font-headline font-bold leading-none text-black/20">
                    {RANKS[row]}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Board + piece set names */}
      {cycling && (
        <div className="mt-3 flex items-center justify-center gap-2 opacity-0 animate-[fade-in_0.4s_ease_0.8s_both]">
          <span className="font-label text-[10px] uppercase tracking-[0.12em] text-on-surface-variant/35">
            {displayName(board.name)}
          </span>
          <span className="text-on-surface-variant/15 text-[10px]">/</span>
          <span className="font-label text-[10px] tracking-[0.08em] text-on-surface-variant/25">
            {displayName(pieceSet)}
          </span>
        </div>
      )}
    </div>
  );
}
