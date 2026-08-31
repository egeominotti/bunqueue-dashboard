import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/form';
import { IconRefresh } from '@/components/ui/icons';
import { bq } from '@/lib/bq';
import type { ServerConfig, ServerStatus } from '@/lib/bqTypes';
import { useControlActionGuard } from '@/lib/useControlActionGuard';
import {
  adoptConfig,
  changedConfigFields,
  configDraftError,
  type ConfigEditor,
  type ConfigSaveFence,
  createConfigSaveFence,
  parseConfigSaveResponse,
  sameConfig,
  shouldIgnoreStatusBehindSave,
  validConfigRevision,
} from './configEditor';
import { EnvVarsEditor } from './EnvVarsEditor';

export function ConfigCard({
  status,
  onSaved,
  running,
  statusRequestId,
  getStatusRequestSequence,
  transitioning,
}: {
  status: ServerStatus | null;
  onSaved: () => void | Promise<void>;
  running: boolean;
  statusRequestId?: number;
  getStatusRequestSequence?: () => number;
  transitioning: boolean;
}) {
  const actionGuard = useControlActionGuard('server-config');
  const editorId = useRef(0);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusFenceAfterSave = useRef<ConfigSaveFence | null>(null);
  const [editor, setEditor] = useState<ConfigEditor | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [operation, setOperation] = useState<'save' | 'restart' | null>(null);
  const [conflict, setConflict] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = null;
    statusFenceAfterSave.current = null;
    setEditor(null);
    setDirty(false);
    setSaved(false);
    setOperation(null);
    setConflict(false);
    setErr(null);
  }, [actionGuard.scopeKey]);
  useEffect(() => {
    if (!status?.config || dirty) return;
    const fence = statusFenceAfterSave.current;
    if (
      fence &&
      shouldIgnoreStatusBehindSave(
        fence,
        status.config,
        validConfigRevision(status.configRevision),
        statusRequestId
      )
    ) {
      return;
    }
    statusFenceAfterSave.current = null;
    setEditor(
      adoptConfig(
        status.config,
        validConfigRevision(status.configRevision),
        actionGuard.scopeKey,
        ++editorId.current
      )
    );
    setConflict(false);
  }, [actionGuard.scopeKey, dirty, status?.config, status?.configRevision, statusRequestId]);
  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    []
  );

  const currentEditor = editor?.scope === actionGuard.scopeKey ? editor : null;
  const value = currentEditor?.value ?? status?.config ?? null;
  if (!value) return <Card>Loading…</Card>;

  const set = (patch: Partial<ServerConfig>) => {
    const base =
      currentEditor ??
      adoptConfig(
        value,
        validConfigRevision(status?.configRevision),
        actionGuard.scopeKey,
        ++editorId.current
      );
    setEditor({ ...base, value: { ...base.value, ...patch } });
    setDirty(true);
    setSaved(false);
    setConflict(false);
  };
  const changed = changedConfigFields(status?.runningConfig ?? null, value);
  const pending = running && changed.length > 0;
  const busy = transitioning || operation !== null;

  const flashSaved = () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setSaved(true);
    savedTimer.current = setTimeout(() => {
      savedTimer.current = null;
      setSaved(false);
    }, 2000);
  };
  const persist = async (restart: boolean) => {
    const lease = actionGuard.begin(['config', 'lifecycle']);
    if (!lease) return;
    const invalid = configDraftError(value);
    if (invalid) {
      lease.finish();
      return setErr(invalid);
    }
    const baseline = currentEditor?.baseline ?? status?.config;
    const expectedRevision = currentEditor?.revision ?? validConfigRevision(status?.configRevision);
    if (
      expectedRevision === undefined &&
      baseline &&
      status?.config &&
      !sameConfig(baseline, status.config)
    ) {
      lease.finish();
      setConflict(true);
      return setErr('Configuration changed elsewhere; reload the latest values before saving.');
    }
    setErr(null);
    setConflict(false);
    setOperation(restart ? 'restart' : 'save');
    try {
      const response = await bq.control.setConfig(value, expectedRevision);
      if (!lease.isCurrent()) return;
      const { config: next, revision } = parseConfigSaveResponse(response);
      statusFenceAfterSave.current = createConfigSaveFence(
        next,
        revision,
        status?.config ?? null,
        validConfigRevision(status?.configRevision),
        getStatusRequestSequence?.()
      );
      setEditor(adoptConfig(next, revision, actionGuard.scopeKey, ++editorId.current));
      setDirty(false);
      if (restart) await bq.control.restart();
      if (!lease.isCurrent()) return;
      flashSaved();
      await onSaved();
    } catch (e) {
      if (!lease.isCurrent()) return;
      const message = (e as Error).message;
      if (message.startsWith('Configuration changed since revision')) setConflict(true);
      setErr(message);
    } finally {
      if (lease.finish()) setOperation(null);
    }
  };

  const save = () => persist(false);

  const saveAndRestart = () => {
    const what = changed.length > 0 ? ` Changed: ${changed.join(', ')}.` : '';
    if (!window.confirm(`Save configuration and restart the server to apply it?${what}`)) return;
    return persist(true);
  };

  const reloadLatest = () => {
    if (!status?.config) return;
    statusFenceAfterSave.current = null;
    setEditor(
      adoptConfig(
        status.config,
        validConfigRevision(status.configRevision),
        actionGuard.scopeKey,
        ++editorId.current
      )
    );
    setDirty(false);
    setConflict(false);
    setErr(null);
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
          hint="The exact command the agent runs to launch bunqueue. It receives HTTP_PORT and TCP_PORT; BUNQUEUE_DATA_PATH is injected only for SQLite and removed in non-SQLite modes. The default resolves Bunqueue 2.9.2 with bunx; offline installs can point at a local entry."
        >
          <Input
            name="server-command"
            autoComplete="off"
            spellCheck={false}
            value={value.command}
            disabled={busy}
            onChange={(e) => set({ command: e.target.value })}
            placeholder="bunx bunqueue@2.9.2 start"
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
          hint="Durable SQLite path for the managed broker and Workflow Engine, relative to the agent's working directory. In PostgreSQL mode the agent keeps it for Workflow state but does not pass it to the broker."
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
          hint="Injected on start. Memory and PostgreSQL modes remove inherited SQLite path aliases so Bunqueue cannot start with ambiguous storage. Applies on the next restart."
        >
          <EnvVarsEditor
            key={currentEditor?.id ?? 'initial'}
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
          {conflict && (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={reloadLatest}>
              Reload latest
            </Button>
          )}
          {err && <span className="text-xs text-danger">{err}</span>}
        </div>
      </form>
    </Card>
  );
}
