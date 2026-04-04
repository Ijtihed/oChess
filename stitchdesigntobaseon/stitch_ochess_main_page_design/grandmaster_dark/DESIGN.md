# Design System Specification: The Grandmaster Editorial

## 1. Overview & Creative North Star
The Creative North Star for this design system is **"The Silent Strategist."** 

This system moves away from the "gamified" clutter of traditional chess applications, instead embracing the aesthetic of a high-end editorial journal or a luxury watch catalog. It is characterized by **Monochromatic Brutalism**—a style that favors heavy blacks, stark whites, and intentional asymmetry to create a sense of intellectual authority. 

To break the "template" look, we utilize aggressive negative space and "The Tension of the Edge"—placing key data points near the margins to create a sophisticated, wide-screen cinematic feel. We do not fill space; we curate it.

---

## 2. Colors & Tonal Depth
The palette is a study in monochromatic discipline. While the foundation is matte black, the interface achieves "soul" through subtle shifts in luminance rather than hue.

### The "No-Line" Rule
**Prohibit 1px solid borders for sectioning.** Conventional dividers are forbidden. Boundaries must be defined solely through background color shifts. For instance, a player profile module (`surface-container-low`) sits directly on the app background (`surface`) without a stroke. The contrast in value is the divider.

### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers. We use "Tonal Nesting" to establish focus:
- **Base Layer:** `surface` (#131313) for the main application background.
- **Secondary Tier:** `surface-container-low` (#1b1b1b) for large content areas or sidebar backgrounds.
- **Interactive Tier:** `surface-container-high` (#2a2a2a) for hover states or active card selections.
- **The "Void":** `surface-container-lowest` (#0e0e0e) for "sunken" elements like the move-history log, creating a sense of depth and permanence.

### The "Glass & Gloss" Rule
To evoke a "premium matte" texture, floating elements (modals, tooltips) must use **Glassmorphism**:
- Use `surface-container` with a 70-80% opacity.
- Apply a `backdrop-filter: blur(20px)`.
- This allows the chess board or background typography to bleed through, softening the interface and making it feel like a single, integrated object.

---

## 3. Typography
The typography is the voice of the system: precise, modern, and authoritative. We pair the geometric strength of **Manrope** for high-impact displays with the utilitarian clarity of **Inter** for data-heavy chess notation.

*   **Display & Headlines (Manrope):** These should be treated as graphic elements. Use `display-lg` for win/loss states or tournament titles. Utilize tight letter-spacing (-2%) for a "compact-modern" editorial feel.
*   **Titles & Body (Inter):** Used for player names and move lists. The high x-height of Inter ensures readability even at `body-sm` (0.75rem) when viewing complex move variations.
*   **The Editorial Weight:** Lean into extreme weight contrasts. A `display-lg` title in Bold should be paired with `label-sm` metadata in Medium to create a "Signature Editorial" hierarchy.

---

## 4. Elevation & Depth
In this design system, elevation is conveyed through **Tonal Layering**, not structural shadows.

*   **The Layering Principle:** Avoid "Drop Shadows" in the traditional sense. A card gains "lift" by being two steps higher on the surface scale than its parent (e.g., a `surface-container-highest` card sitting on a `surface-container-low` background).
*   **Ambient Shadows:** If a floating element (like a piece promotion menu) requires a shadow, it must be an **Ambient Bloom**: `box-shadow: 0 20px 40px rgba(0,0,0,0.4)`. It should look like the element is casting a soft shadow on a dark table, not floating in white space.
*   **The "Ghost Border" Fallback:** If accessibility requires a stroke (e.g., high-contrast mode), use a **Ghost Border**: `outline-variant` (#444748) at **15% opacity**. This provides a hint of a container without breaking the monochromatic flow.

---

## 5. Components

### The Chess Board & Pieces
*   **The Board:** Forgo the classic wood grain. Use `surface-container-highest` for dark squares and `secondary` (#c7c6c6) for light squares.
*   **The Highlight:** The "last move" highlight should be a subtle `surface-tint` glow or a crisp `primary` (white) 2px internal border on the square.

### Buttons (Tactile Luxury)
*   **Primary:** Solid `primary` (White) with `on-primary` (Dark Charcoal) text. No rounded corners—use the `sm` (0.125rem) radius for a "sharp" precision look.
*   **Secondary:** Ghost style. Transparent background with a `Ghost Border` (15% opacity white). 
*   **Tertiary:** Text-only, using `label-md` in all-caps with 0.1em letter spacing.

### Cards & Information Modules
*   **The "No-Divider" Rule:** In player lists or move logs, never use lines. Use `spacing.xl` to separate groups, or alternate between `surface-container-low` and `surface-container-lowest` for a striped "Zebra" effect that feels more architectural.

### Input Fields
*   **States:** Default state is a bottom-border only (`outline-variant`). On focus, the border transitions to a crisp `primary` white. Error states use `error` (#ffb4ab) but keep the text `on-surface` to maintain the dark mood.

---

## 6. Do's and Don'ts

### Do
*   **Do** use asymmetrical layouts. Place the chessboard slightly off-center to make room for large, editorial typography.
*   **Do** use "Inertia" in animations. Elements should slide with a heavy, deliberate feel (`cubic-bezier(0.2, 0, 0, 1)`).
*   **Do** prioritize negative space. If a screen feels "full," remove a container and use typography to define the area instead.

### Don't
*   **Don't** use pure 100% white (#FFFFFF) for body text. Use `on-surface-variant` (#c4c7c8) to prevent eye strain against the dark background. Reserve pure white for Headlines.
*   **Don't** use standard "Material" ripples for clicks. Use a subtle "flash" of luminance (increasing the background brightness by 10%).
*   **Don't** use rounded corners above `sm` (0.125rem) for functional elements. Only use `full` for status indicators (online/offline pips). Keep the vibe sharp and "cut."