const KEY = "ochess_board_prefs";

const PIECE_SETS = [
  "cburnett", "alpha", "california", "cardinal", "companion",
  "fresca", "gioco", "governor", "horsey", "kosal",
  "maestro", "merida", "staunty", "tatiana", "letter",
  "pirouetti", "pixel", "shapes", "spatial", "celtic",
  "chess7", "chessnut", "dubrovny", "fantasy", "firi",
  "icpieces", "kiwen-suwi", "leipzig", "mpchess",
  "reillycraig", "rhosgfx", "riohacha", "shahi-ivory-brown",
  "anarcandy", "caliente", "cooke", "xkcd",
];

const COLOR_THEMES = [
  { id: "dark",    name: "Dark",    light: "#3e3e3e", dark: "#272727", type: "color" },
  { id: "green",   name: "Green",   light: "#779952", dark: "#466d1d", type: "color" },
  { id: "brown",   name: "Brown",   light: "#b58863", dark: "#825432", type: "color" },
  { id: "blue",    name: "Blue",    light: "#5a7faa", dark: "#2c4a6e", type: "color" },
  { id: "gray",    name: "Gray",    light: "#9e9e9e", dark: "#616161", type: "color" },
  { id: "purple",  name: "Purple",  light: "#8e6aae", dark: "#5a3d7a", type: "color" },
  { id: "wood",    name: "Wood",    light: "#c4a882", dark: "#8b6e4e", type: "color" },
  { id: "ice",     name: "Ice",     light: "#cdd5e0", dark: "#8a9bb5", type: "color" },
];

const IMAGE_THEMES = [
  { id: "img-blue-marble", name: "Blue Marble", src: "/images/board/blue-marble.jpg", type: "image" },
  { id: "img-wood",        name: "Wood",        src: "/images/board/wood.jpg",         type: "image" },
  { id: "img-wood2",       name: "Wood 2",      src: "/images/board/wood2.jpg",        type: "image" },
  { id: "img-wood3",       name: "Wood 3",      src: "/images/board/wood3.jpg",        type: "image" },
  { id: "img-wood4",       name: "Wood 4",      src: "/images/board/wood4.jpg",        type: "image" },
  { id: "img-maple",       name: "Maple",       src: "/images/board/maple.jpg",        type: "image" },
  { id: "img-maple2",      name: "Maple 2",     src: "/images/board/maple2.jpg",       type: "image" },
  { id: "img-marble",      name: "Marble",      src: "/images/board/marble.jpg",       type: "image" },
  { id: "img-leather",     name: "Leather",     src: "/images/board/leather.jpg",      type: "image" },
  { id: "img-canvas",      name: "Canvas",      src: "/images/board/canvas2.jpg",      type: "image" },
  { id: "img-metal",       name: "Metal",       src: "/images/board/metal.jpg",        type: "image" },
  { id: "img-olive",       name: "Olive",       src: "/images/board/olive.jpg",        type: "image" },
  { id: "img-grey",        name: "Grey",        src: "/images/board/grey.jpg",         type: "image" },
  { id: "img-horsey",      name: "Horsey",      src: "/images/board/horsey.jpg",       type: "image" },
  { id: "img-blue",        name: "Blue",        src: "/images/board/blue.png",         type: "image" },
  { id: "img-blue2",       name: "Blue 2",      src: "/images/board/blue2.jpg",        type: "image" },
  { id: "img-blue3",       name: "Blue 3",      src: "/images/board/blue3.jpg",        type: "image" },
  { id: "img-green",       name: "Green",       src: "/images/board/green.png",        type: "image" },
  { id: "img-brown",       name: "Brown",       src: "/images/board/brown.png",        type: "image" },
  { id: "img-purple",      name: "Purple",      src: "/images/board/purple.png",       type: "image" },
  { id: "img-purple-diag", name: "Purple Diag", src: "/images/board/purple-diag.png",  type: "image" },
  { id: "img-pink-pyramid",name: "Pink",        src: "/images/board/pink-pyramid.png", type: "image" },
  { id: "img-green-plastic",name: "Green Plastic", src: "/images/board/green-plastic.png", type: "image" },
];

const ALL_THEMES = [...COLOR_THEMES, ...IMAGE_THEMES];

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || "null");
    return { pieceSet: d?.pieceSet || "cburnett", boardTheme: d?.boardTheme || "dark" };
  } catch { return { pieceSet: "cburnett", boardTheme: "dark" }; }
}

function save(prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {}
}

function getTheme(id) {
  return ALL_THEMES.find((t) => t.id === id) || COLOR_THEMES[0];
}

export { PIECE_SETS, COLOR_THEMES, IMAGE_THEMES, ALL_THEMES, load, save, getTheme };
