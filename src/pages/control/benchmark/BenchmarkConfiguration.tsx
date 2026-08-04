import type { ChangeEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, SegmentedControl, Toggle } from '@/components/ui/form';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { LIMITS } from './engine';
import { BENCHMARK_MODES, type BenchmarkDraft, type BenchmarkNumKey } from './pageModel';

export function BenchmarkConfiguration({
  draft,
  active,
  cleaning,
  cleanResult,
  setField,
  numberInput,
  onClean,
}: {
  draft: BenchmarkDraft;
  active: boolean;
  cleaning: boolean;
  cleanResult: { remaining: number } | { error: string } | null;
  setField: <K extends keyof BenchmarkDraft>(key: K, value: BenchmarkDraft[K]) => void;
  numberInput: (key: BenchmarkNumKey) => (event: ChangeEvent<HTMLInputElement>) => void;
  onClean: () => void;
}) {
  return (
    <Card className="lg:col-span-1">
      <CardHeader title="Configuration" />
      <div className="flex flex-col gap-3">
        <Field
          label="Dedicated queue"
          hint="Cryptographically generated for this browser tab; production queue names cannot be entered here."
        >
          <Input
            name="benchmark-queue"
            autoComplete="off"
            value={draft.queue}
            readOnly
            aria-readonly="true"
          />
        </Field>
        <Field
          label="Mode"
          hint={
            draft.mode === 'count'
              ? 'Push a fixed number of jobs.'
              : 'Run producers + workers for a fixed time.'
          }
        >
          <SegmentedControl
            options={BENCHMARK_MODES}
            value={draft.mode}
            onChange={(mode) => setField('mode', mode)}
            disabled={active}
          />
        </Field>
        {draft.mode === 'count' ? (
          <Field label="Total jobs" hint={`max ${formatNumber(LIMITS.total)}`}>
            <Input
              name="benchmark-total"
              autoComplete="off"
              type="number"
              min={1}
              max={LIMITS.total}
              value={draft.total}
              disabled={active}
              onChange={numberInput('total')}
            />
          </Field>
        ) : (
          <Field label="Duration (s)" hint={`max ${LIMITS.durationS}s`}>
            <Input
              name="benchmark-duration-seconds"
              autoComplete="off"
              type="number"
              min={1}
              max={LIMITS.durationS}
              value={draft.durationS}
              disabled={active}
              onChange={numberInput('durationS')}
            />
          </Field>
        )}
        <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-faint">
          Producers
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Producers" hint={`parallel, max ${LIMITS.producers}`}>
            <Input
              name="benchmark-producers"
              autoComplete="off"
              type="number"
              min={1}
              max={LIMITS.producers}
              value={draft.producers}
              disabled={active}
              onChange={numberInput('producers')}
            />
          </Field>
          <Field label="Push batch" hint={`jobs/req, max ${LIMITS.batch}`}>
            <Input
              name="benchmark-push-batch"
              autoComplete="off"
              type="number"
              min={1}
              max={LIMITS.batch}
              value={draft.batch}
              disabled={active}
              onChange={numberInput('batch')}
            />
          </Field>
          <Field label="Payload" hint={`bytes/job, max ${formatNumber(LIMITS.payload)}`}>
            <Input
              name="benchmark-payload-bytes"
              autoComplete="off"
              type="number"
              min={0}
              max={LIMITS.payload}
              value={draft.payload}
              disabled={active}
              onChange={numberInput('payload')}
            />
          </Field>
        </div>
        <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-faint">
          Workers (simulated)
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Workers" hint={`0 = produce only, max ${LIMITS.workers}`}>
            <Input
              name="benchmark-workers"
              autoComplete="off"
              type="number"
              min={0}
              max={LIMITS.workers}
              value={draft.workers}
              disabled={active}
              onChange={numberInput('workers')}
            />
          </Field>
          <Field label="Pull batch" hint={`jobs/pull, max ${LIMITS.workerBatch}`}>
            <Input
              name="benchmark-pull-batch"
              autoComplete="off"
              type="number"
              min={1}
              max={LIMITS.workerBatch}
              value={draft.workerBatch}
              disabled={active}
              onChange={numberInput('workerBatch')}
            />
          </Field>
          <Field label="Process (ms)" hint="simulated work per pull">
            <Input
              name="benchmark-process-ms"
              autoComplete="off"
              type="number"
              min={0}
              max={LIMITS.processMs}
              value={draft.processMs}
              disabled={active}
              onChange={numberInput('processMs')}
            />
          </Field>
        </div>
        <ToggleRow
          label="Durable (fsync each job)"
          checked={draft.durable}
          active={active}
          onChange={(durable) => setField('durable', durable)}
        />
        <ToggleRow
          label="Remove on complete"
          checked={draft.removeOnComplete}
          active={active}
          onChange={(removeOnComplete) => setField('removeOnComplete', removeOnComplete)}
        />
        <div className="flex items-center gap-3 pt-1">
          <Button variant="ghost" size="sm" disabled={active || cleaning} onClick={onClean}>
            {cleaning ? 'Cleaning…' : 'Clean queue'}
          </Button>
          {cleanResult &&
            ('error' in cleanResult ? (
              <span className="text-xs text-danger">Clean unverified — {cleanResult.error}</span>
            ) : (
              <span
                className={cn(
                  'text-xs',
                  cleanResult.remaining > 0 ? 'text-warning' : 'text-success'
                )}
              >
                {cleanResult.remaining > 0
                  ? `Cleaned — ${formatNumber(cleanResult.remaining)} active job(s) remain (requeued after the stall timeout)`
                  : 'Cleaned — 0 jobs remain'}
              </span>
            ))}
        </div>
      </div>
    </Card>
  );
}

function ToggleRow({
  label,
  checked,
  active,
  onChange,
}: {
  label: string;
  checked: boolean;
  active: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Toggle checked={checked} onChange={onChange} disabled={active} label={label} />
      <span className="text-sm text-muted">{label}</span>
    </div>
  );
}
