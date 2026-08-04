import type { ChangeEvent } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { SegmentedControl } from '@/components/ui/form';
import { BULK_SAMPLE, MAX_BULK_INPUT_CHARS, MAX_JOBS } from './constants';
import type { BulkFormValues, SetBulkFormValue } from './formTypes';

export function BulkJobsCard({
  values,
  setValue,
  parsedCount,
  parseError,
  validation,
  onFile,
  onBeforeTextChange,
}: {
  values: BulkFormValues;
  setValue: SetBulkFormValue;
  parsedCount: number;
  parseError: string | null;
  validation: { ok: boolean; msg?: string };
  onFile: (event: ChangeEvent<HTMLInputElement>) => void;
  onBeforeTextChange: () => void;
}) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader
        title="Jobs"
        action={
          <label className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg">
            Upload file
            <input
              type="file"
              name="jobs-file"
              accept=".json,.ndjson,.txt,application/json"
              onChange={onFile}
              className="hidden"
            />
          </label>
        }
      />
      <textarea
        name="jobs-json"
        value={values.text}
        onChange={(event) => {
          onBeforeTextChange();
          setValue('text', event.target.value);
        }}
        maxLength={MAX_BULK_INPUT_CHARS}
        spellCheck={false}
        rows={16}
        placeholder={BULK_SAMPLE}
        aria-label="Jobs JSON"
        className="w-full rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
      <fieldset className="mt-3 flex flex-wrap items-center gap-3">
        <legend className="sr-only">Import interpretation</legend>
        <span aria-hidden="true" className="text-xs font-medium text-faint">
          Interpret each item as
        </span>
        <SegmentedControl
          options={['spec', 'raw'] as const}
          value={values.mode}
          onChange={(mode) => setValue('mode', mode)}
        />
        <span className="text-xs text-faint">
          {values.mode === 'spec'
            ? 'job spec: an object with a "data" key sets options from its sibling fields.'
            : 'raw data: the whole item becomes the job payload, untouched.'}
        </span>
      </fieldset>
      <p className="mt-2 text-xs text-faint">
        Accepts a JSON array, a single object, or newline-delimited JSON.
      </p>
      <div className="mt-2 text-sm">
        {parseError ? (
          <span role="alert" className="text-danger">
            {parseError}
          </span>
        ) : parsedCount > MAX_JOBS ? (
          <span role="alert" className="text-danger">
            Too many jobs ({parsedCount}). Limit is {MAX_JOBS}.
          </span>
        ) : parsedCount > 0 ? (
          <span className="text-success">{parsedCount} job(s) parsed ✓</span>
        ) : (
          <span className="text-faint">Nothing parsed yet.</span>
        )}
      </div>
      {!parseError && parsedCount > 0 && !validation.ok && (
        <p role="alert" className="mt-2 text-xs text-danger">
          Import blocked — {validation.msg}. Fix the spec or switch to “raw” when the whole object
          is job data.
        </p>
      )}
    </Card>
  );
}
