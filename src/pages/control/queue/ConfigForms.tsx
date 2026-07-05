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
/** Order-insensitive value signature so a save's echo can be recognized
 *  regardless of the key order the server serializes it back in. */
function configSig(v: unknown): string {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return JSON.stringify(
      Object.keys(o)
        .sort()
        .map((k) => [k, o[k]])
    );
  }
  return JSON.stringify(v);
}

function useSyncedConfig<T>(config: T): [T, (v: T) => void, (saved: unknown) => void] {
  const [c, setC] = useState(config);
  const lastServer = useRef(configSig(config));
  useEffect(() => {
    const next = configSig(config);
    if (next !== lastServer.current) {
      lastServer.current = next;
      setC(config);
    }
  }, [config]);
  // Advance the baseline to a just-saved value so the server's echo of OUR OWN
  // save on the next poll isn't treated as an external change that wipes an
  // immediate re-edit (edit → Save → re-edit was clobbered within one poll).
  const markSaved = (saved: unknown) => {
    lastServer.current = configSig(saved);
  };
  return [c, setC, markSaved];
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
  const [c, setC, markSaved] = useSyncedConfig<StallDraft>(config);
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
              const payload = { ...c, stallInterval, maxStalls, gracePeriod };
              await bq.setStallConfig(queue, payload);
              markSaved(payload);
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
  const [c, setC, markSaved] = useSyncedConfig<DlqDraft>(config);
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
              const payload = { ...c, autoRetryInterval, maxAutoRetries, maxAge, maxEntries };
              await bq.setDlqConfig(queue, payload);
              markSaved(payload);
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

/**
 * Shown in place of a config form when its GET failed — the form must not
 * silently vanish (both QueueControl and QueueDetailPro render it on a null config).
 */
export function ConfigLoadError({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <Card>
      <CardHeader title={title} />
      <p className="mb-3 text-sm text-muted">Couldn't load this queue's config.</p>
      <Button size="sm" onClick={onRetry}>
        Retry
      </Button>
    </Card>
  );
}
