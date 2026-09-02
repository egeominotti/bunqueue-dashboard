import { useEffect, useMemo, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  type FleetNodeSnapshot,
  postgresTopologyKey,
  probeFleet,
  runFleetLifecycle,
} from '@/features/fleet/fleetClient';
import { FleetNodeCard } from '@/features/fleet/FleetNodeCard';
import { useControlConnectionEpoch } from '@/lib/controlConnectionEpoch';
import { usePolledData } from '@/lib/usePolledData';

function topologyGroups(nodes: readonly FleetNodeSnapshot[]) {
  const groups = new Map<string, FleetNodeSnapshot[]>();
  for (const node of nodes) {
    const key = postgresTopologyKey(node);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  return [...groups.entries()].map(([key, members]) => {
    const status = members[0]?.agent.status;
    return {
      key,
      target: status?.postgresTarget ?? 'configured PostgreSQL',
      namespace: status?.postgresNamespace ?? 'default',
      members,
    };
  });
}

export function Fleet() {
  const profiles = useConnectionStore((state) => state.profiles);
  const activeProfileId = useConnectionStore((state) => state.activeProfileId);
  const activateProfile = useConnectionStore((state) => state.activateProfile);
  const connectionEpoch = useControlConnectionEpoch();
  const profileIds = profiles.map((profile) => profile.id);
  // Include metadata for every node and the secret-free active-connection epoch.
  // Endpoint or credential edits must abort an old probe/action immediately.
  const fleetKey = `${connectionEpoch}:${JSON.stringify(profiles)}`;
  const { data, error, loading, refetch } = usePolledData(
    (signal) => probeFleet(profileIds, signal),
    [fleetKey],
    { intervalMs: 10_000 }
  );
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const actionGeneration = useRef(0);
  const topology = useMemo(() => topologyGroups(data ?? []), [data]);

  useEffect(() => {
    actionGeneration.current += 1;
    setBusy({});
    setActionErrors({});
  }, [fleetKey]);

  const act = async (snapshot: FleetNodeSnapshot, action: 'start' | 'stop' | 'restart') => {
    const id = snapshot.target.id;
    if (busy[id]) return;
    if (
      action !== 'start' &&
      !window.confirm(
        `${action === 'stop' ? 'Stop' : 'Restart'} ${snapshot.target.name}? In-flight jobs on this broker may be interrupted.`
      )
    ) {
      return;
    }
    const generation = actionGeneration.current;
    setBusy((current) => ({ ...current, [id]: action }));
    setActionErrors((current) => ({ ...current, [id]: '' }));
    try {
      await runFleetLifecycle(id, action);
      if (generation === actionGeneration.current) await refetch();
    } catch (failure) {
      if (generation === actionGeneration.current) {
        setActionErrors((current) => ({ ...current, [id]: (failure as Error).message }));
      }
    } finally {
      if (generation === actionGeneration.current) {
        setBusy((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
      }
    }
  };

  return (
    <div>
      <PageHeader
        title="Fleet"
        description="Operate every Bunqueue broker and verify shared PostgreSQL topology."
        actions={<Button onClick={() => void refetch()}>Refresh all</Button>}
      />

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-faint">
            Configured nodes
          </div>
          <div className="mt-1 text-2xl font-bold text-fg">{profiles.length}</div>
        </Card>
        <Card>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-faint">
            Healthy APIs
          </div>
          <div className="mt-1 text-2xl font-bold text-fg">
            {(data ?? []).filter((node) => node.server.healthy).length}/{profiles.length}
          </div>
        </Card>
        <Card>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-faint">
            PostgreSQL clusters
          </div>
          <div className="mt-1 text-2xl font-bold text-fg">{topology.length}</div>
        </Card>
      </div>

      {error && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-danger"
        >
          Fleet refresh failed: {error.message}
        </div>
      )}

      {topology.length > 0 && (
        <Card className="mb-6">
          <CardHeader title="Shared PostgreSQL topology" />
          <div className="flex flex-col gap-3">
            {topology.map((group) => (
              <div
                key={group.key}
                className="rounded-lg border border-line bg-surface-2/40 px-4 py-3"
              >
                <div className="font-mono text-sm text-fg">{group.target}</div>
                <div className="mt-1 text-xs text-muted">
                  namespace <span className="font-mono text-fg">{group.namespace}</span> ·{' '}
                  {group.members.length} broker{group.members.length === 1 ? '' : 's'}:{' '}
                  {group.members.map((node) => node.target.name).join(', ')}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {loading && !data ? (
        <Card>Checking every Bunqueue node…</Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {(data ?? []).map((snapshot) => (
            <FleetNodeCard
              key={snapshot.target.id}
              snapshot={snapshot}
              active={snapshot.target.id === activeProfileId}
              busy={busy[snapshot.target.id]}
              actionError={actionErrors[snapshot.target.id]}
              onActivate={() => activateProfile(snapshot.target.id)}
              onAction={(action) => void act(snapshot, action)}
            />
          ))}
        </div>
      )}

      <p className="mt-5 text-xs leading-relaxed text-faint">
        PostgreSQL-backed queues, jobs, flows, crons, workers, limits, durable metrics and events
        are visible through every healthy broker in the same target and namespace. Lifecycle,
        process logs/configuration and in-memory webhooks are node-local; Workflow Engine storage
        uses each profile&apos;s agent data path.
      </p>
    </div>
  );
}
