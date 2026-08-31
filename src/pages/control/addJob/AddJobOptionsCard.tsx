import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Select, Toggle } from '@/components/ui/form';
import type { AddJobFormValues, SetAddJobValue } from './formModel';
import { MAX_DELAY_MS, MAX_DURATION_MS } from './options';

export function AddJobOptionsCard({
  values,
  setValue,
}: {
  values: AddJobFormValues;
  setValue: SetAddJobValue;
}) {
  return (
    <Card>
      <CardHeader title="Options" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <NumberField
          label="Priority"
          name="priority"
          value={values.priority}
          min={-1_000_000}
          max={1_000_000}
          placeholder="0"
          onChange={(value) => setValue('priority', value)}
        />
        <NumberField
          label="Delay (ms)"
          name="delay"
          value={values.delay}
          min={0}
          max={MAX_DELAY_MS}
          placeholder="0"
          disabled={values.runAt.trim() !== ''}
          onChange={(value) => setValue('delay', value)}
        />
        <Field
          label="Run at"
          hint={
            values.runAt.trim()
              ? 'Overrides Delay — derived from this time (local time).'
              : '(local time)'
          }
        >
          <Input
            type="datetime-local"
            name="run-at"
            value={values.runAt}
            onChange={(event) => setValue('runAt', event.target.value)}
          />
        </Field>
        <NumberField
          label="Max attempts"
          hint="blank = server default"
          name="max-attempts"
          value={values.maxAttempts}
          min={1}
          max={1000}
          placeholder="3"
          onChange={(value) => setValue('maxAttempts', value)}
        />
        <NumberField
          label="Backoff (ms)"
          hint="blank = server default"
          name="backoff"
          value={values.backoff}
          min={0}
          max={MAX_DURATION_MS}
          placeholder="1000"
          onChange={(value) => setValue('backoff', value)}
        />
        <Field label="Backoff strategy" hint="flat delay unless set">
          <Select
            name="backoff-strategy"
            value={values.backoffType}
            onChange={(event) =>
              setValue('backoffType', event.target.value as AddJobFormValues['backoffType'])
            }
          >
            <option value="">flat</option>
            <option value="fixed">fixed</option>
            <option value="exponential">exponential</option>
          </Select>
        </Field>
        <NumberField
          label="Timeout (ms)"
          name="timeout"
          value={values.timeout}
          min={0}
          max={MAX_DURATION_MS}
          placeholder="—"
          onChange={(value) => setValue('timeout', value)}
        />
        <NumberField
          label="TTL (ms)"
          hint="blank = no expiry"
          name="ttl"
          value={values.ttl}
          min={0}
          max={MAX_DELAY_MS}
          placeholder="—"
          onChange={(value) => setValue('ttl', value)}
        />
        <Field label="Custom job ID">
          <Input
            name="custom-job-id"
            value={values.jobId}
            onChange={(event) => setValue('jobId', event.target.value)}
            placeholder="idempotency key"
          />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap gap-6">
        <ToggleRow
          label="removeOnComplete"
          checked={values.removeOnComplete}
          onChange={(checked) => setValue('removeOnComplete', checked)}
        />
        <ToggleRow
          label="removeOnFail"
          checked={values.removeOnFail}
          onChange={(checked) => setValue('removeOnFail', checked)}
        />
        <ToggleRow
          label="durable"
          checked={values.durable}
          onChange={(checked) => setValue('durable', checked)}
        />
        <ToggleRow
          label="lifo"
          checked={values.lifo}
          onChange={(checked) => setValue('lifo', checked)}
        />
      </div>
      <AdvancedOptions values={values} setValue={setValue} />
    </Card>
  );
}

function AdvancedOptions({
  values,
  setValue,
}: {
  values: AddJobFormValues;
  setValue: SetAddJobValue;
}) {
  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="mb-3 text-[11px] uppercase tracking-wider text-faint">Advanced</div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <TextField
          label="Tags"
          hint="comma-separated"
          name="tags"
          value={values.tags}
          placeholder="email, urgent"
          onChange={(value) => setValue('tags', value)}
        />
        <TextField
          label="Group ID"
          name="group-id"
          value={values.groupId}
          placeholder="—"
          onChange={(value) => setValue('groupId', value)}
        />
        <TextField
          label="Unique key"
          hint="dedup key"
          name="unique-key"
          value={values.uniqueKey}
          placeholder="—"
          onChange={(value) => setValue('uniqueKey', value)}
        />
        <TextField
          label="Depends on"
          hint="parent job ids, comma-separated"
          name="depends-on"
          value={values.dependsOn}
          placeholder="job-id-1, job-id-2"
          onChange={(value) => setValue('dependsOn', value)}
        />
        <div className="col-span-2 md:col-span-3">
          <Field
            label="Repeat policy (JSON)"
            hint='v2.9.2-safe form: e.g. {"every":60000,"limit":10}. Use Cron Manager for cron patterns.'
          >
            <textarea
              name="repeat-policy"
              value={values.repeatText}
              onChange={(event) => setValue('repeatText', event.target.value)}
              rows={2}
              spellCheck={false}
              placeholder='{"every": 60000}'
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </Field>
        </div>
      </div>
    </div>
  );
}

function TextField({
  label,
  hint,
  name,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  hint?: string;
  name: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </Field>
  );
}

function NumberField({
  label,
  hint,
  name,
  value,
  min,
  max,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  name: string;
  value: string;
  min: number;
  max: number;
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={min}
        max={max}
        step={1}
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
    </Field>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Toggle checked={checked} onChange={onChange} label={label} />
      <span className="font-mono text-xs text-muted">{label}</span>
    </div>
  );
}
