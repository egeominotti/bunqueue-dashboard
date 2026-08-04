import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/form';
import { MAX_DURATION_MS, MAX_JOBS } from './constants';
import type { BulkFormValues, BulkResult, SetBulkFormValue } from './formTypes';

export function BulkTargetCard({
  values,
  setValue,
  queueNames,
  queueDiscoveryError,
  onRetryQueues,
  busy,
  parsedCount,
  parseError,
  validationOk,
  result,
  onSubmit,
}: {
  values: BulkFormValues;
  setValue: SetBulkFormValue;
  queueNames: string[];
  queueDiscoveryError: Error | null;
  onRetryQueues: () => void;
  busy: boolean;
  parsedCount: number;
  parseError: string | null;
  validationOk: boolean;
  result: BulkResult;
  onSubmit: () => void;
}) {
  return (
    <Card>
      <CardHeader title="Target & defaults" />
      <div className="flex flex-col gap-4">
        <Field label="Queue">
          <Input
            list="bulk-queue-options"
            aria-label="Queue"
            name="bulk-target-queue"
            autoComplete="off"
            value={values.queue}
            onChange={(event) => setValue('queue', event.target.value)}
            placeholder="queue name (existing or new)"
          />
          <datalist id="bulk-queue-options">
            {queueNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>
        {queueDiscoveryError && (
          <p role="status" className="-mt-2 text-xs text-warning">
            Existing queue suggestions unavailable — {queueDiscoveryError.message}. You can still
            enter a queue name manually.{' '}
            <button
              type="button"
              onClick={onRetryQueues}
              className="font-medium underline underline-offset-2 hover:text-fg"
            >
              Retry
            </button>
          </p>
        )}
        <p className="-mt-2 text-xs text-faint">Defaults below fill any field an item omits.</p>
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Priority"
            name="default-priority"
            value={values.priority}
            min={-1_000_000}
            max={1_000_000}
            placeholder="0"
            onChange={(value) => setValue('priority', value)}
          />
          <NumberField
            label="Max attempts"
            name="default-max-attempts"
            value={values.maxAttempts}
            min={1}
            max={1000}
            placeholder="3"
            onChange={(value) => setValue('maxAttempts', value)}
          />
          <NumberField
            label="Backoff (ms)"
            name="default-backoff"
            value={values.backoff}
            min={0}
            max={MAX_DURATION_MS}
            placeholder="1000"
            onChange={(value) => setValue('backoff', value)}
          />
          <NumberField
            label="Timeout (ms)"
            name="default-timeout"
            value={values.timeout}
            min={0}
            max={MAX_DURATION_MS}
            placeholder="—"
            onChange={(value) => setValue('timeout', value)}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="accent"
            disabled={
              busy ||
              parsedCount === 0 ||
              parsedCount > MAX_JOBS ||
              parseError != null ||
              !validationOk
            }
            onClick={onSubmit}
          >
            {busy ? 'Importing…' : `Import ${parsedCount || ''}`}
          </Button>
        </div>
        {result && (
          <span
            role={result.ok ? 'status' : 'alert'}
            className={result.ok ? 'text-sm text-success' : 'text-sm text-danger'}
          >
            {result.msg}
          </span>
        )}
      </div>
    </Card>
  );
}

function NumberField({
  label,
  name,
  value,
  min,
  max,
  placeholder,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  min: number;
  max: number;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        min={min}
        max={max}
        step={1}
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </Field>
  );
}
