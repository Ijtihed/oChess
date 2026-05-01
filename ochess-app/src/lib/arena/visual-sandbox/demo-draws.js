/**
 * Hand-coded demo visual draws for verifying the rendering
 * loop works end-to-end before AI integration lands.
 *
 * These are written by hand but go through the SAME
 * compileVisuals pipeline (validator + loop guard) as
 * AI-emitted draws. If the demo doesn't render, the pipeline
 * is broken; if the demo does render, the pipeline works
 * and AI-emitted draws will flow through the same path.
 *
 * Each draw uses ONLY the API surface allowed by the
 * validator (no fetch / Date / setTimeout / fillText /
 * etc), so this file is also a useful reference for what
 * the AI prompt should teach Gemini.
 *
 * Usage: in dev, set the ArenaVisualOverlay's compiledDraws
 * prop to compileVisuals(DEMO_VISUALS).compiled and the
 * board will render colored auras + projectiles.
 */

export const DEMO_VISUALS = {
  slots: {
    // Pulsing colored aura on every queen.
    "q.aura": `
      const phase = Math.sin(t * 0.003) * 0.5 + 0.5;
      const radius = 24 + phase * 6;
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
      const color = owner.color === "w" ? "rgba(255, 220, 100," : "rgba(150, 100, 255,";
      g.addColorStop(0, color + (0.4 + phase * 0.3) + ")");
      g.addColorStop(0.6, color + (0.15 + phase * 0.1) + ")");
      g.addColorStop(1, color + "0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
    `,

    // Spinning energy ring on every knight.
    "n.aura": `
      const angle = t * 0.002 * facing;
      ctx.strokeStyle = owner.color === "w" ? "rgba(120, 220, 255, 0.7)" : "rgba(255, 180, 120, 0.7)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, 18, angle, angle + Math.PI * 1.4);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 22, angle + Math.PI, angle + Math.PI * 2.4);
      ctx.stroke();
    `,

    // Subtle drift on every pawn (proves brain-style motion works
    // without needing brain hooks).
    "p.aura": `
      const wobble = Math.sin(t * 0.004 + x * 0.1) * 1.2;
      ctx.fillStyle = owner.color === "w" ? "rgba(255, 255, 255, 0.15)" : "rgba(50, 50, 80, 0.2)";
      ctx.beginPath();
      ctx.arc(wobble, wobble, 14, 0, Math.PI * 2);
      ctx.fill();
    `,
  },

  projectiles: {
    // Generic fireball projectile.
    fireball: `
      const tail = 12;
      const dx = p.toX - p.fromX;
      const dy = p.toY - p.fromY;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      for (let i = 0; i < 6; i++) {
        const back = (i / 6) * 0.18;
        const tx = p.x - (dx / len) * tail * back * len * 0.06;
        const ty = p.y - (dy / len) * tail * back * len * 0.06;
        ctx.fillStyle = "rgba(255, " + (180 - i * 20) + ", 0, " + (0.8 - back * 3) + ")";
        ctx.beginPath();
        ctx.arc(tx, ty, 6 - i * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    `,
  },

  overlays: [
    // A subtle vignette around the board edges.
    `
      const g = ctx.createRadialGradient(
        scene.width / 2, scene.height / 2, scene.width * 0.35,
        scene.width / 2, scene.height / 2, scene.width * 0.7,
      );
      g.addColorStop(0, "rgba(0, 0, 0, 0)");
      g.addColorStop(1, "rgba(0, 0, 0, 0.18)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, scene.width, scene.height);
    `,
  ],

  brains: {},
};
