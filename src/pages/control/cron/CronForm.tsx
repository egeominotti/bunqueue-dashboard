import { useEffect, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button } from '@/components/ui/Button';
import type { CreateCronBody } from '@/lib/bq';
import type { ServerActionLease } from '@/lib/useServerActionGuard';
import { CronAdvancedFields } from './CronAdvancedFields';
import { CronPrimaryFields } from './CronPrimaryFields';
import { useTransientFlag } from './hooks';
import {
  assertCronCreateResponse,
  buildCronBody,
  type CronFormValues,
  existingCronNameError,
} from './model';

const INITIAL_VALUES: CronFormValues = {
  name: '',
  jobName: 'default',
  queue: '',
  mode: 'cron',
  schedule: '',
  every: '',
  dataText: '{}',
  timezone: '',
  priority: '',
  preventOverlap: true,
  skipIfNoWorker: false,
  maxLimit: '',
  immediately: false,
  skipMissedOnRestart: true,
  uniqueKey: '',
  dedupTtl: '',
  dedupExtend: false,
  dedupReplace: false,
  jobMaxAttempts: '',
  jobBackoff: '',
  jobTimeout: '',
  jobDelay: '',
  jobStallTimeout: '',
  jobRemoveOnComplete: false,
  jobRemoveOnFail: false,
};

export function CronForm({
  onCreate,
  onAccepted,
  beginCreate,
  scopeKey,
  existingNames,
}: {
  onCreate: (body: CreateCronBody, isCurrent: () => boolean) => Promise<unknown>;
  onAccepted: () => void;
  beginCreate: (name: string) => ServerActionLease | null;
  scopeKey: string;
  existingNames: ReadonlySet<string>;
}) {
  const [values, setValues] = useState(INITIAL_VALUES);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { on: created, fire: fireCreated, reset: resetCreated } = useTransientFlag(3000);
  const setValue = <K extends keyof CronFormValues>(key: K, value: CronFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  // scopeKey is the lifecycle boundary.
  /* oxlint-disable react/exhaustive-deps -- scopeKey alone defines this reset lifecycle */
  useEffect(() => {
    setBusy(false);
    setError(null);
    resetCreated();
  }, [scopeKey]);
  /* oxlint-enable react/exhaustive-deps */

  const nameConflict = existingCronNameError(values.name, existingNames);
  const submit = async () => {
    setError(null);
    resetCreated();
    const built = buildCronBody(values);
    if (!built.ok) {
      setError(built.msg);
      return;
    }
    const conflict = existingCronNameError(built.body.name, existingNames);
    if (conflict) {
      setError(conflict);
      return;
    }
    if (
      !window.confirm(
        `Submit an upsert for cron "${built.body.name}"? Bunqueue v2.8.59 has no atomic create-only condition. The dashboard will recheck immediately before writing, but another client using the same name at the same time could still be replaced. Continue only if you authorize last-writer-wins behavior for this globally unique name.`
      )
    ) {
      return;
    }

    const lease = beginCreate(built.body.name);
    if (!lease) return;
    setBusy(true);
    try {
      const response = await onCreate(built.body, lease.isCurrent);
      assertCronCreateResponse(response, built.body);
      if (!lease.isCurrent()) return;
      setValues((current) => ({ ...current, name: '', schedule: '', every: '' }));
      fireCreated();
      toast.success('Cron upsert acknowledged', built.body.name);
      onAccepted();
    } catch (caught) {
      if (lease.isCurrent()) setError((caught as Error).message);
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <CronPrimaryFields values={values} setValue={setValue} />
      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((visible) => !visible)}
          aria-expanded={showAdvanced}
          aria-controls="cron-advanced-options"
          className="text-xs font-medium text-muted hover:text-fg"
        >
          {showAdvanced ? '− Hide advanced' : '+ Advanced options'}
        </button>
        {showAdvanced && <CronAdvancedFields values={values} setValue={setValue} />}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="accent" size="sm" disabled={busy || !!nameConflict}>
          {busy ? 'Saving…' : nameConflict ? 'Name already exists' : 'Submit upsert'}
        </Button>
        {nameConflict && !error && (
          <span role="alert" className="max-w-2xl text-xs text-warning">
            {nameConflict}
          </span>
        )}
        {error && (
          <span role="alert" className="text-xs text-danger">
            {error}
          </span>
        )}
        {created && (
          <span role="status" className="text-xs text-success">
            Cron upsert acknowledged ✓
          </span>
        )}
      </div>
      <p className="text-xs text-warning">
        Creation is an upstream upsert, not an atomic create-only operation. Use a globally unique
        name; the fail-closed preflight cannot eliminate a simultaneous write from another client.
      </p>
    </form>
  );
}
