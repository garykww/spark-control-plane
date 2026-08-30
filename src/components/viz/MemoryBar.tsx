import { bytes } from '../../lib/format';

export interface MemorySegment {
  key: string;
  label: string;
  bytes: number;
  color: string;
  /* Same entity as the segment before it, in a different state. Drawn as a
   * hatch so the distinction survives greyscale and colour-blindness rather
   * than resting on a lighter shade. */
  hatched?: boolean;
}

interface Props {
  /* The whole the segments are parts of - the machine's memory, not a sum. */
  total: number;
  segments: MemorySegment[];
  height?: number;
  /* Rendered after the legend; used to explain an over-subscribed bar. */
  footnote?: string;
}

const fillFor = (segment: MemorySegment) =>
  segment.hatched
    ? `repeating-linear-gradient(115deg, ${segment.color} 0 2px, transparent 2px 5px)`
    : segment.color;

/*
 * One bar, one fixed whole: how the machine's memory is spoken for.
 *
 * A stacked bar rather than a chart, because the question is part-to-whole of a
 * single total. Segments are separated by a 2px gap of the surface underneath
 * so adjacent fills never touch, and every segment is repeated in the legend
 * with its own value - the fills sit below 3:1 against a light surface, so the
 * numbers have to be readable without relying on the colour to carry them.
 */
export function MemoryBar({ total, segments, height = 14, footnote }: Props) {
  const visible = segments.filter((segment) => segment.bytes > 0);

  /*
   * A plan can ask for more than the machine has. The bar still has to end at
   * the machine's edge, so widths are clamped against the running total and
   * the shortfall is named in the footnote instead of drawn off the end.
   */
  let used = 0;
  const drawn = visible.map((segment) => {
    const room = Math.max(0, total - used);
    const width = Math.min(segment.bytes, room);
    used += width;
    return { ...segment, width: total > 0 ? (width / total) * 100 : 0 };
  });

  return (
    <div className="w-full">
      <div
        className="flex w-full gap-[2px] overflow-hidden rounded-full bg-surface-2"
        style={{ height }}
        role="img"
        aria-label={`${bytes(total)} total: ${visible
          .map((segment) => `${segment.label} ${bytes(segment.bytes)}`)
          .join(', ')}`}
      >
        {drawn.map((segment) => (
          <div
            key={segment.key}
            className="h-full rounded-[3px] transition-[width] duration-500 ease-out"
            style={{
              width: `${segment.width}%`,
              background: fillFor(segment),
              opacity: segment.hatched ? 0.65 : 1,
            }}
            title={`${segment.label}: ${bytes(segment.bytes)}`}
          />
        ))}
      </div>

      {/* Always present: two or more fills means identity can never rest on
          colour, and these fills need visible labels for contrast anyway. */}
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {visible.map((segment) => (
          <li key={segment.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-2 w-3 shrink-0 rounded-[2px]"
              style={{ background: fillFor(segment), opacity: segment.hatched ? 0.65 : 1 }}
            />
            <span className="text-ink-secondary">{segment.label}</span>
            <span className="font-medium text-ink tabular">{bytes(segment.bytes)}</span>
          </li>
        ))}
      </ul>

      {footnote && <p className="mt-1.5 text-[11px] text-ink-muted">{footnote}</p>}
    </div>
  );
}
