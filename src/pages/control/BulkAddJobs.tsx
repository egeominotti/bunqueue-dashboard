import { useEffect, useMemo, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { PageHeader } from '@/components/ui/PageHeader';
import { bq } from '@/lib/bq';
import { usePolledData } from '@/lib/usePolledData';
import { useServerActionGuard } from '@/lib/useServerActionGuard';
import { queueNameError } from './addJob/options';
import { acceptedBulkIds } from './addJob/responses';
import { BulkJobsCard } from './bulkAdd/BulkJobsCard';
import { BulkTargetCard } from './bulkAdd/BulkTargetCard';
import { MAX_JOBS } from './bulkAdd/constants';
import type { BulkFormValues, BulkResult } from './bulkAdd/formTypes';
import {
  bulkInputBudgetError,
  bulkPayloadBudgetError,
  bulkSummary,
  parseInput,
} from './bulkAdd/input';
import { useBulkFileInput } from './bulkAdd/useBulkFileInput';
import { parseBulkDefaults, validateBulkItems } from './bulkAdd/validation';

export {
  asNum,
  asStr,
  type BulkDefaults,
  coerceBody,
  parseDedup,
  specWouldDropValues,
} from './bulkAdd/coercion';
export {
  MAX_BULK_INPUT_BYTES,
  MAX_BULK_INPUT_CHARS,
  MAX_BULK_PAYLOAD_BYTES,
} from './bulkAdd/constants';
export {
  bulkInputBudgetError,
  bulkPayloadBudgetError,
  bulkSummary,
  parseInput,
} from './bulkAdd/input';
export { bulkDependencyError, parseBulkDefaults, validateBulkItems } from './bulkAdd/validation';

const INITIAL_VALUES: BulkFormValues = {
  queue: '',
  text: '',
  mode: 'spec',
  priority: '',
  maxAttempts: '',
  backoff: '',
  timeout: '',
};

export function BulkAddJobs() {
  const {
    data: queues,
    error: queueDiscoveryError,
    refetch: refetchQueues,
  } = usePolledData(() => bq.queues(), [], { intervalMs: 30000 });
  const [values, setValues] = useState(INITIAL_VALUES);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkResult>(null);
  const actionGuard = useServerActionGuard('bulk-add-jobs');
  const setValue = <K extends keyof BulkFormValues>(key: K, value: BulkFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));
  const fileInput = useBulkFileInput({
    text: values.text,
    setText: (text) => setValue('text', text),
    setResult,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the connection lifecycle boundary
  useEffect(() => {
    setBusy(false);
    setResult(null);
  }, [actionGuard.scopeKey]);

  const parsed = useMemo(() => parseInput(values.text), [values.text]);
  const importValidation = useMemo(() => {
    if (parsed.error) return { ok: false as const, msg: parsed.error };
    if (parsed.items.length > MAX_JOBS) {
      return {
        ok: false as const,
        msg: `Too many jobs (${parsed.items.length}). Limit is ${MAX_JOBS}.`,
      };
    }
    const defaults = parseBulkDefaults(values);
    if (!defaults.ok) return defaults;
    return validateBulkItems(parsed.items, defaults.defaults, values.mode);
  }, [parsed, values]);

  const submit = async () => {
    setResult(null);
    const target = values.queue.trim();
    const invalidQueue = queueNameError(target);
    if (invalidQueue) {
      setResult({ ok: false, msg: invalidQueue });
      return;
    }
    const inputBudgetError = bulkInputBudgetError(values.text);
    if (inputBudgetError) {
      setResult({ ok: false, msg: inputBudgetError });
      return;
    }
    if (parsed.error) {
      setResult({ ok: false, msg: parsed.error });
      return;
    }
    if (parsed.items.length === 0) {
      setResult({ ok: false, msg: 'Nothing to enqueue — paste a JSON array or NDJSON.' });
      return;
    }
    if (parsed.items.length > MAX_JOBS) {
      setResult({
        ok: false,
        msg: `Too many jobs (${parsed.items.length}). Limit is ${MAX_JOBS}.`,
      });
      return;
    }
    if (!importValidation.ok) {
      setResult({ ok: false, msg: importValidation.msg });
      return;
    }
    const payloadError = bulkPayloadBudgetError(importValidation.bodies);
    if (payloadError) {
      setResult({ ok: false, msg: payloadError });
      return;
    }

    const lease = actionGuard.begin();
    if (!lease) return;
    setBusy(true);
    try {
      const response = await bq.addJobsBulk(target, importValidation.bodies);
      const ids = acceptedBulkIds(response, importValidation.bodies.length);
      if (!lease.isCurrent()) return;
      const summary = bulkSummary(new Set(ids).size, importValidation.bodies.length, target);
      setResult(summary);
      toast.success(summary.msg);
    } catch (caught) {
      if (!lease.isCurrent()) return;
      const message = (caught as Error).message;
      setResult({ ok: false, msg: message });
      toast.error('Bulk import failed', message);
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Bulk Add Jobs"
        description="Import many distinct jobs at once from a JSON array, NDJSON, or a file."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <BulkJobsCard
          values={values}
          setValue={setValue}
          parsedCount={parsed.items.length}
          parseError={parsed.error}
          validation={importValidation}
          onFile={fileInput.onFile}
          onBeforeTextChange={fileInput.cancelPending}
        />
        <BulkTargetCard
          values={values}
          setValue={setValue}
          queueNames={(queues?.queues ?? []).map((queue) => queue.name)}
          queueDiscoveryError={queueDiscoveryError}
          onRetryQueues={() => void refetchQueues()}
          busy={busy}
          parsedCount={parsed.items.length}
          parseError={parsed.error}
          validationOk={importValidation.ok}
          result={result}
          onSubmit={() => void submit()}
        />
      </div>
    </div>
  );
}
