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

/**
 * Coerce a draft field to a number on save. Numeric inputs are kept as-typed
 * (string allowed) so clearing a field mid-edit doesn't snap to 0; '' or a
 * non-numeric value returns null so it can be rejected instead of saved as 0.
 */
function toNum(v: number | string): number | null {
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Editable copy of StallConfig where numeric fields may hold in-progress text. */
type StallDraft = Omit<StallConfig, 'stallInterval' | 'maxStalls' | 'gracePeriod'> & {
  stallInterval: number | string;
  maxStalls: number | string;
  gracePeriod: number | string;
};

/** Editable copy of DlqConfig where numeric fields may hold in-progress text. */
type DlqDraft = Omit<
  DlqConfig,
  'autoRetryInterval' | 'maxAutoRetries' | 'maxAge' | 'maxEntries'
> & {
  autoRetryInterval: number | string;
  maxAutoRetries: number | string;
  maxAge: number | string | null;
  maxEntries: number | string;
};

export function StallForm({
  queue,
  config,
  onSaved,
}: {
  queue: string;
  config: StallConfig;
  onSaved: () => void;
}) {
  const [c, setC] = useSyncedConfig<StallDraft>(config);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <Card>
      <CardHeader title="Stall detection" />
      <div className="grid grid-cols-2 gap-3">
        {/* Single accessible label: the Toggle already carries "enabled"
            (aria-label); the visual text is hidden from AT so screen readers
            don't announce it twice. */}
        <div className="col-span-2 flex items-center gap-2">
          <Toggle
            checked={c.enabled}
            onChange={(v) => setC({ ...c, enabled: v })}
            label="enabled"
          />
          <span className="text-sm text-muted" aria-hidden="true">
            enabled
          </span>
        </div>
        <Field label="Stall interval (ms)">
          <Input
            type="number"
            value={c.stallInterval}
            onChange={(e) => setC({ ...c, stallInterval: e.target.value })}
          />
        </Field>
        <Field label="Max stalls">
          <Input
            type="number"
            value={c.maxStalls}
            onChange={(e) => setC({ ...c, maxStalls: e.target.value })}
          />
        </Field>
        <Field label="Grace period (ms)">
          <Input
            type="number"
            value={c.gracePeriod}
            onChange={(e) => setC({ ...c, gracePeriod: e.target.value })}
          />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="accent"
          size="sm"
          disabled={saving}
          onClick={async () => {
            const stallInterval = toNum(c.stallInterval);
            const maxStalls = toNum(c.maxStalls);
            const gracePeriod = toNum(c.gracePeriod);
            if (stallInterval == null || maxStalls == null || gracePeriod == null) {
              setErr('All numeric fields must be filled in');
              return;
            }
            setSaving(true);
            setSaved(false);
            try {
              setErr(null);
              await bq.setStallConfig(queue, { ...c, stallInterval, maxStalls, gracePeriod });
              onSaved();
              setSaved(true);
              window.setTimeout(() => setSaved(false), 2000);
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          Save
        </Button>
        {saved && <span className="text-xs text-success">Saved ✓</span>}
        {err && <span className="text-xs text-danger">{err}</span>}
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
  const [c, setC] = useSyncedConfig<DlqDraft>(config);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
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
          <span className="text-sm text-muted" aria-hidden="true">
            auto-retry
          </span>
        </div>
        <Field label="Retry interval (ms)">
          <Input
            type="number"
            value={c.autoRetryInterval}
            onChange={(e) => setC({ ...c, autoRetryInterval: e.target.value })}
          />
        </Field>
        <Field label="Max auto-retries">
          <Input
            type="number"
            value={c.maxAutoRetries}
            onChange={(e) => setC({ ...c, maxAutoRetries: e.target.value })}
          />
        </Field>
        <Field label="Max age (ms)">
          <Input
            type="number"
            value={c.maxAge ?? ''}
            onChange={(e) => setC({ ...c, maxAge: e.target.value })}
          />
        </Field>
        <Field label="Max entries">
          <Input
            type="number"
            value={c.maxEntries}
            onChange={(e) => setC({ ...c, maxEntries: e.target.value })}
          />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="accent"
          size="sm"
          disabled={saving}
          onClick={async () => {
            const autoRetryInterval = toNum(c.autoRetryInterval);
            const maxAutoRetries = toNum(c.maxAutoRetries);
            const maxEntries = toNum(c.maxEntries);
            // maxAge is nullable — an empty field means "no max age", not invalid.
            const maxAge = c.maxAge == null ? null : toNum(c.maxAge);
            if (autoRetryInterval == null || maxAutoRetries == null || maxEntries == null) {
              setErr('All numeric fields must be filled in');
              return;
            }
            setSaving(true);
            setSaved(false);
            try {
              setErr(null);
              await bq.setDlqConfig(queue, {
                ...c,
                autoRetryInterval,
                maxAutoRetries,
                maxAge,
                maxEntries,
              });
              onSaved();
              setSaved(true);
              window.setTimeout(() => setSaved(false), 2000);
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          Save
        </Button>
        {saved && <span className="text-xs text-success">Saved ✓</span>}
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </Card>
  );
}
