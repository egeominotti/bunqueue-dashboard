import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Toggle } from '@/components/ui/form';
import { bq } from '@/lib/bq';
import type { DlqConfig } from '@/lib/bqTypes';
import { FLOW_DLQ_RETENTION_UNAVAILABLE } from '@/lib/flowMutationSafety';
import {
  assertConfigMutationResponse,
  type DlqDraft,
  dlqConfigMutationPayload,
} from './configModel';
import { useConfigSaveGuard, useSyncedConfig } from './configState';

export function DlqConfigForm({
  queue,
  config,
  onSaved,
}: {
  queue: string;
  config: DlqConfig;
  onSaved: () => void | Promise<void>;
}) {
  const [draft, setDraft, beginSave] = useSyncedConfig<DlqDraft>(config);
  const [error, setError] = useState<string | null>(null);
  const save = useConfigSaveGuard(`dlq-config:${queue}`);
  // A target change clears errors from the previous target.
  useEffect(() => setError(null), [save.scopeKey]);
  const payload = dlqConfigMutationPayload(draft);
  const enablingAutoRetry = payload.ok && payload.value.autoRetry;
  const submit = async () => {
    if (!payload.ok) return;
    const lease = save.start();
    if (!lease) return;
    try {
      setError(null);
      const markSaved = beginSave();
      const response = await bq.setDlqConfig(queue, payload.value);
      assertConfigMutationResponse(response, '/dlq-config');
      if (!lease.isCurrent()) return;
      markSaved({ ...draft, ...payload.value });
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
      <CardHeader title="DLQ policy" />
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 flex items-center gap-2">
          <Toggle
            checked={draft.autoRetry}
            disabled={!draft.autoRetry}
            onChange={(autoRetry) => setDraft({ ...draft, autoRetry })}
            label="auto-retry"
          />
          <span className="text-sm text-muted" aria-hidden="true">
            auto-retry
          </span>
        </div>
        <p className="col-span-2 text-xs text-warning">
          Auto-retry can only be disabled. Bunqueue v2.9.2 cannot prove that a DLQ entry has no
          hidden reverse flow dependents before a background retry.
        </p>
        <Field label="Retry interval (ms)">
          <Input
            name="dlq-auto-retry-interval-ms"
            autoComplete="off"
            type="number"
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            value={draft.autoRetryInterval}
            onChange={(event) => setDraft({ ...draft, autoRetryInterval: event.target.value })}
          />
        </Field>
        <Field label="Max auto-retries">
          <Input
            name="dlq-max-auto-retries"
            autoComplete="off"
            type="number"
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            value={draft.maxAutoRetries}
            onChange={(event) => setDraft({ ...draft, maxAutoRetries: event.target.value })}
          />
        </Field>
        <Field label="Max age (ms)">
          <Input
            name="dlq-max-age-ms"
            autoComplete="off"
            type="number"
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            disabled
            title={FLOW_DLQ_RETENTION_UNAVAILABLE}
            value={draft.maxAge ?? ''}
            readOnly
          />
        </Field>
        <Field label="Max entries">
          <Input
            name="dlq-max-entries"
            autoComplete="off"
            type="number"
            min={1}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            disabled
            title={FLOW_DLQ_RETENTION_UNAVAILABLE}
            value={draft.maxEntries}
            readOnly
          />
        </Field>
        <p className="col-span-2 text-xs text-warning">{FLOW_DLQ_RETENTION_UNAVAILABLE}</p>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="accent"
          size="sm"
          disabled={save.saving || !payload.ok || enablingAutoRetry}
          onClick={submit}
        >
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
        {enablingAutoRetry && (
          <span role="alert" className="text-xs text-danger">
            Disable auto-retry before saving this policy.
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
