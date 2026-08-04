import { AreaChart } from '@/components/ui/AreaChart';
import { Card } from '@/components/ui/Card';
import { EmptyState, LoadingState } from '@/components/ui/feedback';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { depthTrend, type useThroughputSeries } from '@/lib/useThroughputSeries';

const X_LABELS = ['-60s', '-45s', '-30s', '-15s', 'now'];

export function ThroughputCharts({ series }: { series: ReturnType<typeof useThroughputSeries> }) {
  const throughput = series.latest?.throughput;
  const trend = depthTrend(series.depth);
  const depthNow = series.depth.length ? series.depth[series.depth.length - 1] : null;
  const fallback = (title: string) =>
    series.error ? (
      <EmptyState title={`${title} unavailable`} hint={series.error.message} />
    ) : (
      <LoadingState label={`Connecting ${title.toLowerCase()}…`} />
    );
  return (
    <>
      <Card className="mb-6">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-fg">Live Throughput</h2>
            <p className="text-xs text-faint">Real-time jobs per second (rolling 60s window)</p>
          </div>
          {throughput && (
            <div className="flex flex-wrap items-center gap-4 font-mono text-[11px] text-faint">
              <Legend color="#ec4899" label="Pushed" value={throughput.pushPerSec} />
              <Legend color="#34d399" label="Completed" value={throughput.completePerSec} />
              <Legend color="#f87171" label="Failed" value={throughput.failPerSec} />
            </div>
          )}
        </div>
        {!series.latest ? (
          fallback('Live throughput')
        ) : (
          <AreaChart
            xLabels={X_LABELS}
            series={[
              { label: 'Pushed', color: '#ec4899', points: series.push, area: true },
              { label: 'Completed', color: '#34d399', points: series.complete },
              { label: 'Failed', color: '#f87171', points: series.fail },
            ]}
          />
        )}
      </Card>
      <Card className="mb-6">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-fg">Queue Depth</h2>
            <p className="text-xs text-faint">
              All non-terminal jobs over time (waiting + prioritized + active + delayed +
              waiting-children). The trend says whether you're draining or falling behind.
            </p>
          </div>
          <div className="text-right">
            <div className="tnum text-2xl font-bold text-fg">
              {depthNow == null ? '—' : formatNumber(depthNow)}
            </div>
            <div
              className={cn(
                'text-xs font-medium',
                trend.label === 'draining'
                  ? 'text-success'
                  : trend.label === 'accumulating'
                    ? 'text-danger'
                    : 'text-faint'
              )}
            >
              {depthNow == null
                ? 'unavailable'
                : trend.label === 'steady'
                  ? 'steady'
                  : `${trend.slope > 0 ? '+' : ''}${trend.slope.toFixed(1)}/s · ${trend.label}`}
            </div>
          </div>
        </div>
        {!series.latest ? (
          fallback('Queue depth')
        ) : (
          <AreaChart
            xLabels={X_LABELS}
            ariaLabel="queue depth chart"
            series={[
              {
                label: 'Depth',
                color: trend.draining ? '#34d399' : '#f59e0b',
                points: series.depth,
                area: true,
              },
            ]}
          />
        )}
      </Card>
    </>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2 rounded-full" style={{ background: color }} />
      {label} <span className="text-fg">{value.toFixed(1)}/s</span>
    </span>
  );
}
