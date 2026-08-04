import { useMemo, useState } from 'react';
import { OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { bq } from '@/lib/bq';
import { errorRate, formatCompact, formatNumber } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { useThroughputSeries } from '@/lib/useThroughputSeries';
import { MetricsStatusPanels } from './metrics/MetricsStatusPanels';
import { OperationLatency, PerQueueMetrics } from './metrics/MetricsTables';
import { ThroughputCharts } from './metrics/ThroughputCharts';

const PAGE_SIZE = 15;

export function MetricsPro() {
  const series = useThroughputSeries(60);
  const [page, setPage] = useState(0);
  const { data, error, loading, refetch } = usePolledData(
    async () => ({ details: await bq.queuesSummary() }),
    []
  );
  const details = data?.details ?? [];
  const pageCount = Math.max(1, Math.ceil(details.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => details.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [details, safePage]
  );
  const failedTotal = useMemo(
    () => (data ? details.reduce((total, queue) => total + (queue.counts?.failed ?? 0), 0) : null),
    [data, details]
  );
  const stats = series.latest?.stats;
  const throughput = series.latest?.throughput;
  const latency = series.latest?.latency;
  const rate = stats && failedTotal != null ? errorRate(stats.completed, failedTotal) : null;
  const summaryLoading = loading && !data && !error;
  const live = !!series.latest && !series.error && !!data && !error;
  const empty =
    error && !data
      ? `Queue metrics unavailable — ${error.message}`
      : summaryLoading
        ? 'Loading queue metrics…'
        : 'No queues yet.';
  return (
    <div>
      <PageHeader
        title="Metrics"
        description="Real-time performance telemetry for your queues."
        live={live}
      />
      {error && (
        <OfflineBanner message={`Queue metrics unavailable — ${error.message}`} onRetry={refetch} />
      )}
      {series.error && (
        <OfflineBanner
          message={`Live telemetry unavailable — ${series.error.message}. Reconnecting automatically.`}
        />
      )}
      {summaryLoading && (
        <div role="status" className="mb-4 text-sm text-muted">
          Loading per-queue metrics…
        </div>
      )}
      {!series.latest && !series.error && (
        <div role="status" className="mb-4 text-sm text-muted">
          Connecting live telemetry…
        </div>
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Total Completed"
          value={stats ? formatCompact(stats.completed) : '—'}
          tone="green"
          hint="recorded jobs"
        />
        <StatCard
          label="Total Failed"
          value={failedTotal == null ? '—' : formatNumber(failedTotal)}
          tone={failedTotal ? 'red' : 'default'}
          hint="recorded jobs"
        />
        <StatCard
          label="Push/sec"
          value={throughput ? throughput.pushPerSec.toFixed(1) : '—'}
          tone="accent"
          hint="jobs/sec"
        />
        <StatCard
          label="Pull/sec"
          value={throughput ? throughput.pullPerSec.toFixed(1) : '—'}
          tone="accent"
          hint="jobs/sec"
        />
      </div>
      <ThroughputCharts series={series} />
      <MetricsStatusPanels rate={rate} stats={stats} />
      <OperationLatency latency={latency} />
      <PerQueueMetrics
        rows={pageRows}
        total={details.length}
        page={safePage}
        pageSize={PAGE_SIZE}
        onPage={setPage}
        empty={empty}
      />
    </div>
  );
}
