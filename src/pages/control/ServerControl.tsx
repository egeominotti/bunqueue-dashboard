import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { OfflineBanner } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/form';
import { IconPause, IconPlay, IconRefresh } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { StatusDot } from '@/components/ui/StatusBadge';
import { bq } from '@/lib/bq';
import type { ServerConfig, ServerStatus } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatBytes, formatDateTime, formatRelativeTime, formatUptime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';

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
        description="Start, stop and restart the bunqueue server process."
        actions={
          <>
            <Button
              variant="success"
              size="sm"
              disabled={running || transitioning}
              onClick={() => run('start', () => bq.control.start())}
            >
              <IconPlay className="size-3.5" /> Start
            </Button>
            <Button
              variant="warning"
              size="sm"
              disabled={!running || transitioning}
              onClick={() => run('stop', () => bq.control.stop(), 'Stop the bunqueue server?')}
            >
              <IconPause className="size-3.5" /> Stop
            </Button>
            <Button
              size="sm"
              disabled={transitioning}
              onClick={() =>
                run('restart', () => bq.control.restart(), 'Restart the bunqueue server?')
              }
            >
              <IconRefresh className="size-3.5" /> Restart
            </Button>
          </>
        }
      />

      {actionError && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-red-400">
          {actionError}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <div className="text-[11px] font-medium uppercase tracking-wider text-faint">Status</div>
          <div className="mt-2 flex items-center gap-2 text-xl font-semibold capitalize text-fg">
            <StatusDot label="" tone={running ? 'green' : status === 'stopped' ? 'red' : 'amber'} />
            {status}
          </div>
        </Card>
        <StatCard
          label="Health"
          value={data?.healthy ? 'Healthy' : running ? 'Starting…' : '—'}
          tone={data?.healthy ? 'green' : 'default'}
          compact
        />
        <StatCard label="PID" value={data?.pid ?? '—'} compact />
        <StatCard
          label="Uptime"
          value={
            running && data?.startedAt ? formatUptime((Date.now() - data.startedAt) / 1000) : '—'
          }
          compact
        />
      </div>

      {data?.db && (
        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard
            label="Database"
            value={formatBytes(data.db.size)}
            tone={data.db.exists ? 'accent' : 'default'}
            hint={data.db.exists ? 'main .db' : 'not created yet'}
            compact
          />
          <StatCard
            label="WAL"
            value={formatBytes(data.db.walSize)}
            hint="write-ahead log"
            compact
          />
          <StatCard
            label="On disk"
            value={formatBytes(data.db.totalSize)}
            hint="db + wal + shm"
            compact
          />
          <StatCard
            label="DB modified"
            value={data.db.mtimeMs ? formatRelativeTime(data.db.mtimeMs) : '—'}
            compact
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ConfigCard
          status={data}
          onSaved={refetch}
          running={running}
          transitioning={transitioning}
        />
        <LogsCard />
      </div>

      <div className="mt-4 space-y-1 text-xs text-faint">
        {data?.db && (
          <p className="truncate font-mono" title={data.db.path}>
            data: {data.db.path}
          </p>
        )}
        {!running && data?.exitCode != null && (
          <p className={data.exitCode === 0 ? '' : 'text-red-400'}>
            last exit code: {data.exitCode}
          </p>
        )}
        {data?.version && (
          <p>
            bunqueue v{data.version} · started {formatDateTime(data.startedAt)}
          </p>
        )}
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
  const pending =
    running &&
    rc != null &&
    (rc.command !== value.command ||
      rc.httpPort !== value.httpPort ||
      rc.tcpPort !== value.tcpPort ||
      rc.dataPath !== value.dataPath);

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
        <Field label="Command">
          <Input
            value={value.command}
            disabled={busy}
            onChange={(e) => set({ command: e.target.value })}
            placeholder="bunqueue start"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="HTTP port">
            <Input
              type="number"
              value={value.httpPort}
              disabled={busy}
              onChange={(e) => set({ httpPort: Number(e.target.value) })}
            />
          </Field>
          <Field label="TCP port">
            <Input
              type="number"
              value={value.tcpPort}
              disabled={busy}
              onChange={(e) => set({ tcpPort: Number(e.target.value) })}
            />
          </Field>
        </div>
        <Field label="Data path">
          <Input
            value={value.dataPath}
            disabled={busy}
            onChange={(e) => set({ dataPath: e.target.value })}
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

function LogsCard() {
  const { data } = usePolledData(() => bq.control.logs(), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = data?.lines ?? [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new lines
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="border-b border-line px-5 py-3">
        <h3 className="text-base font-semibold text-fg">Process logs</h3>
      </div>
      <div
        ref={scrollRef}
        className="max-h-80 overflow-y-auto p-4 font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 ? (
          <p className="text-faint">No output yet.</p>
        ) : (
          lines.map((l) => (
            <div
              key={l.seq}
              className={cn(
                'whitespace-pre-wrap',
                l.stream === 'stderr'
                  ? 'text-red-400/90'
                  : l.stream === 'sys'
                    ? 'text-accent/80'
                    : 'text-muted'
              )}
            >
              {l.line}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
