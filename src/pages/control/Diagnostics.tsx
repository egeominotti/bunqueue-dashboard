import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { api } from '@/lib/api';
import { bq } from '@/lib/bq';
import { formatBytes, formatUptime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import {
  EndpointDiagnostics,
  type EndpointSnapshot,
  HeapPanel,
  Mini,
  PrometheusPanel,
  TotalsPanel,
} from './diagnostics/DiagnosticsPanels';
import { useDiagnosticActions } from './diagnostics/useDiagnosticActions';

type Health = Awaited<ReturnType<typeof bq.health>>;
type Storage = Awaited<ReturnType<typeof bq.storage>>;
type Stats = Awaited<ReturnType<typeof bq.stats>>;

async function capture<T>(request: Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await request, error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

type DiagnosticSnapshot = EndpointSnapshot & {
  health: Health | null;
  storage: Storage | null;
  stats: Stats | null;
  healthError: string | null;
  storageError: string | null;
  statsError: string | null;
};

export function Diagnostics() {
  const {
    data,
    error: pollError,
    loading,
    refetch,
  } = usePolledData(async () => {
    const [health, storage, stats, healthz, live, ready, metrics] = await Promise.all([
      capture(bq.health()),
      capture(bq.storage()),
      capture(bq.stats()),
      capture(api.healthz()),
      capture(api.live()),
      capture(api.ready()),
      capture(api.metrics()),
    ]);
    return {
      health: health.value,
      storage: storage.value,
      stats: stats.value,
      healthError: health.error,
      storageError: storage.error,
      statsError: stats.error,
      healthz: healthz.value,
      live: live.value,
      ready: ready.value,
      metrics: metrics.value,
      healthzError: healthz.error,
      liveError: live.error,
      readyError: ready.error,
      metricsError: metrics.error,
    } satisfies DiagnosticSnapshot;
  }, []);
  const { doGc, doPing, gcBusy, gcMsg, heap, heapBusy, loadHeap, ping } =
    useDiagnosticActions(refetch);

  if (loading && !data && !pollError) return <LoadingState label="Loading diagnostics…" />;

  const d: DiagnosticSnapshot = data ?? {
    health: null,
    storage: null,
    stats: null,
    healthError: null,
    storageError: null,
    statsError: null,
    healthz: null,
    live: null,
    ready: null,
    metrics: null,
    healthzError: null,
    liveError: null,
    readyError: null,
    metricsError: null,
  };
  const h = d.health as {
    ok?: boolean;
    status?: string;
    version?: string;
    uptime?: number;
    memory?: { heapUsed: number; heapTotal: number; rss: number };
    connections?: { tcp: number; ws: number; sse: number };
  } | null;
  const disk = d.storage?.data;
  const st = d.stats?.stats;
  const healthKnown = h != null;
  const diskKnown = disk != null;
  const healthy = healthKnown && h.ok === true;
  const hasPartialError =
    !!pollError ||
    !!d.healthError ||
    !!d.storageError ||
    !!d.statsError ||
    !!d.healthzError ||
    !!d.liveError ||
    !!d.readyError ||
    !!d.metricsError;

  return (
    <div>
      <PageHeader
        title="Diagnostics"
        description="Server health, storage, memory and connections."
        live={!!data && !hasPartialError}
      />
      {pollError && (
        <OfflineBanner
          message={`Diagnostics refresh failed — ${pollError.message}`}
          onRetry={refetch}
        />
      )}
      {d.healthError && (
        <OfflineBanner message={`Health unavailable — ${d.healthError}`} onRetry={refetch} />
      )}
      {d.storageError && (
        <OfflineBanner
          message={`Storage diagnostics unavailable — ${d.storageError}`}
          onRetry={refetch}
        />
      )}
      {d.statsError && (
        <OfflineBanner message={`Server totals unavailable — ${d.statsError}`} onRetry={refetch} />
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Status"
          value={healthKnown ? (h.status ?? (h.ok ? 'healthy' : 'degraded')) : 'Unavailable'}
          tone={healthy ? 'green' : 'red'}
          compact
        />
        <StatCard label="Version" value={h?.version ? `v${h.version}` : '—'} compact />
        <StatCard label="Uptime" value={formatUptime(h?.uptime)} compact />
        <StatCard
          label="Disk"
          value={!diskKnown ? 'Unavailable' : disk.diskFull ? 'Full' : 'Healthy'}
          tone={!diskKnown || disk.diskFull ? 'red' : 'green'}
          compact
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Connectivity"
            action={
              <Button size="sm" onClick={doPing}>
                Ping{ping ? ` · ${ping}` : ''}
              </Button>
            }
          />
          <dl className="divide-y divide-line text-sm">
            <Row
              k="WebSocket clients"
              v={h?.connections?.ws == null ? '—' : String(h.connections.ws)}
            />
            <Row
              k="SSE clients"
              v={h?.connections?.sse == null ? '—' : String(h.connections.sse)}
            />
            <Row
              k="Storage error"
              v={
                d.storageError
                  ? `unavailable — ${d.storageError}`
                  : disk?.error
                    ? String(disk.error)
                    : diskKnown
                      ? 'none'
                      : '—'
              }
            />
          </dl>
        </Card>

        <Card>
          <CardHeader
            title="Memory"
            action={
              <Button size="sm" disabled={gcBusy} onClick={doGc}>
                {gcBusy ? 'Compacting…' : 'Compact (GC)'}
              </Button>
            }
          />
          <div className="grid grid-cols-3 gap-4">
            <Mini
              k="Heap used"
              v={h?.memory ? formatBytes(h.memory.heapUsed * 1024 * 1024) : '—'}
            />
            <Mini
              k="Heap total"
              v={h?.memory ? formatBytes(h.memory.heapTotal * 1024 * 1024) : '—'}
            />
            <Mini k="RSS" v={h?.memory ? formatBytes(h.memory.rss * 1024 * 1024) : '—'} />
          </div>
          {gcMsg && <p className="mt-3 text-xs text-muted">{gcMsg}</p>}
        </Card>
      </div>

      <EndpointDiagnostics snapshot={d} />
      <HeapPanel heap={heap} busy={heapBusy} onLoad={loadHeap} />
      <PrometheusPanel />
      <TotalsPanel stats={st} />
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <dt className="text-muted">{k}</dt>
      <dd className="font-medium text-fg">{v}</dd>
    </div>
  );
}
