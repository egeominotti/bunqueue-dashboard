import { Field, Input, Toggle } from '@/components/ui/form';
import { type CronFormValues, MAX_DELAY_MS, MAX_DURATION_MS, type SetCronFormValue } from './model';

export function CronAdvancedFields({
  values,
  setValue,
}: {
  values: CronFormValues;
  setValue: SetCronFormValue;
}) {
  return (
    <div id="cron-advanced-options" className="mt-3 grid grid-cols-2 gap-3">
      <Field label="Timezone (IANA)" hint="e.g. Europe/Rome. Default: server timezone.">
        <Input
          name="cron-timezone"
          autoComplete="off"
          value={values.timezone}
          onChange={(event) => setValue('timezone', event.target.value)}
          placeholder="Europe/Rome"
        />
      </Field>
      <Field label="Priority">
        <Input
          type="number"
          min={-1_000_000}
          max={1_000_000}
          step={1}
          name="cron-priority"
          value={values.priority}
          onChange={(event) => setValue('priority', event.target.value)}
          placeholder="0"
        />
      </Field>
      <Field label="Max executions" hint="blank = unlimited">
        <Input
          type="number"
          min={1}
          max={Number.MAX_SAFE_INTEGER}
          step={1}
          name="cron-max-executions"
          value={values.maxLimit}
          onChange={(event) => setValue('maxLimit', event.target.value)}
          placeholder="∞"
        />
      </Field>
      <Field label="Unique key" hint="optional deduplication key">
        <Input
          name="cron-unique-key"
          autoComplete="off"
          maxLength={1024}
          value={values.uniqueKey}
          onChange={(event) => setValue('uniqueKey', event.target.value)}
          placeholder="daily-report"
        />
      </Field>
      <div className="col-span-2 flex flex-wrap gap-6">
        <ToggleField
          label="prevent overlap"
          checked={values.preventOverlap}
          onChange={(checked) => setValue('preventOverlap', checked)}
        />
        <ToggleField
          label="skip if no worker"
          checked={values.skipIfNoWorker}
          onChange={(checked) => setValue('skipIfNoWorker', checked)}
        />
        <ToggleField
          label="run immediately"
          checked={values.immediately}
          onChange={(checked) => setValue('immediately', checked)}
        />
        <ToggleField
          label="skip missed on restart"
          checked={values.skipMissedOnRestart}
          onChange={(checked) => setValue('skipMissedOnRestart', checked)}
        />
      </div>

      <div className="col-span-2">
        <div className="mb-2 text-[11px] uppercase tracking-wider text-faint">
          Cron deduplication
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Dedup TTL (ms)" hint="blank = no TTL">
            <Input
              type="number"
              min={1}
              max={MAX_DELAY_MS}
              step={1}
              name="cron-dedup-ttl"
              value={values.dedupTtl}
              onChange={(event) => setValue('dedupTtl', event.target.value)}
              placeholder="60000"
            />
          </Field>
          <ToggleField
            className="items-end pb-2"
            label="extend TTL"
            controlLabel="extend dedup TTL"
            checked={values.dedupExtend}
            onChange={(checked) => setValue('dedupExtend', checked)}
          />
          <ToggleField
            className="items-end pb-2"
            label="replace duplicate"
            checked={values.dedupReplace}
            onChange={(checked) => setValue('dedupReplace', checked)}
          />
        </div>
      </div>

      <div className="col-span-2">
        <div className="mb-2 text-[11px] uppercase tracking-wider text-faint">
          Spawned-job options
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <NumberField
            label="Max attempts"
            name="cron-job-max-attempts"
            value={values.jobMaxAttempts}
            min={1}
            max={1000}
            placeholder="3"
            onChange={(value) => setValue('jobMaxAttempts', value)}
          />
          <NumberField
            label="Backoff (ms)"
            name="cron-job-backoff"
            value={values.jobBackoff}
            min={0}
            max={MAX_DURATION_MS}
            placeholder="1000"
            onChange={(value) => setValue('jobBackoff', value)}
          />
          <NumberField
            label="Timeout (ms)"
            name="cron-job-timeout"
            value={values.jobTimeout}
            min={0}
            max={MAX_DURATION_MS}
            placeholder="—"
            onChange={(value) => setValue('jobTimeout', value)}
          />
          <NumberField
            label="Delay (ms)"
            name="cron-job-delay"
            value={values.jobDelay}
            min={0}
            max={MAX_DELAY_MS}
            placeholder="0"
            onChange={(value) => setValue('jobDelay', value)}
          />
          <NumberField
            label="Stall timeout (ms)"
            name="cron-job-stall-timeout"
            value={values.jobStallTimeout}
            min={0}
            max={MAX_DURATION_MS}
            placeholder="server default"
            onChange={(value) => setValue('jobStallTimeout', value)}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-6">
          <ToggleField
            label="remove on complete"
            controlLabel="remove spawned jobs on complete"
            checked={values.jobRemoveOnComplete}
            onChange={(checked) => setValue('jobRemoveOnComplete', checked)}
          />
          <ToggleField
            label="remove on fail"
            controlLabel="remove spawned jobs on fail"
            checked={values.jobRemoveOnFail}
            onChange={(checked) => setValue('jobRemoveOnFail', checked)}
          />
        </div>
      </div>
    </div>
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

function ToggleField({
  label,
  controlLabel = label,
  checked,
  onChange,
  className = 'items-center',
}: {
  label: string;
  controlLabel?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}) {
  return (
    <div className={`flex gap-2 ${className}`}>
      <Toggle checked={checked} onChange={onChange} label={controlLabel} />
      <span className="text-sm text-muted">{label}</span>
    </div>
  );
}
