import type { ReactNode } from 'react';
import { STATUS_VAR, type Status } from '../lib/format';

export function Card({
  title,
  accent,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  accent?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-hairline bg-surface-1 ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-2.5">
          <h3 className="flex items-center gap-2 text-[12px] font-semibold tracking-wide text-ink-secondary uppercase">
            {accent && <span className="h-2.5 w-2.5 rounded-full" style={{ background: accent }} />}
            {title}
          </h3>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/*
 * A single number that matters, with optional context beneath it. Used where a
 * chart would add nothing - a chart of one value is just a number with extra ink.
 */
export function StatTile({
  label,
  value,
  unit,
  sub,
  color,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] tracking-wide text-ink-muted uppercase">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-[22px] leading-none font-semibold" style={color ? { color } : undefined}>
          {value}
        </span>
        {unit && <span className="text-[12px] text-ink-muted">{unit}</span>}
      </div>
      {sub && <div className="mt-1 truncate text-[11px] text-ink-muted tabular">{sub}</div>}
    </div>
  );
}

/* Status is carried by an icon glyph plus a label, never by colour alone. */
const STATUS_GLYPH: Record<Status, string> = {
  good: '●',
  warning: '▲',
  serious: '▲',
  critical: '■',
  neutral: '○',
};

export function StatusDot({ status, label }: { status: Status; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]" title={label}>
      <span aria-hidden style={{ color: STATUS_VAR[status], fontSize: 9 }}>
        {STATUS_GLYPH[status]}
      </span>
      {label && <span className="text-ink-secondary">{label}</span>}
    </span>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | Status;
}) {
  const style =
    tone === 'neutral'
      ? { color: 'var(--ink-secondary)', borderColor: 'var(--border)' }
      : tone === 'accent'
        ? { color: 'var(--series-gpu)', borderColor: 'var(--series-gpu)' }
        : { color: STATUS_VAR[tone], borderColor: STATUS_VAR[tone] };

  return (
    <span
      className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
      style={style}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'ghost' | 'primary' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45';

  const variants = {
    ghost: 'border border-hairline text-ink-secondary hover:bg-surface-2 hover:text-ink',
    primary: 'text-white hover:opacity-90',
    danger: 'border text-[color:var(--status-critical)] hover:bg-surface-2',
  };

  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${variants[variant]}`}
      style={
        variant === 'primary'
          ? { background: 'var(--series-gpu)' }
          : variant === 'danger'
            ? { borderColor: 'var(--status-critical)' }
            : undefined
      }
    >
      {children}
    </button>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-hairline-strong px-6 py-16 text-center">
      <p className="text-[14px] font-medium text-ink">{title}</p>
      {hint && <p className="mt-1.5 max-w-md text-[12px] text-ink-secondary">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* Per-core utilisation. A bar per core reads faster than 20 numbers, and the
 * aggregate figure beside it carries the precise value. */
export function CoreGrid({ cores }: { cores: number[] }) {
  if (cores.length === 0) return null;

  return (
    <div className="flex items-stretch gap-[3px]" style={{ height: 34 }} aria-hidden>
      {cores.map((value, i) => {
        const filled = Math.max(3, Math.min(100, value));
        return (
          /* The track is a flex column so the fill grows from the baseline up.
           * A percentage margin would resolve against the bar's width, not its
           * height, and collapse every core to the same offset. */
          <div
            key={i}
            className="flex flex-1 flex-col justify-end overflow-hidden rounded-[2px] bg-surface-2"
            title={`core ${i}: ${value.toFixed(0)}%`}
          >
            <div
              className="w-full rounded-[2px] transition-[height] duration-500"
              style={{
                height: `${filled}%`,
                background: 'var(--series-cpu)',
                opacity: 0.45 + (Math.min(100, value) / 100) * 0.55,
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
