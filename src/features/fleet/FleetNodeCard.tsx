import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import type { FleetNodeSnapshot } from './fleetClient';

function Dot({ ok, reachable }: { ok: boolean; reachable: boolean }) {
  const color = !reachable ? 'bg-red-400' : ok ? 'bg-emerald-400' : 'bg-amber-400';
  return <span className={`inline-block size-2 rounded-full ${color}`} />;
}

export function FleetNodeCard({
  snapshot,
  active,
  busy,
  actionError,
  onActivate,
  onAction,
}: {
  snapshot: FleetNodeSnapshot;
  active: boolean;
  busy?: string;
  actionError?: string;
  onActivate: () => void;
  onAction: (action: 'start' | 'stop' | 'restart') => void;
}) {
  const { target, server, agent } = snapshot;
  const status = agent.status;
  const external = status?.managementMode === 'external';
  const running = external ? status?.reachable === true : status?.status === 'running';
  const transitioning =
    busy !== undefined || status?.status === 'starting' || status?.status === 'stopping';
  const storage =
    status?.storageMode === 'postgres'
      ? `PostgreSQL · ${status.postgresNamespace ?? 'default'}`
      : (status?.storageMode ?? 'unknown');

  return (
    <Card className={active ? 'border-accent/60' : undefined}>
      <CardHeader
        title={target.name}
        action={
          active ? (
            <span className="rounded-full bg-accent/15 px-2 py-1 text-[10px] font-semibold uppercase text-accent">
              active
            </span>
          ) : (
            <Button size="sm" onClick={onActivate}>
              Use node
            </Button>
          )
        }
      />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
        <dt className="text-faint">Server</dt>
        <dd className="flex min-w-0 items-center gap-2 text-muted">
          <Dot ok={server.healthy} reachable={server.reachable} />
          <span className="truncate" title={target.baseUrl}>
            {server.reachable
              ? `${server.healthy ? 'healthy' : 'degraded'}${server.version ? ` · v${server.version}` : ''}`
              : `offline · ${server.error ?? 'unreachable'}`}
          </span>
        </dd>
        <dt className="text-faint">Agent</dt>
        <dd className="flex min-w-0 items-center gap-2 text-muted">
          <Dot ok={agent.healthy} reachable={agent.reachable} />
          <span className="truncate" title={target.agentBaseUrl}>
            {agent.reachable
              ? `${status?.status ?? 'connected'}${external ? ' · external' : ''}`
              : `offline · ${agent.error ?? 'unreachable'}`}
          </span>
        </dd>
        <dt className="text-faint">Storage</dt>
        <dd className="truncate font-mono text-muted" title={status?.postgresTarget}>
          {storage}
        </dd>
        {status?.storageMode === 'postgres' && (
          <>
            <dt className="text-faint">Cluster</dt>
            <dd className="truncate font-mono text-muted">
              {status.postgresTarget ?? 'configured PostgreSQL'}
            </dd>
          </>
        )}
      </dl>
      {actionError && (
        <p role="status" className="mt-3 text-xs text-danger">
          {actionError}
        </p>
      )}
      {!external && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
          <Button
            size="sm"
            variant="success"
            disabled={!agent.reachable || running || transitioning}
            onClick={() => onAction('start')}
          >
            Start
          </Button>
          <Button
            size="sm"
            variant="warning"
            disabled={!agent.reachable || !running || transitioning}
            onClick={() => onAction('stop')}
          >
            Stop
          </Button>
          <Button
            size="sm"
            disabled={!agent.reachable || transitioning}
            onClick={() => onAction('restart')}
          >
            {busy === 'restart' ? 'Restarting…' : 'Restart'}
          </Button>
        </div>
      )}
    </Card>
  );
}
