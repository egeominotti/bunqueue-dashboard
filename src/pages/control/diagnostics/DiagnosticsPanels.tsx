import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { StatusDot } from '@/components/ui/StatusBadge';
import { bq } from '@/lib/bq';
import { formatNumber } from '@/lib/format';
import type { MetricsResponse, ReadinessResponse, StatsResponse } from '@/lib/types';

export type HeapStats = Awaited<ReturnType<typeof bq.heapStats>>;

export interface EndpointSnapshot {
  healthz: string | null;
  live: string | null;
  ready: ReadinessResponse | null;
  metrics: MetricsResponse | null;
  healthzError: string | null;
  liveError: string | null;
  readyError: string | null;
  metricsError: string | null;
}

type ProbeState = {
  label: string;
  tone: 'green' | 'amber' | 'red' | 'zinc';
  detail: string;
};

function textProbe(value: string | null, error: string | null): ProbeState {
  if (error) return { label: 'Unavailable', tone: 'red', detail: error };
  if (value === null) return { label: 'Unknown', tone: 'zinc', detail: 'No response yet' };
  if (value.trim() === 'OK') return { label: 'Live', tone: 'green', detail: 'HTTP 200 · OK' };
  return {
    label: 'Unexpected',
    tone: 'amber',
    detail: `HTTP 200 · ${value.trim().slice(0, 80) || 'empty body'}`,
  };
}

function readinessProbe(value: ReadinessResponse | null, error: string | null): ProbeState {
  if (error) return { label: 'Unavailable', tone: 'red', detail: error };
  if (!value) return { label: 'Unknown', tone: 'zinc', detail: 'No response yet' };
  if (value.ok === true && value.ready === true) {
    return { label: 'Ready', tone: 'green', detail: 'Persistence accepts traffic' };
  }
  if (value.ok === false && value.ready === false) {
    return {
      label: 'Not ready',
      tone: 'red',
      detail: value.storage.error ?? 'Persistence is degraded',
    };
  }
  return { label: 'Unexpected', tone: 'amber', detail: 'Incoherent readiness payload' };
}

function ProbeRow({ path, state }: { path: string; state: ProbeState }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line py-2.5 last:border-0">
      <code className="w-20 shrink-0 font-mono text-xs text-fg">{path}</code>
      <StatusDot label={state.label} tone={state.tone} />
      <span className="min-w-0 flex-1 text-right text-xs text-faint">{state.detail}</span>
    </div>
  );
}

export function EndpointDiagnostics({ snapshot }: { snapshot: EndpointSnapshot }) {
  const metrics = snapshot.metrics?.metrics;
  return (
    <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Orchestrator probes" />
        <p className="mb-2 text-xs text-muted">
          Native Bunqueue liveness and persistence-readiness endpoints.
        </p>
        <div>
          <ProbeRow path="/healthz" state={textProbe(snapshot.healthz, snapshot.healthzError)} />
          <ProbeRow path="/live" state={textProbe(snapshot.live, snapshot.liveError)} />
          <ProbeRow path="/ready" state={readinessProbe(snapshot.ready, snapshot.readyError)} />
        </div>
      </Card>

      <Card>
        <CardHeader title="JSON metrics" />
        {snapshot.metricsError ? (
          <p className="text-sm text-danger">Unavailable — {snapshot.metricsError}</p>
        ) : metrics ? (
          <div className="grid grid-cols-2 gap-4">
            <Mini k="Pushed" v={formatNumber(metrics.totalPushed)} />
            <Mini k="Pulled" v={formatNumber(metrics.totalPulled)} />
            <Mini k="Completed" v={formatNumber(metrics.totalCompleted)} />
            <Mini k="Failed" v={formatNumber(metrics.totalFailed)} />
          </div>
        ) : (
          <p className="text-sm text-muted">No metrics response yet.</p>
        )}
        <p className="mt-3 font-mono text-xs text-faint">GET /metrics · application/json</p>
      </Card>
    </div>
  );
}

export function HeapPanel({
  heap,
  busy,
  onLoad,
}: {
  heap: HeapStats | null;
  busy: boolean;
  onLoad: () => void;
}) {
  return (
    <Card className="mt-6">
      <CardHeader
        title="Heap statistics"
        action={
          <Button size="sm" disabled={busy} onClick={onLoad}>
            {busy ? 'Loading…' : heap ? 'Refresh' : 'Load'}
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
                  {(heap.topObjectTypes ?? []).map((item) => (
                    <tr key={item.type} className="border-b border-line last:border-0">
                      <td className="px-3 py-1.5 font-mono text-muted">{item.type}</td>
                      <td className="px-3 py-1.5 text-right tnum text-fg">
                        {formatNumber(item.count)}
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
  );
}

export function PrometheusPanel() {
  const url = bq.prometheusUrl();
  return (
    <Card className="mt-6">
      <CardHeader title="Prometheus" />
      <p className="mb-3 text-sm text-muted">
        Scrape endpoint (text exposition) for Grafana / Alertmanager. Auth is required only if the
        server sets <code className="font-mono text-xs">requireAuthForMetrics</code>.
      </p>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{url}</code>
        <CopyButton value={url} />
      </div>
    </Card>
  );
}

export function TotalsPanel({ stats }: { stats: StatsResponse['stats'] | undefined }) {
  if (!stats) return null;
  return (
    <Card className="mt-6">
      <CardHeader title="Totals since restart" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Mini k="Pushed" v={formatNumber(stats.totalPushed)} />
        <Mini k="Pulled" v={formatNumber(stats.totalPulled)} />
        <Mini k="Completed" v={formatNumber(stats.totalCompleted)} />
        <Mini k="Failed" v={formatNumber(stats.totalFailed)} />
      </div>
    </Card>
  );
}

export function Mini({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-faint">{k}</div>
      <div className="mt-1 text-lg font-semibold tnum text-fg">{v}</div>
    </div>
  );
}
