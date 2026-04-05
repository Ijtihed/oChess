# oChess — Design Rules

## Color palette

- **Surfaces:** charcoal (#0c0c0c), graphite (#121212), ash gray (#171717, #222222)
- **Text:** crisp white (#ffffff primary), warm gray (#e2e2e2 body), muted gray variants
- **Accent:** none — if ever added, extremely restrained (one color, used sparingly)
- **Semantic:** emerald for success/online, error red for losses/errors, primary green for best-move highlights
- **Mode:** dark only (no light mode planned)

Mostly monochrome. Dark matte surfaces with subtle glossy highlights via border opacity.

## Typography

- **Headlines:** Manrope — extrabold, tight tracking
- **Body:** Inter — regular/medium weight, relaxed line height
- **Labels:** Inter — uppercase, wide tracking, tiny size (9–11px)
- **Mono:** system monospace for move notation (SAN/UCI)

Strong type hierarchy. Headlines are large and confident. Body text is quiet and recessive. All text sizes were bumped ~15% for readability.

## Spacing and layout

- Lots of breathing room
- Max content width: 1440px (removed in game/analysis screens for full-width layouts)
- Generous padding (px-4 to px-10 responsive)
- Cards and panels: subtle borders (white/[0.03] to white/[0.06])
- No rounded corners on cards (sharp, editorial feel) — exception: avatars and small indicators use rounded-full
- Board should be visually large — bigger than typical cramped chess layouts
- Friends/Social panel always pinned to right edge of screen

## Board presence

The board is the product. When shown:
- Give it significant screen real estate
- Don't crowd it with sidebars and toolbars
- Keep surrounding UI quiet: player info, clocks, move list — all recessive
- If boards are shown but not actively used, leave them with starting position or empty
- Board coordinates: dark grey, no colored hue, font size responsive to board size

## Custom cursor

oChess uses a portable custom pointer (see `.cursor/rules/custom-cursor.mdc` for full spec):
- 8×8px white circle, mix-blend-mode: difference
- Scale to 2.5× on interactive elements
- Hidden on touch/coarse pointer devices
- Native cursor hidden site-wide
- Board editor: floating piece image follows cursor when a piece is selected

## Interactive elements

- Buttons: sharp rectangles, filled primary (white bg, dark text) or outlined (border + transparent bg)
- Hover: subtle bg shift or text color change
- Active: scale(0.96) for tactile feel
- Transitions: 200ms standard, cubic-bezier for entrances
- Drag-and-drop: subtle white glow on hover squares (not dark/startling borders)
- Premove: displayed with blue-tinted highlighting
- Illegal move: brief red flash on target square
- Copy confirmation: inline "Copied!" text feedback

## Sound design

- Move, capture, check, castle, promote sounds on every board interaction
- Game start, victory, defeat, draw sounds
- Low time warning at 30s
- Error sound on illegal actions
- Audio pool for reliable concurrent playback

## Animations

- Page transitions: fade-up (12px translate, 250ms)
- Staggered reveals: CSS custom property `--delay` per element
- Board entrance: scale-in (0.96 → 1.0, 500–700ms)
- Keep animations subtle and fast — premium feel, not playful
- Board flash: green on correct puzzle move, red on incorrect

## Component patterns

- **Cards:** bg-surface-low, 1px border at white/[0.04], sharp corners, p-4 to p-6
- **Section headers:** uppercase label (9–10px) + headline (2xl–4xl extrabold)
- **Move lists:** scrollable with max-height, clickable plies, current ply highlighted
- **Eval bar:** vertical bar with dynamic white/black split, eval label positioned for contrast
- **Player bars:** name, rating, captured pieces (black pieces shown in grey for visibility), thinking spinner
- **Fatal error overlay:** full-screen, error code, debug details, copy-to-clipboard, exit button
- **Loading screen:** dark semi-transparent overlay covering everything including header/footer, centered text

## Responsive

- Mobile-first, but desktop is the primary experience (chess is a desktop activity)
- Board sizing uses clamp() for fluid scaling
- Board coordinates scale with board size
- Mobile: boards and pieces shown vertically
- Hamburger nav on mobile, horizontal nav on desktop

## What NOT to use

- No AI-generated images
- No stock illustrations
- No decorative graphics
- No loud gradients
- No playful cartoon-style visuals
- No fake futuristic chrome/glow effects
- No emoji in UI (except where naturally part of content)
- The interface is driven by: layout, type, spacing, surfaces, and board presence
