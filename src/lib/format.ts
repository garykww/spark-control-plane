/* Display helpers. Every one of these renders null as an em dash rather than 0,
 * so "the driver did not report this" never masquerades as a real reading. */

export const DASH = '—';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function bytes(value: number | null | undefined, digits?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  if (value < 1) return '0 B';

  const exponent = Math.min(UNITS.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** exponent;
  /* Big units earn a decimal; bytes and kilobytes read better as integers. */
  const precision = digits ?? (exponent >= 3 ? (scaled < 10 ? 2 : 1) : 0);
  return `${scaled.toFixed(precision)} ${UNITS[exponent]}`;
}

export function bytesPerSecond(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  if (value < 1) return '0 B/s';
  return `${bytes(value)}/s`;
}

export function percent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(digits)}%`;
}

export function celsius(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(0)}°C`;
}

export function watts(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(0)} W`;
}

export function megahertz(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} GHz`;
  return `${value.toFixed(0)} MHz`;
}

export function tokensPerSecond(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

/*
 * A cumulative token counter, which reaches millions on a server that has been
 * up a while. Compact rather than grouped ("7.98M", not "7,978,960") because it
 * shares a tile with a label and a share.
 */
export function tokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return value.toLocaleString();
}

/* Uptime as the two largest meaningful units: "41d 3h", "3h 12m", "47s". */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH;

  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}

export function relativeTime(timestamp: number | null | undefined): string {
  if (!timestamp) return DASH;
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds.toFixed(0)}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

/*
 * Threshold bands shared by meters and status dots. Returning a token name
 * rather than a colour keeps the mapping in CSS where the theme can swap it.
 */
export type Status = 'good' | 'warning' | 'serious' | 'critical' | 'neutral';

export function bandFor(value: number | null | undefined, warn: number, serious: number, critical: number): Status {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'neutral';
  if (value >= critical) return 'critical';
  if (value >= serious) return 'serious';
  if (value >= warn) return 'warning';
  return 'good';
}

export const utilisationBand = (v: number | null | undefined) => bandFor(v, 101, 101, 101);
export const capacityBand = (v: number | null | undefined) => bandFor(v, 75, 88, 95);
export const temperatureBand = (v: number | null | undefined) => bandFor(v, 70, 82, 90);

export const STATUS_LABEL: Record<Status, string> = {
  good: 'Healthy',
  warning: 'Elevated',
  serious: 'High',
  critical: 'Critical',
  neutral: 'Unknown',
};

export const STATUS_VAR: Record<Status, string> = {
  good: 'var(--status-good)',
  warning: 'var(--status-warning)',
  serious: 'var(--status-serious)',
  critical: 'var(--status-critical)',
  neutral: 'var(--ink-muted)',
};
