import { Card, CardHeader } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import { formatCompact, formatNumber, formatPercent, formatUptime } from '@/lib/format';
import type { useThroughputSeries } from '@/lib/useThroughputSeries';

export function MetricsStatusPanels({
  rate,
  stats,
}: {
  rate: number | null;
  stats: NonNullable<ReturnType<typeof useThroughputSeries>['latest']>['stats'] | undefined;
}) {
  return (
    <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Error Rate" />
        <p className="-mt-3 mb-4 text-xs text-faint">Failed as percentage of total processed</p>
        <div className="flex items-center justify-around">
          <Rate
            value={rate == null ? '—' : formatPercent(rate)}
            label="error rate"
            danger={rate != null && rate > 0.05}
          />
          <Rate
            value={rate == null ? '—' : formatPercent(1 - rate)}
            label="success rate"
            success={rate != null}
          />
        </div>
        {rate == null ? (
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-surface-2" />
        ) : (
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-red-500/40">
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: `${(1 - rate) * 100}%` }}
            />
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Server Overview" />
        <p className="-mt-3 mb-4 text-xs text-faint">Current server-wide statistics</p>
        <dl className="divide-y divide-line text-sm">
          <ServerRow
            color="bg-blue-400"
            label="Standard waiting"
            value={stats ? formatNumber(stats.waiting) : '—'}
          />
          <ServerRow
            color="bg-accent"
            label="Processing"
            value={stats ? formatNumber(stats.active) : '—'}
          />
          <ServerRow
            color="bg-amber-400"
            label="Delayed"
            value={stats ? formatNumber(stats.delayed) : '—'}
          />
          <ServerRow
            color="bg-red-400"
            label="Dead Letter"
            value={stats ? formatNumber(stats.dlq) : '—'}
          />
          <ServerRow
            color="bg-zinc-500"
            label="Pushed (since restart)"
            value={stats ? formatCompact(stats.totalPushed) : '—'}
          />
          <ServerRow
            color="bg-zinc-500"
            label="Pulled (since restart)"
            value={stats ? formatCompact(stats.totalPulled) : '—'}
          />
          <ServerRow
            color="bg-emerald-400"
            label="Uptime"
            value={stats ? formatUptime(stats.uptime / 1000) : '—'}
          />
        </dl>
      </Card>
    </div>
  );
}

function Rate({
  value,
  label,
  danger,
  success,
}: {
  value: string;
  label: string;
  danger?: boolean;
  success?: boolean;
}) {
  return (
    <div className="text-center">
      <div
        className={cn(
          'text-3xl font-bold tnum',
          danger ? 'text-danger' : success ? 'text-success' : 'text-fg'
        )}
      >
        {value}
      </div>
      <div className="text-xs text-faint">{label}</div>
    </div>
  );
}

function ServerRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <dt className="flex items-center gap-2 text-muted">
        <span className={cn('size-2 rounded-full', color)} />
        {label}
      </dt>
      <dd className="font-semibold tnum text-fg">{value}</dd>
    </div>
  );
}
