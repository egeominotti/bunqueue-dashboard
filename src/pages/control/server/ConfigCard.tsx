import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/form';
import { IconRefresh } from '@/components/ui/icons';
import { bq } from '@/lib/bq';
import type { ServerConfig, ServerStatus } from '@/lib/bqTypes';
import { EnvVarsEditor } from './EnvVarsEditor';

export function ConfigCard({
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

  useEffect(() => {
    if (status?.config && !cfg) setCfg(status.config);
  }, [status, cfg]);

  const value = cfg ?? status?.config ?? null;
  if (!value) return <Card>Loading…</Card>;

  const set = (patch: Partial<ServerConfig>) => setCfg({ ...value, ...patch });
  const rc = status?.runningConfig ?? null;
  const envKey = (o: Record<string, string> = {}) =>
    JSON.stringify(
      Object.keys(o)
        .sort()
        .map((k) => [k, o[k]])
    );
  const changed: string[] = [];
  if (rc != null) {
    if (rc.command !== value.command) changed.push('command');
    if (rc.httpPort !== value.httpPort) changed.push('HTTP port');
    if (rc.tcpPort !== value.tcpPort) changed.push('TCP port');
    if (rc.dataPath !== value.dataPath) changed.push('data path');
    if (envKey(rc.extraEnv) !== envKey(value.extraEnv)) changed.push('environment variables');
  }
  const pending = running && changed.length > 0;
  const busy = transitioning || restarting;

  const flashSaved = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };
  const validate = (): string | null => {
    const validPort = (p: number) => Number.isInteger(p) && p >= 1 && p <= 65535;
    if (!validPort(value.httpPort)) return 'HTTP port must be an integer between 1 and 65535';
    if (!validPort(value.tcpPort)) return 'TCP port must be an integer between 1 and 65535';
    if (value.httpPort === value.tcpPort) return 'HTTP and TCP ports must differ';
    return null;
  };

  const save = async () => {
    const invalid = validate();
    if (invalid) return setErr(invalid);
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
    if (invalid) return setErr(invalid);
    const what = changed.length > 0 ? ` Changed: ${changed.join(', ')}.` : '';
    if (!window.confirm(`Save configuration and restart the server to apply it?${what}`)) return;
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
      <p className="mb-3 text-xs text-muted">
        {running
          ? 'Ports and data path apply on the next restart — edit freely, then restart.'
          : 'Edit and save; the config is used the next time the server starts.'}
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field
          label="Command"
          hint="The exact command the agent runs to launch bunqueue. It receives HTTP_PORT, TCP_PORT and BUNQUEUE_DATA_PATH in its environment. The default resolves Bunqueue 2.8.59 with bunx; offline installs can point at a local entry."
        >
          <Input
            name="server-command"
            autoComplete="off"
            spellCheck={false}
            value={value.command}
            disabled={busy}
            onChange={(e) => set({ command: e.target.value })}
            placeholder="bunx bunqueue@2.8.59 start"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="HTTP port" hint="Dashboard API + SSE.">
            <Input
              name="server-http-port"
              autoComplete="off"
              type="number"
              min={1}
              max={65535}
              value={value.httpPort}
              disabled={busy}
              onChange={(e) => set({ httpPort: Number(e.target.value) })}
            />
          </Field>
          <Field label="TCP port" hint="Binary protocol. Must differ from HTTP.">
            <Input
              name="server-tcp-port"
              autoComplete="off"
              type="number"
              min={1}
              max={65535}
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
            name="server-data-path"
            autoComplete="off"
            spellCheck={false}
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
          <Button type="submit" variant="accent" size="sm" disabled={busy}>
            Save config
          </Button>
          {running && (
            <Button variant="warning" size="sm" disabled={busy} onClick={saveAndRestart}>
              <IconRefresh className="size-3.5" /> Save & restart
            </Button>
          )}
          {pending && !saved && (
            <span className="text-xs text-warning">Restart to apply changes</span>
          )}
          {saved && <span className="text-xs text-success">Saved</span>}
          {err && <span className="text-xs text-danger">{err}</span>}
        </div>
      </form>
    </Card>
  );
}
