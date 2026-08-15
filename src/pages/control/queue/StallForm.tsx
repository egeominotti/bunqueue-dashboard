import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Toggle } from '@/components/ui/form';
import { bq } from '@/lib/bq';
import type { StallConfig } from '@/lib/bqTypes';
import { assertConfigMutationResponse, type StallDraft, stallConfigPayload } from './configModel';
import { useConfigSaveGuard, useSyncedConfig } from './configState';

export function StallForm({
  queue,
  config,
  onSaved,
}: {
  queue: string;
  config: StallConfig;
  onSaved: () => void | Promise<void>;
}) {
  const [draft, setDraft, beginSave] = useSyncedConfig<StallDraft>(config);
  const [error, setError] = useState<string | null>(null);
  const save = useConfigSaveGuard(`stall-config:${queue}`);
  // A target change clears errors from the previous target.
  useEffect(() => setError(null), [save.scopeKey]);
  const payload = stallConfigPayload(draft);
  const submit = async () => {
    if (!payload.ok) return;
    const lease = save.start();
    if (!lease) return;
    try {
      setError(null);
      const markSaved = beginSave();
      const response = await bq.setStallConfig(queue, payload.value);
      assertConfigMutationResponse(response, '/stall-config');
      if (!lease.isCurrent()) return;
      markSaved(payload.value);
      await onSaved();
      save.showSaved(lease);
    } catch (caught) {
      if (lease.isCurrent()) setError((caught as Error).message);
    } finally {
      save.finish(lease);
    }
  };
  return (
    <Card>
      <CardHeader title="Stall detection" />
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 flex items-center gap-2">
          <Toggle
            checked={draft.enabled}
            onChange={(enabled) => setDraft({ ...draft, enabled })}
            label="enabled"
          />
          <span className="text-sm text-muted" aria-hidden="true">
            enabled
          </span>
        </div>
        <Field label="Stall interval (ms)">
          <Input
            name="stall-interval-ms"
            autoComplete="off"
            type="number"
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            value={draft.stallInterval}
            onChange={(event) => setDraft({ ...draft, stallInterval: event.target.value })}
          />
        </Field>
        <Field label="Max stalls">
          <Input
            name="stall-max-count"
            autoComplete="off"
            type="number"
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            value={draft.maxStalls}
            onChange={(event) => setDraft({ ...draft, maxStalls: event.target.value })}
          />
        </Field>
        <Field label="Grace period (ms)">
          <Input
            name="stall-grace-period-ms"
            autoComplete="off"
            type="number"
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            value={draft.gracePeriod}
            onChange={(event) => setDraft({ ...draft, gracePeriod: event.target.value })}
          />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="accent" size="sm" disabled={save.saving || !payload.ok} onClick={submit}>
          Save
        </Button>
        {save.saved && (
          <span role="status" className="text-xs text-success">
            Saved ✓
          </span>
        )}
        {!payload.ok && (
          <span role="alert" className="text-xs text-danger">
            {payload.error}
          </span>
        )}
        {error && (
          <span role="alert" className="text-xs text-danger">
            {error}
          </span>
        )}
      </div>
    </Card>
  );
}
