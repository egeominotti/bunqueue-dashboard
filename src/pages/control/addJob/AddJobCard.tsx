import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/form';
import { MAX_JOB_DATA_CHARS, parseJobData } from './data';
import type { AddJobFormValues, SetAddJobValue } from './formModel';

export function AddJobCard({
  values,
  setValue,
  queueNames,
  queueDiscoveryError,
  onRetryQueues,
  jsonError,
  setJsonError,
}: {
  values: AddJobFormValues;
  setValue: SetAddJobValue;
  queueNames: string[];
  queueDiscoveryError: Error | null;
  onRetryQueues: () => void;
  jsonError: string | null;
  setJsonError: (error: string | null) => void;
}) {
  return (
    <Card>
      <CardHeader title="Job" />
      <div className="flex flex-col gap-4">
        <Field label="Queue">
          <Input
            list="queue-options"
            aria-label="Queue"
            name="target-queue"
            autoComplete="off"
            value={values.queue}
            onChange={(event) => setValue('queue', event.target.value)}
            placeholder="queue name (existing or new)"
          />
          <datalist id="queue-options">
            {queueNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>
        <Field
          label="Job name"
          hint="Worker routing name in Bunqueue 2.9.3; separate from the JSON payload."
        >
          <Input
            name="job-name"
            autoComplete="off"
            maxLength={256}
            value={values.name}
            onChange={(event) => setValue('name', event.target.value)}
            placeholder="default"
          />
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
        <div>
          <Field label="Data (JSON)">
            <textarea
              name="job-data"
              value={values.dataText}
              onChange={(event) => setValue('dataText', event.target.value)}
              onBlur={() => {
                const parsed = parseJobData(values.dataText);
                setJsonError(parsed.ok ? null : parsed.msg);
              }}
              maxLength={MAX_JOB_DATA_CHARS}
              spellCheck={false}
              rows={7}
              className="w-full rounded-lg border border-line bg-surface-2 p-3 font-mono text-sm text-fg focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </Field>
          {jsonError && (
            <p role="alert" className="mt-2 text-xs text-danger">
              {jsonError}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
