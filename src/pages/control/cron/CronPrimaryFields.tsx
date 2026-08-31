import { Field, Input, SegmentedControl } from '@/components/ui/form';
import { cn } from '@/lib/cn';
import { nextCronRuns } from '@/lib/cronPreview';
import { formatDateTime } from '@/lib/format';
import { MAX_JOB_DATA_CHARS } from '../AddJob';
import { type CronFormValues, everyPreview, MAX_DELAY_MS, type SetCronFormValue } from './model';

export function CronPrimaryFields({
  values,
  setValue,
}: {
  values: CronFormValues;
  setValue: SetCronFormValue;
}) {
  const preview =
    values.mode === 'cron' && values.schedule.trim()
      ? nextCronRuns(values.schedule.trim(), 3, Date.now())
      : null;
  const intervalPreview = everyPreview(values.every);

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input
            name="cron-name"
            autoComplete="off"
            maxLength={256}
            value={values.name}
            onChange={(event) => setValue('name', event.target.value)}
            placeholder="daily-report"
          />
        </Field>
        <Field label="Queue">
          <Input
            name="cron-queue"
            autoComplete="off"
            maxLength={256}
            value={values.queue}
            onChange={(event) => setValue('queue', event.target.value)}
            placeholder="reports"
          />
        </Field>
        <Field
          label="Spawned job name"
          hint="First-class worker routing name; separate from schedule data."
        >
          <Input
            name="cron-job-name"
            autoComplete="off"
            maxLength={256}
            value={values.jobName}
            onChange={(event) => setValue('jobName', event.target.value)}
            placeholder="default"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <fieldset>
          <legend className="sr-only">Schedule type</legend>
          <SegmentedControl
            options={['cron', 'every'] as const}
            value={values.mode}
            onChange={(mode) => setValue('mode', mode)}
          />
        </fieldset>
        {values.mode === 'cron' ? (
          <div className="min-w-56 flex-1">
            <Field
              label="Cron expression"
              hint="Standard 5-field syntax, 6 fields with leading seconds, or an official @hourly/@daily-style shortcut. Croner extensions L/W/#/? are rejected by Bunqueue 2.9."
            >
              <Input
                name="cron-expression"
                value={values.schedule}
                onChange={(event) => setValue('schedule', event.target.value)}
                placeholder="0 9 * * *"
              />
            </Field>
          </div>
        ) : (
          <>
            <div className="w-40">
              <Field label="Every (ms)">
                <Input
                  type="number"
                  min={1}
                  max={MAX_DELAY_MS}
                  step={1}
                  name="cron-interval"
                  value={values.every}
                  onChange={(event) => setValue('every', event.target.value)}
                  placeholder="30000"
                />
              </Field>
            </div>
            {values.every.trim() !== '' && (
              <span className={cn('pb-2 text-xs', intervalPreview ? 'text-muted' : 'text-danger')}>
                {intervalPreview ?? 'not a valid interval'}
              </span>
            )}
          </>
        )}
      </div>

      {values.mode === 'cron' && values.schedule.trim() && preview && (
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs">
          {preview.valid ? (
            preview.runs.length ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-faint">
                  Next runs{values.timezone.trim() ? ' (local)' : ''}:
                </span>
                {preview.runs.map((run) => (
                  <span key={run} className="font-mono text-muted">
                    {formatDateTime(run)}
                  </span>
                ))}
                {values.timezone.trim() && (
                  <span className="text-faint">— server evaluates in {values.timezone.trim()}</span>
                )}
              </div>
            ) : (
              <span className="text-warning">Valid, but no runs in the next few years.</span>
            )
          ) : (
            <span className="text-warning">
              Unsupported expression: {preview.error} Fix it before creating the schedule.
            </span>
          )}
        </div>
      )}

      <Field label="Data (JSON)">
        <textarea
          name="cron-data"
          value={values.dataText}
          onChange={(event) => setValue('dataText', event.target.value)}
          maxLength={MAX_JOB_DATA_CHARS}
          rows={3}
          spellCheck={false}
          className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm text-fg placeholder:text-faint transition-colors focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
      </Field>
    </>
  );
}
