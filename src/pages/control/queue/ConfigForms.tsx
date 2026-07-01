import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Toggle } from '@/components/ui/form';
import { bq } from '@/lib/bq';
import type { DlqConfig, StallConfig } from '@/lib/bqTypes';

/**
 * Adopt server config into local editable state, but ONLY when its VALUES
 * change — not on every poll. `usePolledData` hands us a fresh object reference
 * on each 3s poll even when the values are identical; a plain `[config]` effect
 * would then reset the form and wipe whatever the user is typing. Comparing by
 * serialized value preserves in-progress edits while still switching to a new
 * queue's config (or an externally-changed value) when it actually differs.
 */
function useSyncedConfig<T>(config: T): [T, (v: T) => void] {
  const [c, setC] = useState(config);
  const lastServer = useRef(JSON.stringify(config));
  useEffect(() => {
    const next = JSON.stringify(config);
    if (next !== lastServer.current) {
      lastServer.current = next;
      setC(config);
    }
  }, [config]);
  return [c, setC];
}

export function StallForm({
  queue,
  config,
  onSaved,
}: {
  queue: string;
  config: StallConfig;
  onSaved: () => void;
}) {
  const [c, setC] = useSyncedConfig(config);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Stall detection" />
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 flex items-center gap-2">
          <Toggle
            checked={c.enabled}
            onChange={(v) => setC({ ...c, enabled: v })}
            label="enabled"
          />
          <span className="text-sm text-muted">enabled</span>
        </div>
        <Field label="Stall interval (ms)">
          <Input
            type="number"
            value={c.stallInterval}
            onChange={(e) => setC({ ...c, stallInterval: Number(e.target.value) })}
          />
        </Field>
        <Field label="Max stalls">
          <Input
            type="number"
            value={c.maxStalls}
            onChange={(e) => setC({ ...c, maxStalls: Number(e.target.value) })}
          />
        </Field>
        <Field label="Grace period (ms)">
          <Input
            type="number"
            value={c.gracePeriod}
            onChange={(e) => setC({ ...c, gracePeriod: Number(e.target.value) })}
          />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="accent"
          size="sm"
          onClick={async () => {
            try {
              setErr(null);
              await bq.setStallConfig(queue, c);
              onSaved();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Save
        </Button>
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>
    </Card>
  );
}

export function DlqConfigForm({
  queue,
  config,
  onSaved,
}: {
  queue: string;
  config: DlqConfig;
  onSaved: () => void;
}) {
  const [c, setC] = useSyncedConfig(config);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="DLQ policy" />
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 flex items-center gap-2">
          <Toggle
            checked={c.autoRetry}
            onChange={(v) => setC({ ...c, autoRetry: v })}
            label="auto-retry"
          />
          <span className="text-sm text-muted">auto-retry</span>
        </div>
        <Field label="Retry interval (ms)">
          <Input
            type="number"
            value={c.autoRetryInterval}
            onChange={(e) => setC({ ...c, autoRetryInterval: Number(e.target.value) })}
          />
        </Field>
        <Field label="Max auto-retries">
          <Input
            type="number"
            value={c.maxAutoRetries}
            onChange={(e) => setC({ ...c, maxAutoRetries: Number(e.target.value) })}
          />
        </Field>
        <Field label="Max age (ms)">
          <Input
            type="number"
            value={c.maxAge ?? ''}
            onChange={(e) => setC({ ...c, maxAge: e.target.value ? Number(e.target.value) : null })}
          />
        </Field>
        <Field label="Max entries">
          <Input
            type="number"
            value={c.maxEntries}
            onChange={(e) => setC({ ...c, maxEntries: Number(e.target.value) })}
          />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="accent"
          size="sm"
          onClick={async () => {
            try {
              setErr(null);
              await bq.setDlqConfig(queue, c);
              onSaved();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Save
        </Button>
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>
    </Card>
  );
}
