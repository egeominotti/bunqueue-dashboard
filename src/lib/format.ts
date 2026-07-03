/** Formatting helpers shared across the dashboard. */

// Thousands separated by "." to match the reference dashboard (e.g. 14.608).
const numberFmt = new Intl.NumberFormat('de-DE');
const dateFmt = new Intl.DateTimeFormat('it-IT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** 14608 → "14.608". Non-finite → "0". */
export function formatNumber(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '0';
  return numberFmt.format(n);
}

/** 0.0123 (fraction) → "1.23%". `digits` controls decimals. */
export function formatPercent(fraction: number | undefined | null, digits = 2): string {
  if (fraction == null || !Number.isFinite(fraction)) return '0%';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/**
 * Error rate from completed/failed totals, as a fraction (0..1) — or `null`
 * when nothing has been processed yet. Callers render null as "—": deriving
 * "0% errors / 100% success" from zero data is a claim, not a measurement.
 */
export function errorRate(completed: number, failed: number): number | null {
  const total = completed + failed;
  return total > 0 ? failed / total : null;
}

/** "14/03/2026, 17:31:25" */
export function formatDateTime(ts: number | undefined | null): string {
  if (ts == null || !Number.isFinite(ts)) return '—';
  // Finite numbers beyond the valid Date range (±8.64e15) produce an Invalid
  // Date, and Intl throws a RangeError on it — guard so one absurd timestamp
  // (e.g. a cron with a huge repeat interval) can't crash a whole page.
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return dateFmt.format(d);
}

/** Compact "time ago": 0s, 45s, 26m, 3h, 2d ago. */
export function formatRelativeTime(ts: number | undefined | null, now = Date.now()): string {
  if (ts == null || !Number.isFinite(ts)) return '—';
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Duration in ms → "820ms", "1.4s", "2m 3s", or "—" when unknown. */
export function formatDuration(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  // toFixed(1) renders anything ≥ 59.95 as "60.0" — hand those to the minutes branch.
  if (s < 59.95) return `${s.toFixed(1)}s`;
  // Round once and derive both parts from the same total, so the remainder
  // can never round up to 60 ("1m 60s").
  const totalS = Math.round(s);
  const m = Math.floor(totalS / 60);
  return `${m}m ${totalS % 60}s`;
}

/** Compute a job's duration from its timestamps, if both are present. */
export function jobDuration(processedOn?: number, finishedOn?: number): number | undefined {
  if (processedOn == null || finishedOn == null) return undefined;
  const d = finishedOn - processedOn;
  return d >= 0 ? d : undefined;
}

/** Uptime seconds → "3d 4h 12m". */
export function formatUptime(seconds: number | undefined | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

/** Compact count for tight readouts: 1200 → "1.2K", 3400000 → "3.4M". */
export function formatCompact(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Latency in ms → "3.4ms", "42ms", "1.25s" (sub-10ms keeps a decimal). */
export function formatMs(v: number | undefined | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
  return `${v.toFixed(v < 10 ? 1 : 0)}ms`;
}

// ESC-led CSI sequences (colors, cursor moves) plus stray single-char
// escapes. The bunqueue banner logs bold/dim color codes; rendered as plain
// text they read as "[1m…[0m" noise, so log viewers strip them before
// display/copy/download. Only sequences introduced by the real ESC byte
// (\u001b) match — legitimate bracketed text like "[Stats]" is untouched.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes requires the ESC control character
const ANSI_RE = /(?:\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\^_])/g;

/** Strip ANSI escape sequences from a log line. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Bytes → "1.4 GB". */
export function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
