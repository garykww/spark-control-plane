import { STATUS_VAR, type Status } from '../../lib/format';

interface Props {
  value: number | null;
  /* Value is a percentage of this; defaults to a 0-100 scale. */
  max?: number;
  color?: string;
  status?: Status;
  /* Rendered at the right of the label row - always present, because several
   * series colours sit below 3:1 on the light surface and need visible relief. */
  readout: string;
  label?: string;
  sublabel?: string;
  height?: number;
}

/*
 * Horizontal magnitude bar. The fill is anchored to the baseline with a 4px
 * rounded data-end, and sits on a recessive track rather than a coloured one.
 */
export function Meter({
  value,
  max = 100,
  color,
  status,
  readout,
  label,
  sublabel,
  height = 8,
}: Props) {
  const ratio = value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(1, value / max));
  const fill = status ? STATUS_VAR[status] : (color ?? 'var(--series-gpu)');

  return (
    <div className="w-full">
      {(label || readout) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <span className="truncate text-[12px] text-ink-secondary">{label}</span>
          <span className="shrink-0 text-[12px] font-medium text-ink tabular">{readout}</span>
        </div>
      )}

      <div
        className="w-full overflow-hidden rounded-full bg-surface-2"
        style={{ height }}
        role="meter"
        aria-valuenow={value ?? undefined}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${ratio * 100}%`, background: fill, minWidth: ratio > 0 ? 4 : 0 }}
        />
      </div>

      {sublabel && <div className="mt-1 text-[11px] text-ink-muted tabular">{sublabel}</div>}
    </div>
  );
}
