/**
 * ArenaAbilityPanel - in-match panel that lists the player's
 * abilities with live charges remaining and cooldown counters.
 *
 * Without this, players have no way to know:
 *   - that they HAVE abilities at all (only signal was prose
 *     description before the match started, then nothing)
 *   - how many charges they have left across the match
 *   - which pieces are currently on cooldown vs ready
 *   - what the ability actually does (effect summary +
 *     targeting shape)
 *
 * The panel renders one row per (color × piece-type × ability)
 * combination the variant declares. For each row:
 *   - Status pill: "READY" green / "COOLDOWN N" amber / "NO CHARGES" red
 *   - Caster pieces: e.g. "2 queens" with cooldown / charge breakdown
 *     per piece shown on hover
 *   - Effect summary line
 *   - Hover/click highlights all valid casters on the board
 *     via the onHighlight callback (lights them up so the user
 *     knows where to look)
 *
 * Pure presentation; the parent passes the resolved rules,
 * current crazyState sidecar, and which color is the player.
 *
 * @param {Object} props
 * @param {object} props.rules                  Resolved rules object.
 * @param {object|null} props.crazyState        Live crazy_state sidecar.
 * @param {("w"|"b")} props.playerColor         Which color the local player owns.
 * @param {object} props.position               Live Position (used to find caster squares).
 * @param {(squares: string[]) => void} [props.onHighlight]  Callback invoked when the user hovers/clicks an ability row; pass empty array to clear highlight.
 */
export default function ArenaAbilityPanel({
  rules,
  crazyState,
  playerColor,
  position,
  onHighlight,
  selectedAbility,
  onSelectAbility,
}) {
  if (!rules) return null;

  const rows = collectAbilityRows(rules, crazyState, playerColor, position);
  if (rows.length === 0) return null;

  return (
    <div className="px-3 py-3 bg-surface-container border border-amber-500/15 space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-headline text-[11px] font-bold uppercase tracking-widest text-amber-400">
          Your abilities
        </span>
        <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/30">
          {rows.length} ability{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="text-[10px] text-on-surface-variant/45 leading-snug">
        Switch the board to <span className="text-amber-300 font-bold">Ability</span> mode, then left-click a caster and a red target.
      </p>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <AbilityRow
            key={row.key}
            row={row}
            onHighlight={onHighlight}
            selected={selectedAbility?.abilityId === row.abilityId && selectedAbility?.pieceType === row.pieceType}
            onSelectAbility={onSelectAbility}
          />
        ))}
      </ul>
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────

function AbilityRow({ row, onHighlight, selected, onSelectAbility }) {
  const handleEnter = () => onHighlight && onHighlight(row.casterSquares);
  const handleLeave = () => onHighlight && onHighlight([]);

  // Status: READY if any caster has a usable instance; COOLDOWN if
  // all instances are cooling; NO CHARGES if all charges spent.
  const status = computeStatus(row);

  return (
    <li
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onTouchStart={handleEnter}
      onTouchEnd={handleLeave}
      className={`px-2 py-1.5 bg-surface-low border transition-colors ${
        selected ? "border-amber-400/70 ring-1 ring-amber-400/50" : "border-white/[0.04] hover:border-amber-500/30"
      }`}
    >
      <button
        type="button"
        disabled={status.kind !== "READY" || row.casterSquares.length === 0}
        onClick={() => onSelectAbility?.({
          abilityId: row.abilityId,
          pieceType: row.pieceType,
          label: row.label,
          casterSquares: row.casterSquares,
        })}
        className="w-full text-left disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <div className="flex items-baseline justify-between gap-2 mb-0.5">
          <span className="font-headline text-[12px] font-bold text-on-surface">
            {selected ? "Casting: " : ""}{row.label}
          </span>
          <StatusPill status={status} />
        </div>
      </button>
      <div className="text-[10px] text-on-surface-variant/55 leading-tight mb-1">
        On your{" "}
        <span className="font-mono text-on-surface-variant/80">
          {row.pieceName}
          {row.casterSquares.length > 1 ? `s (${row.casterSquares.length})` : ""}
        </span>
        {row.casterSquares.length > 0 && (
          <>
            {" "}at{" "}
            <span className="font-mono text-amber-400/80">
              {row.casterSquares.join(", ")}
            </span>
          </>
        )}
      </div>
      <div className="text-[10px] text-on-surface-variant/60 leading-snug">
        {row.effectSummary}. Targets {row.targetSummary}.
      </div>
      {row.gatingDetail && (
        <div className="text-[9px] text-on-surface-variant/40 leading-snug mt-0.5">
          {row.gatingDetail}
        </div>
      )}
    </li>
  );
}

function StatusPill({ status }) {
  const styles = {
    READY: "bg-emerald-500/15 text-emerald-300",
    COOLDOWN: "bg-amber-500/15 text-amber-300",
    NO_CHARGES: "bg-red-500/15 text-red-300",
  };
  const label = status.kind === "READY"
    ? "READY"
    : status.kind === "COOLDOWN"
      ? `${status.minPlies}p`
      : "OUT";
  return (
    <span className={`text-[9px] font-headline font-bold uppercase tracking-wide px-1.5 py-0.5 ${styles[status.kind]} tabular-nums`}>
      {label}
    </span>
  );
}

// ── Data assembly ──────────────────────────────────────────

/**
 * Walk the rules + crazyState + position and build one row per
 * unique ability the local player has access to. Combines
 * symmetric `pieces` abilities with byColor abilities scoped to
 * the player's color.
 */
function collectAbilityRows(rules, crazyState, playerColor, position) {
  const rows = [];
  const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

  // 1. Symmetric abilities (pieces.<pt>.abilities)
  for (const pt of ["p", "n", "b", "r", "q", "k"]) {
    const spec = rules.pieces?.[pt];
    if (!Array.isArray(spec?.abilities)) continue;
    for (const ab of spec.abilities) {
      rows.push(buildRow(rules, crazyState, position, playerColor, pt, ab, null));
    }
  }

  // 2. Asymmetric abilities scoped to the player's color
  const colorSpec = rules.byColor?.[playerColor] || {};
  for (const pt of ["p", "n", "b", "r", "q", "k"]) {
    const spec = colorSpec[pt];
    if (!Array.isArray(spec?.abilities)) continue;
    for (const ab of spec.abilities) {
      rows.push(buildRow(rules, crazyState, position, playerColor, pt, ab, playerColor));
    }
  }

  return rows.filter((r) => r.pieceName); // drop anything malformed
}

function buildRow(rules, crazyState, position, playerColor, pieceType, ab, scopedColor) {
  const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
  // Find every square the player owns this piece type on.
  const casterSquares = position
    ? position.findPieces(playerColor, pieceType)
    : [];

  // Per-caster gating snapshot from crazyState.
  const perCaster = casterSquares.map((sq) => {
    const charges = crazyState?.charges?.[sq]?.[ab.id];
    const cooldown = crazyState?.cooldowns?.[sq]?.[ab.id];
    const declaredCharges = ab.gating?.charges;
    const remainingCharges = Number.isFinite(charges)
      ? charges
      : (Number.isFinite(declaredCharges) ? declaredCharges : Infinity);
    const remainingCooldown = Number.isFinite(cooldown) ? cooldown : 0;
    return { sq, remainingCharges, remainingCooldown };
  });

  // Gating description from the static spec.
  const gatingDetail = describeGating(ab.gating);

  // Effect + target summary - reuse the same code path as the
  // lobby preview by importing here. Cheap, no circular dep.
  const effectSummary = describeEffect(ab.effect);
  const targetSummary = describeTarget(ab.target);

  return {
    key: `${scopedColor || "both"}.${pieceType}.${ab.id}`,
    label: ab.label || ab.id,
    pieceName: PIECE_NAMES[pieceType] || pieceType,
    pieceType,
    casterSquares,
    perCaster,
    effectSummary,
    targetSummary,
    gatingDetail,
    abilityId: ab.id,
  };
}

function computeStatus(row) {
  if (row.perCaster.length === 0) {
    return { kind: "NO_CHARGES" };
  }
  // READY if at least one caster has charges and is off cooldown.
  let minCooldown = Infinity;
  let anyHasCharges = false;
  for (const c of row.perCaster) {
    if (c.remainingCharges > 0) anyHasCharges = true;
    if (c.remainingCharges > 0 && c.remainingCooldown === 0) {
      return { kind: "READY" };
    }
    if (c.remainingCharges > 0 && c.remainingCooldown < minCooldown) {
      minCooldown = c.remainingCooldown;
    }
  }
  if (!anyHasCharges) return { kind: "NO_CHARGES" };
  return { kind: "COOLDOWN", minPlies: minCooldown };
}

// ── Mini description helpers (duplicated from rule-preview ──
// to keep this component free of the rule-preview import; the
// rule-preview module is a peer of the engine and importing it
// from a React component layer feels like the wrong direction).

function describeEffect(effect) {
  if (!effect || typeof effect !== "object") return "does nothing";
  switch (effect.kind) {
    case "destroy":
    case "capture": {
      const aoe = effect.aoe;
      if (aoe && Number.isFinite(aoe.radius) && aoe.radius > 0) {
        return `destroys + AOE ${aoe.radius}`;
      }
      return "destroys the target";
    }
    case "displace": return "pushes the target";
    case "relocate_self": return "teleports caster to target";
    case "spawn": return `summons a piece`;
    case "transform":
      return effect.color === "caster" ? "charms the target" : "transforms the target";
    case "mark": {
      const verbs = [];
      if (effect.skipTurns) verbs.push("freezes");
      if (effect.silenceAbilities) verbs.push("silences");
      if (effect.absorbCaptures) verbs.push("shields");
      if (effect.destroyOnExpire) verbs.push("dooms");
      const extra = verbs.length ? verbs.join("/") : "marks";
      return `${extra} the target${effect.duration ? ` for ${effect.duration}p` : ""}`;
    }
    case "aoe_wrap":
      return `${describeEffect(effect.inner)} (radius ${effect.radius || 1})`;
    default:
      return effect.kind || "?";
  }
}

function describeTarget(target) {
  if (!target || typeof target !== "object") return "anywhere";
  if (target.kind === "ranged" || target.kind === "leap") {
    if (target.requireEmpty) return "empty squares in range";
    if (target.requireEnemy === false) return "any square in range";
    return "enemy pieces in range";
  }
  if (target.kind === "slide") {
    return target.blockedByPieces === false
      ? "any direction (through pieces)"
      : "any direction (line of sight)";
  }
  return "?";
}

function describeGating(gating) {
  if (!gating) return null;
  const parts = [];
  if (Number.isFinite(gating.charges)) parts.push(`${gating.charges} per match`);
  if (Number.isFinite(gating.cooldownPlies)) parts.push(`${gating.cooldownPlies}-ply cooldown`);
  return parts.length ? parts.join(" · ") : null;
}
