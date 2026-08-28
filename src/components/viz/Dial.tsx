interface Props {
  value: number | null;
  max?: number;
  color: string;
  size?: number;
  thickness?: number;
  /* The hero figure and its unit, drawn inside the arc. */
  readout: string;
  caption?: string;
}

const SWEEP = 260; /* degrees of arc; the 100deg gap sits at the bottom */
const START = 90 + (360 - SWEEP) / 2;

const polar = (cx: number, cy: number, r: number, degrees: number) => {
  const radians = (degrees * Math.PI) / 180;
  return { x: cx + r * Math.cos(radians), y: cy + r * Math.sin(radians) };
};

function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number) {
  const start = polar(cx, cy, r, fromDeg);
  const end = polar(cx, cy, r, toDeg);
  const largeArc = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  return `M${start.x.toFixed(2)},${start.y.toFixed(2)} A${r},${r} 0 ${largeArc} 1 ${end.x.toFixed(2)},${end.y.toFixed(2)}`;
}

/*
 * Radial magnitude gauge for the one headline number on a node card. The figure
 * is always printed in the middle, so the arc is reinforcement rather than the
 * only way to read the value.
 */
export function Dial({ value, max = 100, color, size = 132, thickness = 9, readout, caption }: Props) {
  const ratio = value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(1, value / max));
  const centre = size / 2;
  const radius = centre - thickness / 2 - 1;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} role="img" aria-label={caption ? `${caption}: ${readout}` : readout}>
        <path
          d={arcPath(centre, centre, radius, START, START + SWEEP)}
          fill="none"
          stroke="var(--surface-2)"
          strokeWidth={thickness}
          strokeLinecap="round"
        />
        {ratio > 0 && (
          <path
            d={arcPath(centre, centre, radius, START, START + SWEEP * ratio)}
            fill="none"
            stroke={color}
            strokeWidth={thickness}
            strokeLinecap="round"
            style={{ transition: 'd 400ms ease-out' }}
          />
        )}
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[28px] leading-none font-semibold text-ink">{readout}</span>
        {caption && <span className="mt-1.5 text-[11px] tracking-wide text-ink-muted uppercase">{caption}</span>}
      </div>
    </div>
  );
}
