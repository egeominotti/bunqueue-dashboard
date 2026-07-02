import { cn } from '@/lib/cn';

// `text-success/warning/danger` flip with the theme (index.css); the other hues
// carry explicit `light:` overrides — the 400 shades fail contrast on white.
const STYLES: Record<string, string> = {
  completed: 'text-success bg-emerald-500/10',
  active: 'text-blue-400 light:text-blue-700 bg-blue-500/10',
  failed: 'text-danger bg-red-500/10',
  waiting: 'text-zinc-400 light:text-zinc-600 bg-zinc-500/10',
  prioritized: 'text-violet-400 light:text-violet-700 bg-violet-500/10',
  delayed: 'text-warning bg-amber-500/10',
  paused: 'text-orange-400 light:text-orange-700 bg-orange-500/10',
  'waiting-children': 'text-cyan-400 light:text-cyan-700 bg-cyan-500/10',
  stalled: 'text-orange-400 light:text-orange-700 bg-orange-500/10',
  // Timeline event names (JobTimeline) — distinct, not all-gray.
  enqueued: 'text-zinc-400 light:text-zinc-600 bg-zinc-500/10',
  started: 'text-blue-400 light:text-blue-700 bg-blue-500/10',
  finished: 'text-success bg-emerald-500/10',
  retry: 'text-warning bg-amber-500/10',
  cancelled: 'text-zinc-400 light:text-zinc-600 bg-zinc-500/10',
  default: 'text-zinc-400 light:text-zinc-600 bg-zinc-500/10',
};

export function StatusBadge({ status }: { status: string }) {
  const key = (status || '').toLowerCase();
  const cls = STYLES[key] ?? STYLES.default;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        cls
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {status || 'unknown'}
    </span>
  );
}

/** A small colored dot + label used in headers (e.g. "Active", "Live"). */
export function StatusDot({
  label,
  tone = 'green',
}: {
  label: string;
  tone?: 'green' | 'amber' | 'red' | 'zinc';
}) {
  const dot =
    tone === 'green'
      ? 'bg-emerald-400'
      : tone === 'amber'
        ? 'bg-amber-400'
        : tone === 'red'
          ? 'bg-red-400'
          : 'bg-zinc-400';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
      <span className={cn('size-1.5 rounded-full', dot)} />
      {label}
    </span>
  );
}
