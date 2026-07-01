import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { OfflineBanner } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/form';
import { IconRefresh } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { bq } from '@/lib/bq';
import type { ServerConfig, ServerStatus } from '@/lib/bqTypes';
import { usePolledData } from '@/lib/usePolledData';
import { AgentInfoCard } from './server/AgentInfoCard';
import { EnvVarsEditor } from './server/EnvVarsEditor';
import { ProcessLogs } from './server/ProcessLogs';
import { StatusConsole } from './server/StatusConsole';
import { StoragePanel } from './server/StoragePanel';

export function ServerControl() {
  const { data, error, refetch } = usePolledData(() => bq.control.status(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
        <OfflineBanner onRetry={refetch} />
        <Card>
          <CardHeader title="Control agent not running" />
          <p className="text-sm text-muted">
            The local control agent is unreachable at{' '}
            <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{bq.agentBase}</code>. It
            manages the bunqueue server process (start / stop / restart). Start it with:
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs">
            bun run agent/index.ts
          </pre>
        </Card>
      </div>
    );
  }

  const status = data?.status ?? 'stopped';
  const running = status === 'running';
  const transitioning = status === 'starting' || status === 'stopping' || busy != null;

  return (
    <div>
      <PageHeader
        title="Server"
        description="Supervise the bunqueue server process — lifecycle, configuration, storage and logs."
      />

      {actionError && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-red-400">
          {actionError}
        </div>
      )}

      <StatusConsole
        status={data}
        agentBase={bq.agentBase}
        transitioning={transitioning}
        busy={busy}
        onStart={() => run('starting', () => bq.control.start())}
        onStop={() => run('stopping', () => bq.control.stop(), 'Stop the bunqueue server?')}
        onRestart={() =>
          run('restarting', () => bq.control.restart(), 'Restart the bunqueue server?')
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

function ConfigCard({
  status,
  onSaved,
  running,
  transitioning,
}: {
  status: ServerStatus | null;
  onSaved: () => void;
  running: boolean;
  transitioning: boolean;
}) {
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Seed the form once from the agent, then let the user edit freely.
  useEffect(() => {
    if (status?.config && !cfg) setCfg(status.config);
  }, [status, cfg]);

  const value = cfg ?? status?.config ?? null;
  if (!value) return <Card>Loading…</Card>;

  const set = (patch: Partial<ServerConfig>) => setCfg({ ...value, ...patch });

  // Fields differ from what the live process was launched with → needs a restart.
  const rc = status?.runningConfig ?? null;
  const envKey = (o: Record<string, string> = {}) =>
    JSON.stringify(
      Object.keys(o)
        .sort()
        .map((k) => [k, o[k]])
    );
  const pending =
    running &&
    rc != null &&
    (rc.command !== value.command ||
      rc.httpPort !== value.httpPort ||
      rc.tcpPort !== value.tcpPort ||
      rc.dataPath !== value.dataPath ||
      envKey(rc.extraEnv) !== envKey(value.extraEnv));

  const busy = transitioning || restarting;

  const flashSaved = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // Reject empty/0/out-of-range or colliding ports before persisting or restarting.
  const validate = (): string | null => {
    const validPort = (p: number) => Number.isInteger(p) && p >= 1 && p <= 65535;
    if (!validPort(value.httpPort)) return 'HTTP port must be an integer between 1 and 65535';
    if (!validPort(value.tcpPort)) return 'TCP port must be an integer between 1 and 65535';
    if (value.httpPort === value.tcpPort) return 'HTTP and TCP ports must differ';
    return null;
  };

  const save = async () => {
    const invalid = validate();
    if (invalid) {
      setErr(invalid);
      return;
    }
    setErr(null);
    try {
      await bq.control.setConfig(value);
      flashSaved();
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const saveAndRestart = async () => {
    const invalid = validate();
    if (invalid) {
      setErr(invalid);
      return;
    }
    if (!window.confirm('Save configuration and restart the server to apply it?')) return;
    setErr(null);
    setRestarting(true);
    try {
      await bq.control.setConfig(value);
      await bq.control.restart();
      flashSaved();
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRestarting(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Configuration" />
      <p className="mb-3 text-xs text-amber-400/80">
        {running
          ? 'Ports and data path apply on the next restart — edit freely, then restart.'
          : 'Edit and save; the config is used the next time the server starts.'}
      </p>
      <div className="flex flex-col gap-3">
        <Field
          label="Command"
          hint="The exact command the agent runs to launch bunqueue. It receives HTTP_PORT, TCP_PORT and BUNQUEUE_DATA_PATH in its environment. The default needs a global 'bunqueue' binary — or point it at a local entry, e.g. bun run /path/to/bunqueue/src/main.ts."
        >
          <Input
            value={value.command}
            disabled={busy}
            onChange={(e) => set({ command: e.target.value })}
            placeholder="bunqueue start"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="HTTP port" hint="Dashboard API + SSE.">
            <Input
              type="number"
              value={value.httpPort}
              disabled={busy}
              onChange={(e) => set({ httpPort: Number(e.target.value) })}
            />
          </Field>
          <Field label="TCP port" hint="Binary protocol. Must differ from HTTP.">
            <Input
              type="number"
              value={value.tcpPort}
              disabled={busy}
              onChange={(e) => set({ tcpPort: Number(e.target.value) })}
            />
          </Field>
        </div>
        <Field
          label="Data path"
          hint="SQLite database file, relative to the agent's working directory. The parent folder must already exist — SQLite creates the file, not the directory."
        >
          <Input
            value={value.dataPath}
            disabled={busy}
            onChange={(e) => set({ dataPath: e.target.value })}
          />
        </Field>
        <Field
          label="Environment variables"
          hint="Injected into the server process on start, on top of the ports + data path. Applies on the next restart."
        >
          <EnvVarsEditor
            value={value.extraEnv ?? {}}
            onChange={(extraEnv) => set({ extraEnv })}
            disabled={busy}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="accent" size="sm" disabled={busy} onClick={save}>
            Save config
          </Button>
          {running && (
            <Button variant="warning" size="sm" disabled={busy} onClick={saveAndRestart}>
              <IconRefresh className="size-3.5" /> Save & restart
            </Button>
          )}
          {pending && !saved && (
            <span className="text-xs text-amber-400">Restart to apply changes</span>
          )}
          {saved && <span className="text-xs text-emerald-400">Saved</span>}
          {err && <span className="text-xs text-red-400">{err}</span>}
        </div>
      </div>
    </Card>
  );
}
