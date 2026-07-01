import { cn } from '@/lib/cn';

const STYLES: Record<string, string> = {
  completed: 'text-emerald-400 bg-emerald-500/10',
  active: 'text-blue-400 bg-blue-500/10',
  failed: 'text-red-400 bg-red-500/10',
  waiting: 'text-zinc-400 bg-zinc-500/10',
  prioritized: 'text-violet-400 bg-violet-500/10',
  delayed: 'text-amber-400 bg-amber-500/10',
  paused: 'text-orange-400 bg-orange-500/10',
  'waiting-children': 'text-cyan-400 bg-cyan-500/10',
  stalled: 'text-orange-400 bg-orange-500/10',
  default: 'text-zinc-400 bg-zinc-500/10',
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
