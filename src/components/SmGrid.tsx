import { useMemo } from 'react';
import type { Gpu, GpuProcess } from '../lib/types';
import { percent } from '../lib/format';

/*
 * A cell per SM, divided by which process owns the SM time.
 *
 * Read this as a proportional view, not a hardware map. NVIDIA exposes no
 * per-SM telemetry through NVML or DCGM - only whole-GPU residency and a
 * per-process share of it - so cell #7 lighting up does not mean SM #7 is busy.
 * What the grid does show truthfully is how many SMs' worth of the machine is
 * in use, and whose work it is. The caption says so on screen; anything that
 * paints individual SMs from this data is inventing it.
 */

/* Fixed slot order, never cycled - a process keeps its colour as others come and go. */
const SERIES = [
  'var(--series-gpu)',
  'var(--series-cpu)',
  'var(--series-memory)',
  'var(--series-temp)',
];
const OTHER = 'var(--series-power)';
const MAX_NAMED = 4;

const CELL = 14;
const COLUMNS = 16;

interface Segment {
  key: string;
  label: string;
  color: string;
  cells: number;
  share: number;
}

function LegendItem({
  color,
  label,
  cells,
  smCount,
  hint,
  outlined = false,
}: {
  color: string;
  label: string;
  cells: number;
  smCount: number;
  hint: string;
  outlined?: boolean;
}) {
  return (
    <div className="flex items-center gap-2" title={hint}>
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
        style={{
          background: color,
          /* The idle swatch is barely distinguishable from the panel, so it
           * carries a hairline to stay findable in the legend. */
          boxShadow: outlined ? 'inset 0 0 0 1px var(--border-strong)' : undefined,
        }}
      />
      <dt className="text-[11px] text-ink-secondary">{label}</dt>
      <dd className="text-[11px] text-ink-muted tabular">
        <span className="font-medium text-ink">{cells}</span>
        {cells === 1 ? ' SM' : ' SMs'} · {Math.round((cells / smCount) * 100)}%
      </dd>
    </div>
  );
}

export function SmGrid({ gpu, processes }: { gpu: Gpu; processes: GpuProcess[] }) {
  const smCount = gpu.smCount;

  const { segments, activeCells } = useMemo(() => {
    if (!smCount) return { segments: [] as Segment[], activeCells: 0 };

    /* Total occupancy is the authority; per-process shares only divide it up. */
    const utilisation = Math.max(0, Math.min(100, gpu.utilization ?? 0));
    const active = Math.round((utilisation / 100) * smCount);

    const claimants = processes
      .filter((p) => (p.sm ?? 0) > 0)
      .sort((a, b) => (b.sm ?? 0) - (a.sm ?? 0));

    const claimed = claimants.reduce((sum, p) => sum + (p.sm ?? 0), 0);
    if (active === 0 || claimed === 0) {
      return {
        segments: active > 0 ? [{ key: 'busy', label: 'In use', color: SERIES[0]!, cells: active, share: utilisation }] : [],
        activeCells: active,
      };
    }

    const named = claimants.slice(0, MAX_NAMED);
    const rest = claimants.slice(MAX_NAMED);

    const rows = named.map((p) => ({
      key: String(p.pid),
      label: p.name,
      share: ((p.sm ?? 0) / claimed) * utilisation,
    }));

    if (rest.length > 0) {
      rows.push({
        key: 'other',
        label: `${rest.length} more`,
        share: (rest.reduce((sum, p) => sum + (p.sm ?? 0), 0) / claimed) * utilisation,
      });
    }

    /*
     * Largest-remainder allocation, so the coloured cells sum to exactly the
     * active count instead of drifting by a cell or two from rounding.
     */
    const exact = rows.map((r) => (r.share / utilisation) * active);
    const floors = exact.map(Math.floor);
    let remaining = active - floors.reduce((a, b) => a + b, 0);

    const order = exact
      .map((value, i) => ({ i, frac: value - Math.floor(value) }))
      .sort((a, b) => b.frac - a.frac);

    for (const { i } of order) {
      if (remaining <= 0) break;
      floors[i] = (floors[i] ?? 0) + 1;
      remaining -= 1;
    }

    return {
      segments: rows
        .map((r, i) => ({
          ...r,
          color: r.key === 'other' ? OTHER : SERIES[i % SERIES.length]!,
          cells: floors[i] ?? 0,
        }))
        .filter((r) => r.cells > 0),
      activeCells: active,
    };
  }, [gpu.utilization, processes, smCount]);

  /* Without a known SM count there is no honest number of cells to draw. */
  if (!smCount) return null;

  const cells: { color: string; label: string }[] = [];
  for (const segment of segments) {
    for (let i = 0; i < segment.cells; i += 1) {
      cells.push({ color: segment.color, label: segment.label });
    }
  }
  while (cells.length < smCount) cells.push({ color: 'var(--surface-2)', label: 'idle' });

  const idleCells = smCount - Math.min(activeCells, smCount);

  return (
    <div className="mt-5">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h4 className="text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
          SM occupancy
          <span className="ml-2 font-normal normal-case">each cell = 1 SM</span>
        </h4>
        <span className="text-[11px] text-ink-muted tabular">
          {activeCells} of {smCount} SMs equivalent · {percent(gpu.utilization)}
        </span>
      </div>

      {/* Fixed-size cells rather than fractional columns: the block is a compact
       * unit chart, not something that should stretch to the panel width. */}
      <div
        className="grid w-fit gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${COLUMNS}, ${CELL}px)` }}
        role="img"
        aria-label={`${activeCells} of ${smCount} streaming multiprocessors in use`}
      >
        {cells.slice(0, smCount).map((cell, i) => (
          <div
            key={i}
            className="rounded-[2px] transition-colors duration-500"
            style={{ background: cell.color, width: CELL, height: CELL }}
            title={cell.label}
          />
        ))}
      </div>

      {/* Every colour used in the grid is named here, idle included, so nothing
        * on screen is left to be inferred from the fill alone. */}
      <dl className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5">
        {segments.map((segment) => (
          <LegendItem
            key={segment.key}
            color={segment.color}
            label={segment.label}
            cells={segment.cells}
            smCount={smCount}
            hint="process using SM time"
          />
        ))}
        {idleCells > 0 && (
          <LegendItem
            color="var(--surface-2)"
            outlined
            label="Idle"
            cells={idleCells}
            smCount={smCount}
            hint="capacity not in use"
          />
        )}
      </dl>

      <p className="mt-2 text-[11px] text-ink-muted">
        Proportional view: NVIDIA reports SM time for the GPU as a whole and per process, not per
        SM. Cells show how many SMs' worth is busy and whose work it is — not which physical SM.
      </p>
    </div>
  );
}
