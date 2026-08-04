import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Toggle } from '@/components/ui/form';
import { bq } from '@/lib/bq';
import type { DlqConfig, StallConfig } from '@/lib/bqTypes';
import { FLOW_DLQ_RETENTION_UNAVAILABLE } from '@/lib/flowMutationSafety';
import {
  currentServerActionIdentity,
  type ServerActionLease,
  useServerActionGuard,
} from '@/lib/useServerActionGuard';

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
export function configSig(v: unknown): string {
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

export function useSyncedConfig<T>(config: T): [T, (v: T) => void, () => (saved: unknown) => void] {
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
  //
  // Called BEFORE the request so it can capture the baseline as it was then: if
  // the 3s poll re-seeded the form mid-save (an external change), that value is
  // what the user is now looking at and it is authoritative — advancing to our
  // payload would strand the form on a value the server does not have and stop
  // it ever adopting server state again.
  const beginSave = () => {
    const base = lastServer.current;
    return (saved: unknown) => {
      if (lastServer.current === base) lastServer.current = configSig(saved);
    };
  };
  return [c, setC, beginSave];
}

/** Numeric inputs stay as typed, but v2.8.55 policy values are whole numbers. */
function toSafeWhole(v: number | string, min: number): number | null {
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

/** Editable copy of StallConfig where numeric fields may hold in-progress text. */
export type StallDraft = Omit<StallConfig, 'stallInterval' | 'maxStalls' | 'gracePeriod'> & {
  stallInterval: number | string;
  maxStalls: number | string;
  gracePeriod: number | string;
};

/** Editable copy of DlqConfig where numeric fields may hold in-progress text. */
export type DlqDraft = Omit<
  DlqConfig,
  'autoRetryInterval' | 'maxAutoRetries' | 'maxAge' | 'maxEntries'
> & {
  autoRetryInterval: number | string;
  maxAutoRetries: number | string;
  maxAge: number | string | null;
  maxEntries: number | string;
};

export type ConfigValidation<T> = { ok: true; value: T } | { ok: false; error: string };

export function stallConfigPayload(c: StallDraft): ConfigValidation<StallConfig> {
  const stallInterval = toSafeWhole(c.stallInterval, 0);
  const maxStalls = toSafeWhole(c.maxStalls, 0);
  const gracePeriod = toSafeWhole(c.gracePeriod, 0);
  if (stallInterval === null || maxStalls === null || gracePeriod === null) {
    return {
      ok: false,
      error: 'Stall interval, max stalls, and grace period must be non-negative whole numbers.',
    };
  }
  return { ok: true, value: { enabled: c.enabled, stallInterval, maxStalls, gracePeriod } };
}

export function dlqConfigPayload(c: DlqDraft): ConfigValidation<DlqConfig> {
  const autoRetryInterval = toSafeWhole(c.autoRetryInterval, 0);
  const maxAutoRetries = toSafeWhole(c.maxAutoRetries, 0);
  const maxEntries = toSafeWhole(c.maxEntries, 1);
  const maxAgeRaw = c.maxAge == null ? '' : String(c.maxAge).trim();
  const maxAge = maxAgeRaw === '' ? null : toSafeWhole(maxAgeRaw, 0);
  if (
    autoRetryInterval === null ||
    maxAutoRetries === null ||
    maxEntries === null ||
    (maxAgeRaw !== '' && maxAge === null)
  ) {
    return {
      ok: false,
      error: 'DLQ values must be non-negative whole numbers; max entries must be at least 1.',
    };
  }
  return {
    ok: true,
    value: { autoRetry: c.autoRetry, autoRetryInterval, maxAutoRetries, maxAge, maxEntries },
  };
}

export type MutableDlqConfig = Pick<
  DlqConfig,
  'autoRetry' | 'autoRetryInterval' | 'maxAutoRetries'
>;

/**
 * v2.8.55 cannot apply retention changes without potentially deleting a flow
 * child. Only the non-retention keys are ever projected into a dashboard PUT.
 */
export function dlqConfigMutationPayload(c: DlqDraft): ConfigValidation<MutableDlqConfig> {
  const autoRetryInterval = toSafeWhole(c.autoRetryInterval, 0);
  const maxAutoRetries = toSafeWhole(c.maxAutoRetries, 0);
  if (autoRetryInterval === null || maxAutoRetries === null) {
    return {
      ok: false,
      error: 'Retry interval and max auto-retries must be non-negative whole numbers.',
    };
  }
  return {
    ok: true,
    value: { autoRetry: c.autoRetry, autoRetryInterval, maxAutoRetries },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isStallConfig(value: unknown): value is StallConfig {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    isFiniteNumber(value.stallInterval) &&
    isFiniteNumber(value.maxStalls) &&
    isFiniteNumber(value.gracePeriod)
  );
}

export function isDlqConfig(value: unknown): value is DlqConfig {
  return (
    isRecord(value) &&
    typeof value.autoRetry === 'boolean' &&
    isFiniteNumber(value.autoRetryInterval) &&
    isFiniteNumber(value.maxAutoRetries) &&
    (value.maxAge === null || isFiniteNumber(value.maxAge)) &&
    isFiniteNumber(value.maxEntries)
  );
}

function assertMutationResponse(value: unknown, endpoint: string): void {
  if (!isRecord(value) || value.ok !== true) {
    throw new Error(`Malformed ${endpoint} response: expected { ok: true }.`);
  }
}

function useSaveGuard(ownerKey: string) {
  const { scopeKey, begin } = useServerActionGuard(ownerKey);
  const active = useRef<ServerActionLease | null>(null);
  const savedTimer = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is intentionally a reset trigger.
  useEffect(() => {
    // The same queue name can exist on another URL/token. Reset all visible
    // state immediately when that mutation scope changes; the old lease is
    // invalidated synchronously by useServerActionGuard's store subscription.
    active.current = null;
    setSaving(false);
    setSaved(false);
    if (savedTimer.current !== null) {
      window.clearTimeout(savedTimer.current);
      savedTimer.current = null;
    }
    // useServerActionGuard invalidates leases synchronously. Mirror that
    // invalidation into visible state as well, including an A→B→A connection
    // switch batched into one React render (where scopeKey ends unchanged).
    let connectionIdentity = currentServerActionIdentity();
    const unsubscribe = useConnectionStore.subscribe(() => {
      const nextIdentity = currentServerActionIdentity();
      if (nextIdentity === connectionIdentity) return;
      connectionIdentity = nextIdentity;
      active.current = null;
      setSaving(false);
      setSaved(false);
      if (savedTimer.current !== null) {
        window.clearTimeout(savedTimer.current);
        savedTimer.current = null;
      }
    });
    return () => {
      // Prevent a late completion from updating state after unmount or after
      // React starts switching this form to another server/queue scope.
      active.current = null;
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      unsubscribe();
    };
  }, [scopeKey]);

  const start = () => {
    const lease = begin('save');
    if (!lease) return null;
    active.current = lease;
    setSaving(true);
    setSaved(false);
    return lease;
  };
  const finish = (lease: ServerActionLease) => {
    lease.finish();
    if (active.current === lease) {
      active.current = null;
      // A lease may become stale while it is still the last request owned by
      // this mounted form. It must still release the local saving indicator;
      // the active-lease identity prevents an older completion from clearing a
      // newer request's state.
      setSaving(false);
    }
  };
  const showSaved = (lease: ServerActionLease) => {
    if (active.current !== lease || !lease.isCurrent()) return;
    setSaved(true);
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => {
      if (lease.isCurrent()) setSaved(false);
      savedTimer.current = null;
    }, 2000);
  };

  return { scopeKey, saving, saved, start, finish, showSaved };
}

export function StallForm({
  queue,
  config,
  onSaved,
}: {
  queue: string;
  config: StallConfig;
  onSaved: () => void | Promise<void>;
}) {
  const [c, setC, beginSave] = useSyncedConfig<StallDraft>(config);
  const [err, setErr] = useState<string | null>(null);
  const save = useSaveGuard(`stall-config:${queue}`);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new target must clear the old target's error.
  useEffect(() => setErr(null), [save.scopeKey]);
  const payload = stallConfigPayload(c);
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
            name="stall-interval-ms"
            autoComplete="off"
            type="number"
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            value={c.stallInterval}
            onChange={(e) => setC({ ...c, stallInterval: e.target.value })}
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
            value={c.maxStalls}
            onChange={(e) => setC({ ...c, maxStalls: e.target.value })}
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
            value={c.gracePeriod}
            onChange={(e) => setC({ ...c, gracePeriod: e.target.value })}
          />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="accent"
          size="sm"
          disabled={save.saving || !payload.ok}
          onClick={async () => {
            if (!payload.ok) return;
            const lease = save.start();
            if (!lease) return;
            try {
              setErr(null);
              const markSaved = beginSave();
              const response = await bq.setStallConfig(queue, payload.value);
              assertMutationResponse(response, '/stall-config');
              if (!lease.isCurrent()) return;
              markSaved(payload.value);
              await onSaved();
              save.showSaved(lease);
            } catch (e) {
              if (lease.isCurrent()) setErr((e as Error).message);
            } finally {
              save.finish(lease);
            }
          }}
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
        {err && (
          <span role="alert" className="text-xs text-danger">
            {err}
          </span>
        )}
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
  onSaved: () => void | Promise<void>;
}) {
  const [c, setC, beginSave] = useSyncedConfig<DlqDraft>(config);
  const [err, setErr] = useState<string | null>(null);
  const save = useSaveGuard(`dlq-config:${queue}`);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new target must clear the old target's error.
  useEffect(() => setErr(null), [save.scopeKey]);
  const payload = dlqConfigMutationPayload(c);
  const enablingAutoRetry = payload.ok && payload.value.autoRetry;
  return (
    <Card>
      <CardHeader title="DLQ policy" />
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 flex items-center gap-2">
          <Toggle
            checked={c.autoRetry}
            disabled={!c.autoRetry}
            onChange={(v) => setC({ ...c, autoRetry: v })}
            label="auto-retry"
          />
          <span className="text-sm text-muted" aria-hidden="true">
            auto-retry
          </span>
        </div>
        <p className="col-span-2 text-xs text-warning">
          Auto-retry can only be disabled. Bunqueue v2.8.57 cannot prove that a DLQ entry has no
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
            value={c.autoRetryInterval}
            onChange={(e) => setC({ ...c, autoRetryInterval: e.target.value })}
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
            value={c.maxAutoRetries}
            onChange={(e) => setC({ ...c, maxAutoRetries: e.target.value })}
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
            value={c.maxAge ?? ''}
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
            value={c.maxEntries}
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
          onClick={async () => {
            if (!payload.ok) return;
            const lease = save.start();
            if (!lease) return;
            try {
              setErr(null);
              const markSaved = beginSave();
              const response = await bq.setDlqConfig(queue, payload.value);
              assertMutationResponse(response, '/dlq-config');
              if (!lease.isCurrent()) return;
              markSaved({ ...c, ...payload.value });
              await onSaved();
              save.showSaved(lease);
            } catch (e) {
              if (lease.isCurrent()) setErr((e as Error).message);
            } finally {
              save.finish(lease);
            }
          }}
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
        {err && (
          <span role="alert" className="text-xs text-danger">
            {err}
          </span>
        )}
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
