/**
 * RulePreview - compact preview card for an AI-generated /
 * preset rule diff.
 *
 * Lives in its own file so both ArenaPage (create panel) and
 * ArenaRoom (joiner's lobby panel + creator-recovery panel)
 * can render it without forming a circular import. Previously
 * exported from ArenaPage; ArenaRoom imported it from there
 * which closed the cycle ArenaPage -> ArenaRoom -> ArenaPage.
 *
 * @param {Object} props
 * @param {Object} props.description     Output of describeRules(resolved).
 * @param {string} [props.model]         Model identifier for the small subtitle pill.
 */
export default function RulePreview({ description, model }) {
  if (!description) return null;
  return (
    <div className="px-3 py-3 bg-surface-container border border-primary/20 space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <span className="font-headline text-[13px] font-bold text-primary">
          {description.name || "Custom rules"}
        </span>
        {model && (
          <span className="text-[9px] uppercase tracking-widest text-on-surface-variant/30">
            {model}
          </span>
        )}
      </div>
      {description.description && (
        <p className="text-[12px] text-on-surface-variant/65 leading-relaxed">
          {description.description}
        </p>
      )}
      {description.changes.length > 0 && (
        <ul className="text-[11px] text-on-surface-variant/65 leading-snug space-y-0.5">
          {description.changes.slice(0, 8).map((c, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-primary/60 shrink-0">&middot;</span>
              <span>{c.detail}</span>
            </li>
          ))}
          {description.changes.length > 8 && (
            <li className="text-on-surface-variant/35">
              &hellip; and {description.changes.length - 8} more
            </li>
          )}
        </ul>
      )}
      {description.changes.length === 0 && (
        <p className="text-[11px] text-on-surface-variant/40 italic">
          No changes from standard chess.
        </p>
      )}
    </div>
  );
}
