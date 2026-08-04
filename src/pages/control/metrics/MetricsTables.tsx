import { Card } from '@/components/ui/Card';
import { Pagination } from '@/components/ui/Pagination';
import type { QueueSummaryFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import type { useThroughputSeries } from '@/lib/useThroughputSeries';

const OPS = ['push', 'pull', 'ack'] as const;
const P99_WARN_MS = 100;

export function OperationLatency({
  latency,
}: {
  latency: NonNullable<ReturnType<typeof useThroughputSeries>['latest']>['latency'] | undefined;
}) {
  return (
    <Card className="mb-6" padded={false}>
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-base font-semibold text-fg">Operation Latency</h2>
        <p className="text-xs text-faint">
          TCP round-trip per operation (p50 / p95 / p99, milliseconds)
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
              <th className="px-5 py-3 font-medium">Operation</th>
              <th className="px-5 py-3 text-right font-medium">Avg</th>
              <th className="px-5 py-3 text-right font-medium">p50</th>
              <th className="px-5 py-3 text-right font-medium">p95</th>
              <th className="px-5 py-3 text-right font-medium">p99</th>
            </tr>
          </thead>
          <tbody>
            {OPS.map((operation) => {
              const percentile = latency?.percentiles?.[operation];
              const average = latency?.averages?.[`${operation}Ms`];
              return (
                <tr key={operation} className="border-b border-line last:border-0">
                  <td className="px-5 py-3 font-medium capitalize text-fg">{operation}</td>
                  <td className="px-5 py-3 text-right tnum text-muted">{formatMs(average)}</td>
                  <td className="px-5 py-3 text-right tnum text-muted">
                    {formatMs(percentile?.p50)}
                  </td>
                  <td className="px-5 py-3 text-right tnum text-muted">
                    {formatMs(percentile?.p95)}
                  </td>
                  <td
                    className={cn(
                      'px-5 py-3 text-right tnum',
                      (percentile?.p99 ?? 0) > P99_WARN_MS ? 'text-warning' : 'text-muted'
                    )}
                  >
                    {formatMs(percentile?.p99)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function PerQueueMetrics({
  rows,
  total,
  page,
  pageSize,
  onPage,
  empty,
}: {
  rows: QueueSummaryFull[];
  total: number;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  empty: string;
}) {
  return (
    <Card padded={false}>
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-base font-semibold text-fg">Per-Queue Metrics</h2>
        <p className="text-xs text-faint">Job counts breakdown by queue</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
              <th className="px-5 py-3 font-medium">Queue</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 text-right font-medium">Waiting</th>
              <th className="px-5 py-3 text-right font-medium">Prioritized</th>
              <th className="px-5 py-3 text-right font-medium">Active</th>
              <th className="px-5 py-3 text-right font-medium">Completed</th>
              <th className="px-5 py-3 text-right font-medium">Failed</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-5 py-12 text-center text-sm text-faint">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((queue) => (
                <tr
                  key={queue.name}
                  className="border-b border-line last:border-0 hover:bg-surface-2/40"
                >
                  <td className="px-5 py-3 font-mono text-xs text-accent">{queue.name}</td>
                  <td className="px-5 py-3">
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                        queue.paused
                          ? 'bg-orange-500/10 text-orange-400'
                          : 'bg-emerald-500/10 text-success'
                      )}
                    >
                      {queue.paused ? 'paused' : 'active'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right tnum text-warning">
                    {formatNumber(queue.counts.waiting)}
                  </td>
                  <td className="px-5 py-3 text-right tnum text-orange-400">
                    {formatNumber(queue.counts.prioritized)}
                  </td>
                  <td className="px-5 py-3 text-right tnum text-blue-400">
                    {formatNumber(queue.counts.active)}
                  </td>
                  <td className="px-5 py-3 text-right tnum text-success">
                    {formatNumber(queue.counts.completed)}
                  </td>
                  <td className="px-5 py-3 text-right tnum text-danger">
                    {formatNumber(queue.counts.failed)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="px-5 pb-4">
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={onPage}
          label="queues"
        />
      </div>
    </Card>
  );
}

function formatMs(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}ms`;
}
