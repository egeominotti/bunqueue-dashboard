import { Card, CardHeader } from '@/components/ui/Card';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { api } from '@/lib/api';
import { formatBytes, formatNumber } from '@/lib/format';
import type { OverviewResponse } from '@/lib/types';
import { usePolledData } from '@/lib/usePolledData';

const EMPTY: OverviewResponse = {
  ok: false,
  stats: {
    waiting: 0,
    active: 0,
    delayed: 0,
    completed: 0,
    dlq: 0,
    totalPushed: 0,
    totalPulled: 0,
    totalCompleted: 0,
    totalFailed: 0,
    uptime: 0,
  },
  throughput: { pushPerSec: 0, pullPerSec: 0, completePerSec: 0, failPerSec: 0 },
  latency: { averages: {}, percentiles: {} },
  memory: { heapUsed: 0, heapTotal: 0, rss: 0 },
  collections: {},
  workers: { total: 0, active: 0, list: [], truncated: false },
  crons: { total: 0, list: [], truncated: false },
  storage: {},
  timestamp: 0,
};

export function Metrics() {
  const { data, error, loading, refetch } = usePolledData(() => api.overview(), []);

  if (loading && !data && !error) return <LoadingState label="Loading metrics…" />;

  const { stats, throughput, latency, memory, collections } = data ?? EMPTY;

  // Percentiles are nested per-operation ({ push: { p50, p95, p99 }, … }).
  // Flatten to "push p95" → value so the flat KvList can render real numbers
  // instead of "[object Object]ms".
  const flatPercentiles: Record<string, number> = {};
  for (const [op, p] of Object.entries(latency.percentiles ?? {})) {
    if (p && typeof p === 'object') {
      flatPercentiles[`${op} p50`] = p.p50;
      flatPercentiles[`${op} p95`] = p.p95;
      flatPercentiles[`${op} p99`] = p.p99;
    }
  }

  return (
    <div>
      {error && <OfflineBanner onRetry={refetch} />}
      <PageHeader title="Metrics" description="Throughput, latency, and resource internals." live />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Pushed /s" value={throughput.pushPerSec.toFixed(1)} compact />
        <StatCard label="Pulled /s" value={throughput.pullPerSec.toFixed(1)} tone="blue" compact />
        <StatCard
          label="Completed /s"
          value={throughput.completePerSec.toFixed(1)}
          tone="green"
          compact
        />
        <StatCard label="Failed /s" value={throughput.failPerSec.toFixed(1)} tone="red" compact />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Totals" />
          <KvGrid
            rows={[
              ['Pushed', formatNumber(stats.totalPushed)],
              ['Pulled', formatNumber(stats.totalPulled)],
              ['Completed', formatNumber(stats.totalCompleted)],
              ['Failed', formatNumber(stats.totalFailed)],
            ]}
          />
        </Card>
        <Card>
          <CardHeader title="Memory" />
          <KvGrid
            rows={[
              ['Heap Used', formatBytes(memory.heapUsed * 1024 * 1024)],
              ['Heap Total', formatBytes(memory.heapTotal * 1024 * 1024)],
              ['RSS', formatBytes(memory.rss * 1024 * 1024)],
            ]}
          />
        </Card>
        <Card>
          <CardHeader title="Latency — percentiles (ms)" />
          <KvList record={flatPercentiles} suffix="ms" />
        </Card>
        <Card>
          <CardHeader title="Latency — averages (ms)" />
          <KvList record={latency.averages} suffix="ms" />
        </Card>
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader title="In-memory collections" />
          <KvList record={collections} />
        </Card>
      </div>
    </div>
  );
}

function KvGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {rows.map(([k, v]) => (
        <div key={k}>
          <div className="text-[11px] font-medium uppercase tracking-wider text-faint">{k}</div>
          <div className="mt-1 text-xl font-semibold tnum text-fg">{v}</div>
        </div>
      ))}
    </div>
  );
}

function KvList({ record, suffix }: { record: Record<string, number>; suffix?: string }) {
  const entries = Object.entries(record ?? {});
  if (entries.length === 0) return <p className="py-4 text-sm text-faint">No data.</p>;
  return (
    <dl className="divide-y divide-line">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between py-2 text-sm">
          <dt className="font-mono text-xs text-muted">{k}</dt>
          <dd className="tnum font-medium text-fg">
            {typeof v === 'number' ? formatNumber(Math.round(v * 100) / 100) : String(v)}
            {suffix && <span className="ml-1 text-xs text-faint">{suffix}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
