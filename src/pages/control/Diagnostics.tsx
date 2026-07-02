import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { bq } from '@/lib/bq';
import { formatBytes, formatNumber, formatUptime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';

// Safe default so the page renders its diagnostic cards (empty/zeroed) when the
// server is unreachable — including a /health failure — instead of a blocking
// error screen. storage()/stats() already resolve to null on failure.
const EMPTY = { health: {}, storage: null, stats: null };

export function Diagnostics() {
  const { data, error, loading, refetch } = usePolledData(async () => {
    const [health, storage, stats] = await Promise.all([
      bq.health(),
      bq.storage().catch(() => null),
      bq.stats().catch(() => null),
    ]);
    return { health, storage, stats };
  }, []);

  const [ping, setPing] = useState<string | null>(null);
  const doPing = async () => {
    setPing('…');
    const t0 = performance.now();
    try {
      await bq.ping();
      setPing(`${Math.round(performance.now() - t0)} ms`);
    } catch {
      setPing('unreachable');
    }
  };

  if (loading && !data && !error) return <LoadingState label="Loading diagnostics…" />;

  const d = data ?? EMPTY;
  const h = d.health as {
    ok?: boolean;
    status?: string;
    version?: string;
    uptime?: number;
    memory?: { heapUsed: number; heapTotal: number; rss: number };
    connections?: { tcp: number; ws: number; sse: number };
  };
  const disk = d.storage?.data;
  const st = d.stats?.stats;

  return (
    <div>
      <PageHeader
        title="Diagnostics"
        description="Server health, storage, memory and connections."
        live={!error}
      />
      {error && <OfflineBanner onRetry={refetch} />}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Status"
          value={h.status ?? (h.ok ? 'healthy' : 'degraded')}
          tone={h.ok ? 'green' : 'red'}
          compact
        />
        <StatCard label="Version" value={h.version ? `v${h.version}` : '—'} compact />
        <StatCard label="Uptime" value={formatUptime(h.uptime)} compact />
        <StatCard
          label="Disk"
          value={disk?.diskFull ? 'Full' : 'Healthy'}
          tone={disk?.diskFull ? 'red' : 'green'}
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
            <Row k="WebSocket clients" v={String(h.connections?.ws ?? 0)} />
            <Row k="SSE clients" v={String(h.connections?.sse ?? 0)} />
            <Row k="Storage error" v={disk?.error ? String(disk.error) : 'none'} />
          </dl>
        </Card>

        <Card>
          <CardHeader title="Memory" />
          <div className="grid grid-cols-3 gap-4">
            <Mini k="Heap used" v={formatBytes((h.memory?.heapUsed ?? 0) * 1024 * 1024)} />
            <Mini k="Heap total" v={formatBytes((h.memory?.heapTotal ?? 0) * 1024 * 1024)} />
            <Mini k="RSS" v={formatBytes((h.memory?.rss ?? 0) * 1024 * 1024)} />
          </div>
        </Card>
      </div>

      {st && (
        <Card className="mt-6">
          <CardHeader title="Lifetime totals" />
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
