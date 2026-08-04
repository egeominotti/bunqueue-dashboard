import { useState } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { bq } from '@/lib/bq';
import { usePolledData } from '@/lib/usePolledData';
import { AgentInfoCard } from './server/AgentInfoCard';
import { ConfigCard } from './server/ConfigCard';
import { ProcessLogs } from './server/ProcessLogs';
import { StatusConsole } from './server/StatusConsole';
import { StoragePanel } from './server/StoragePanel';

/** Process vitals from GET /health (RAM in MB, live connection counts). */
interface HealthVitals {
  memory?: { rss?: number; heapUsed?: number; heapTotal?: number };
  connections?: { tcp?: number; ws?: number; sse?: number };
}

export function ServerControl() {
  const { data, error, refetch } = usePolledData(() => bq.control.status(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // RAM + connections come from the server's own /health, not the agent —
  // only poll it while the process is running (it can't answer otherwise).
  const serverUp = data?.status === 'running';
  const { data: health } = usePolledData(
    () => (serverUp ? bq.health() : Promise.resolve(null)),
    [serverUp]
  );
  const vitals = serverUp ? ((health ?? null) as HealthVitals | null) : null;

  // Spell out the blast radius in stop/restart confirms: live connection counts
  // when /health has them, so the operator knows what a kill actually severs.
  const blastRadius = vitals?.connections
    ? ` This drops ${vitals.connections.tcp ?? 0} TCP / ${vitals.connections.ws ?? 0} WS connections; in-flight jobs are interrupted.`
    : ' In-flight jobs are interrupted.';

  const run = async (label: string, fn: () => Promise<unknown>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(label);
    setActionError(null);
    try {
      await fn();
      await refetch();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error && !data) {
    return (
      <div>
        <PageHeader title="Server" description="Start, stop and restart the bunqueue server." />
        <OfflineBanner
          message="Control agent unreachable — server lifecycle controls are unavailable."
          onRetry={refetch}
        />
        <Card>
          <CardHeader title="Control agent not running" />
          <p className="text-sm text-muted">
            The local control agent is unreachable at{' '}
            <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{bq.agentBase}</code>. It
            manages the bunqueue server process (start / stop / restart). Start it with:
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs">
            bun start{'      '}# agent + dashboard together (recommended){'\n'}bun run agent
            {'   '}# agent only, if the dashboard is already running
          </pre>
          <p className="mt-3 text-xs text-faint">
            This page reconnects automatically once the agent is up — no reload needed.
          </p>
        </Card>
      </div>
    );
  }

  const status = data?.status ?? 'stopped';
  const running = status === 'running';
  const transitioning = status === 'starting' || status === 'stopping' || busy != null;
  // Agent was reachable once (data cached) but the poll now fails — without
  // this the console keeps asserting "Running / healthy" with a live-ticking
  // uptime for an agent (and possibly server) that is dead.
  const stale = error != null && data != null;

  return (
    <div>
      <PageHeader
        title="Server"
        description="Supervise the bunqueue server process — lifecycle, configuration, storage and logs."
      />

      {actionError && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-danger"
        >
          {actionError}
        </div>
      )}

      {stale && (
        <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-2 text-sm text-warning">
          Control agent unreachable — showing last known state. Lifecycle actions are disabled until
          it responds again.
        </div>
      )}

      <StatusConsole
        status={data}
        agentBase={bq.agentBase}
        stale={stale}
        vitals={vitals}
        transitioning={transitioning}
        busy={busy}
        onStart={() => run('starting', () => bq.control.start())}
        onStop={() =>
          run('stopping', () => bq.control.stop(), `Stop the bunqueue server?${blastRadius}`)
        }
        onRestart={() =>
          run(
            'restarting',
            () => bq.control.restart(),
            `Restart the bunqueue server?${blastRadius}`
          )
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ConfigCard
          status={data}
          onSaved={refetch}
          running={running}
          transitioning={transitioning}
        />
        <div className="flex flex-col gap-6">
          {data?.db && <StoragePanel db={data.db} />}
          <ProcessLogs />
        </div>
      </div>

      <div className="mt-6">
        <AgentInfoCard agentBase={bq.agentBase} />
      </div>
    </div>
  );
}
