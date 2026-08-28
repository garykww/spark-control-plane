import { useMemo, useState } from 'react';
import { useSize } from '../../hooks/useSize';

interface Props {
  values: number[];
  timestamps?: number[];
  color: string;
  /* Fixes the y-domain (percentages want 0-100 so the trace does not rescale
   * every tick). Omit for unbounded measures like bytes/s or tokens/s. */
  max?: number;
  min?: number;
  height?: number;
  format?: (value: number) => string;
  label?: string;
}

const PAD = 2;

/*
 * Single-series trend line: 2px stroke, a soft area beneath it, and a hover
 * crosshair with a value tooltip. A single series needs no legend - the panel
 * title names it.
 */
export function Sparkline({
  values,
  timestamps,
  color,
  max,
  min,
  height = 44,
  format = (v) => v.toFixed(1),
  label,
}: Props) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = size.width;

  const geometry = useMemo(() => {
    if (width <= 0 || values.length === 0) return null;

    const lo = min ?? Math.min(...values, 0);
    /* A flat-zero series still needs a non-zero span or every point lands on the baseline. */
    const hi = max ?? Math.max(...values, lo + 1);
    const span = hi - lo || 1;

    const innerHeight = height - PAD * 2;
    const step = values.length > 1 ? width / (values.length - 1) : 0;

    const points = values.map((value, i) => ({
      x: values.length > 1 ? i * step : width / 2,
      y: PAD + innerHeight - ((value - lo) / span) * innerHeight,
      value,
    }));

    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${line} L${points.at(-1)!.x.toFixed(1)},${height} L${points[0]!.x.toFixed(1)},${height} Z`;

    return { points, line, area };
  }, [values, width, height, max, min]);

  const hovered = hoverIndex !== null ? geometry?.points[hoverIndex] : undefined;
  const gradientId = useMemo(() => `spark-${Math.random().toString(36).slice(2, 9)}`, []);

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {geometry && (
        <svg
          width={width}
          height={height}
          className="block overflow-visible"
          role="img"
          aria-label={label ? `${label} trend` : 'trend'}
          onMouseLeave={() => setHoverIndex(null)}
          onMouseMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - bounds.left) / (bounds.width || 1);
            const index = Math.round(ratio * (values.length - 1));
            setHoverIndex(Math.max(0, Math.min(values.length - 1, index)));
          }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.26" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          </defs>

          <path d={geometry.area} fill={`url(#${gradientId})`} />
          <path
            d={geometry.line}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {hovered && (
            <g>
              <line
                x1={hovered.x}
                y1={0}
                x2={hovered.x}
                y2={height}
                stroke="var(--axis)"
                strokeWidth={1}
              />
              {/* A 2px surface ring keeps the marker legible over the area fill. */}
              <circle cx={hovered.x} cy={hovered.y} r={4} fill={color} stroke="var(--surface-1)" strokeWidth={2} />
            </g>
          )}
        </svg>
      )}

      {hovered && (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-y-full rounded-md border border-hairline bg-surface-raised px-2 py-1 text-[11px] whitespace-nowrap shadow-lg tabular"
          style={{
            left: Math.min(Math.max(hovered.x, 28), Math.max(width - 28, 28)),
            transform: 'translate(-50%, -100%)',
          }}
        >
          <span className="font-medium text-ink">{format(hovered.value)}</span>
          {timestamps?.[hoverIndex!] !== undefined && (
            <span className="ml-1.5 text-ink-muted">
              {new Date(timestamps[hoverIndex!]!).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
