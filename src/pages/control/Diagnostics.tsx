import { useRef, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { bq } from '@/lib/bq';
import { formatBytes, formatNumber, formatUptime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';

type HeapStats = Awaited<ReturnType<typeof bq.heapStats>>;
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

type DiagnosticSnapshot = {
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
    const [health, storage, stats] = await Promise.all([
      capture(bq.health()),
      capture(bq.storage()),
      capture(bq.stats()),
    ]);
    return {
      health: health.value,
      storage: storage.value,
      stats: stats.value,
      healthError: health.error,
      storageError: storage.error,
      statsError: stats.error,
    } satisfies DiagnosticSnapshot;
  }, []);

  const [ping, setPing] = useState<string | null>(null);
  // Sequence guard (last-to-start wins): the Ping button isn't gated while a
  // probe runs, and a slow earlier probe resolving last would overwrite the
  // newer, faster reading it superseded.
  const pingGen = useRef(0);
  const doPing = async () => {
    const my = ++pingGen.current;
    setPing('…');
    const t0 = performance.now();
    try {
      await bq.ping();
      if (my === pingGen.current) setPing(`${Math.round(performance.now() - t0)} ms`);
    } catch {
      if (my === pingGen.current) setPing('unreachable');
    }
  };

  const [gcBusy, setGcBusy] = useState(false);
  const [gcMsg, setGcMsg] = useState<string | null>(null);
  const doGc = async () => {
    setGcBusy(true);
    setGcMsg(null);
    try {
      const r = await bq.gc();
      const freed = r.before.rss - r.after.rss;
      const text =
        freed > 0
          ? `Freed ${freed} MB (RSS ${r.before.rss}→${r.after.rss})`
          : 'No memory reclaimed';
      setGcMsg(text);
      toast.success('Memory compacted', text);
      refetch();
    } catch (e) {
      toast.error('GC failed', (e as Error).message);
      setGcMsg((e as Error).message);
    } finally {
      setGcBusy(false);
    }
  };

  const [heap, setHeap] = useState<HeapStats | null>(null);
  const [heapBusy, setHeapBusy] = useState(false);
  const loadHeap = async () => {
    setHeapBusy(true);
    try {
      setHeap(await bq.heapStats());
    } catch (e) {
      toast.error('Heap stats failed', (e as Error).message);
    } finally {
      setHeapBusy(false);
    }
  };

  if (loading && !data && !pollError) return <LoadingState label="Loading diagnostics…" />;

  const d: DiagnosticSnapshot = data ?? {
    health: null,
    storage: null,
    stats: null,
    healthError: null,
    storageError: null,
    statsError: null,
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
  const hasPartialError = !!pollError || !!d.healthError || !!d.storageError || !!d.statsError;

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

      <Card className="mt-6">
        <CardHeader
          title="Heap statistics"
          action={
            <Button size="sm" disabled={heapBusy} onClick={loadHeap}>
              {heapBusy ? 'Loading…' : heap ? 'Refresh' : 'Load'}
            </Button>
          }
        />
        {!heap ? (
          <p className="text-sm text-muted">
            On-demand <code className="font-mono text-xs">bun:jsc</code> heap breakdown (forces a GC
            first). Use it to spot which internal object type is growing when chasing a leak.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="grid grid-cols-3 gap-4">
              <Mini k="Objects" v={formatNumber(heap.heap?.objectCount ?? 0)} />
              <Mini k="Protected" v={formatNumber(heap.heap?.protectedCount ?? 0)} />
              <Mini k="Global" v={formatNumber(heap.heap?.globalCount ?? 0)} />
            </div>
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-wider text-faint">
                Top object types
              </div>
              <div className="max-h-52 overflow-y-auto rounded-lg border border-line">
                <table className="w-full text-xs">
                  <tbody>
                    {(heap.topObjectTypes ?? []).map((t) => (
                      <tr key={t.type} className="border-b border-line last:border-0">
                        <td className="px-3 py-1.5 font-mono text-muted">{t.type}</td>
                        <td className="px-3 py-1.5 text-right tnum text-fg">
                          {formatNumber(t.count)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader title="Prometheus" />
        <p className="mb-3 text-sm text-muted">
          Scrape endpoint (text exposition) for Grafana / Alertmanager. Auth is required only if the
          server sets <code className="font-mono text-xs">requireAuthForMetrics</code>.
        </p>
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
            {bq.prometheusUrl()}
          </code>
          <CopyButton value={bq.prometheusUrl()} />
        </div>
      </Card>

      {st && (
        <Card className="mt-6">
          {/* totalPushed/… are in-memory session counters — they zero on every
              server restart, so calling them "lifetime" was a lie. */}
          <CardHeader title="Totals since restart" />
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Mini k="Pushed" v={formatNumber(st.totalPushed)} />
            <Mini k="Pulled" v={formatNumber(st.totalPulled)} />
            <Mini k="Completed" v={formatNumber(st.totalCompleted)} />
            <Mini k="Failed" v={formatNumber(st.totalFailed)} />
          </div>
        </Card>
      )}
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

function Mini({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-faint">{k}</div>
      <div className="mt-1 text-lg font-semibold tnum text-fg">{v}</div>
    </div>
  );
}
