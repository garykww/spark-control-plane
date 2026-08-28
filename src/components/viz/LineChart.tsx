import { useMemo, useState } from 'react';
import { useSize } from '../../hooks/useSize';

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

interface Props {
  series: Series[];
  timestamps: number[];
  height?: number;
  format: (value: number) => string;
  /* Forces the top of the y-domain (e.g. 100 for percentages). */
  max?: number;
  /* 1024 for byte scales so ticks land on whole MB/GB instead of 19, 38, 57. */
  base?: 10 | 1024;
}

const PAD = { top: 10, right: 8, bottom: 4, left: 52 };
const GRID_LINES = 4;

const STEPS = [1, 2, 2.5, 5, 10];

/*
 * Picks a y-domain whose gridlines land on round numbers *in the unit the
 * formatter will print*. A byte axis has to be rounded in multiples of 1024,
 * otherwise a decimal-rounded domain renders as 19 MB/s, 38 MB/s, 57 MB/s.
 */
function niceTop(peak: number, divisions: number, base: 10 | 1024) {
  if (!(peak > 0)) return base === 1024 ? 1024 : 1;

  const exponent = base === 1024 ? Math.max(0, Math.floor(Math.log(peak) / Math.log(1024))) : 0;
  const unit = 1024 ** exponent;

  const rawStep = peak / unit / divisions;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = (STEPS.find((candidate) => rawStep <= candidate * magnitude) ?? 10) * magnitude;

  return step * divisions * unit;
}

/*
 * Multi-series time chart with a shared crosshair. Both series are read against
 * one y-axis - a second scale would let any two measures be drawn as though
 * they were comparable, which is the fastest way to mislead with a chart.
 */
export function LineChart({ series, timestamps, height = 150, format, max, base = 10 }: Props) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = size.width;
  const plotWidth = Math.max(0, width - PAD.left - PAD.right);
  const plotHeight = Math.max(0, height - PAD.top - PAD.bottom);
  const length = Math.max(...series.map((s) => s.values.length), 0);

  const geometry = useMemo(() => {
    if (plotWidth <= 0 || length === 0) return null;

    const peak = Math.max(1, ...series.flatMap((s) => s.values));
    const top = max ?? niceTop(peak, GRID_LINES, base);

    const step = length > 1 ? plotWidth / (length - 1) : 0;
    const xAt = (i: number) => PAD.left + (length > 1 ? i * step : plotWidth / 2);
    const yAt = (value: number) => PAD.top + plotHeight - (Math.max(0, value) / top) * plotHeight;

    const paths = series.map((s) => ({
      ...s,
      d: s.values
        .map((value, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(value).toFixed(1)}`)
        .join(' '),
      last: s.values.at(-1) ?? 0,
    }));

    const ticks = Array.from({ length: GRID_LINES + 1 }, (_, i) => {
      const value = (top / GRID_LINES) * i;
      return { value, y: yAt(value) };
    });

    return { paths, ticks, xAt, yAt, top };
  }, [series, plotWidth, plotHeight, length, max, base]);

  return (
    <div className="w-full">
      {/* Legend is always present for two or more series - identity never rests on colour alone. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
            {s.label}
            <span className="font-medium text-ink tabular">{format(s.values.at(-1) ?? 0)}</span>
          </span>
        ))}
      </div>

      <div ref={ref} className="relative w-full" style={{ height }}>
        {geometry && (
          <svg
            width={width}
            height={height}
            className="block"
            onMouseLeave={() => setHoverIndex(null)}
            onMouseMove={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const ratio = (event.clientX - bounds.left - PAD.left) / (plotWidth || 1);
              const index = Math.round(ratio * (length - 1));
              setHoverIndex(Math.max(0, Math.min(length - 1, index)));
            }}
          >
            {geometry.ticks.map((tick) => (
              <g key={tick.value}>
                <line
                  x1={PAD.left}
                  y1={tick.y}
                  x2={width - PAD.right}
                  y2={tick.y}
                  stroke="var(--grid)"
                  strokeWidth={1}
                />
                <text
                  x={PAD.left - 8}
                  y={tick.y + 3}
                  textAnchor="end"
                  className="tabular"
                  fill="var(--ink-muted)"
                  fontSize={10}
                >
                  {format(tick.value)}
                </text>
              </g>
            ))}

            {geometry.paths.map((s) => (
              <path
                key={s.key}
                d={s.d}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}

            {hoverIndex !== null && (
              <g>
                <line
                  x1={geometry.xAt(hoverIndex)}
                  y1={PAD.top}
                  x2={geometry.xAt(hoverIndex)}
                  y2={PAD.top + plotHeight}
                  stroke="var(--axis)"
                  strokeWidth={1}
                />
                {series.map((s) => {
                  const value = s.values[hoverIndex];
                  if (value === undefined) return null;
                  return (
                    <circle
                      key={s.key}
                      cx={geometry.xAt(hoverIndex)}
                      cy={geometry.yAt(value)}
                      r={4}
                      fill={s.color}
                      stroke="var(--surface-1)"
                      strokeWidth={2}
                    />
                  );
                })}
              </g>
            )}
          </svg>
        )}

        {hoverIndex !== null && geometry && (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-md border border-hairline bg-surface-raised px-2.5 py-1.5 text-[11px] whitespace-nowrap shadow-lg"
            style={{
              left: Math.min(Math.max(geometry.xAt(hoverIndex), 70), Math.max(width - 70, 70)),
              transform: 'translateX(-50%)',
            }}
          >
            {timestamps[hoverIndex] !== undefined && (
              <div className="mb-1 text-ink-muted tabular">
                {new Date(timestamps[hoverIndex]!).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </div>
            )}
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                <span className="text-ink-secondary">{s.label}</span>
                <span className="ml-auto pl-3 font-medium text-ink tabular">
                  {format(s.values[hoverIndex] ?? 0)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
