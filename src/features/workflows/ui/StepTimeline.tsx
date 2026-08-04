import { StatusBadge } from '@/components/ui/StatusBadge';
import type { WorkflowStepRecord } from '@/lib/bqTypes';
import { formatDateTime, formatDuration } from '@/lib/format';
import { JsonBlock } from './WorkflowValue';

export function StepTimeline({
  steps,
  onSelect,
}: {
  steps: Record<string, WorkflowStepRecord>;
  onSelect: (id: string) => void;
}) {
  const entries = Object.entries(steps);
  if (entries.length === 0) return <p className="text-xs text-faint">No persisted step records.</p>;
  return (
    <ol className="space-y-3">
      {entries.map(([name, step], index) => (
        <StepItem
          key={name}
          name={name}
          step={step}
          last={index === entries.length - 1}
          onSelect={onSelect}
        />
      ))}
    </ol>
  );
}

function StepItem({
  name,
  step,
  last,
  onSelect,
}: {
  name: string;
  step: WorkflowStepRecord;
  last: boolean;
  onSelect: (id: string) => void;
}) {
  const duration =
    step.startedAt !== undefined && step.completedAt !== undefined
      ? step.completedAt - step.startedAt
      : undefined;
  return (
    <li className="relative grid grid-cols-[18px_1fr] gap-3">
      <div className="flex flex-col items-center" aria-hidden="true">
        <span className="mt-1 size-2.5 rounded-full bg-current text-accent" />
        {!last && <span className="mt-1 w-px flex-1 bg-line" />}
      </div>
      <div className="min-w-0 rounded-lg border border-line bg-surface-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span translate="no" className="break-all font-mono text-sm font-medium text-fg">
            {name}
          </span>
          <StatusBadge status={step.status} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint">
          {step.attempts !== undefined && (
            <span>
              {step.attempts} attempt{step.attempts === 1 ? '' : 's'}
            </span>
          )}
          {duration !== undefined && <span>{formatDuration(duration)}</span>}
          {step.occurrence !== undefined && <span>Occurrence {step.occurrence}</span>}
          {step.loopIndex !== undefined && <span>Loop index {step.loopIndex}</span>}
          {step.compensatable && <span>Compensatable</span>}
        </div>
        {step.idempotencyKey && (
          <div className="mt-2 break-all font-mono text-[11px] text-faint">
            Idempotency: {step.idempotencyKey}
          </div>
        )}
        {step.childExecutionId && (
          <button
            type="button"
            onClick={() => onSelect(step.childExecutionId as string)}
            className="mt-2 break-all font-mono text-xs text-accent hover:underline"
          >
            Child execution: {step.childExecutionId}
          </button>
        )}
        {step.error && (
          <p role="alert" className="mt-2 whitespace-pre-wrap text-xs text-danger">
            {step.error}
          </p>
        )}
        {step.compensation && (
          <div className="mt-3 rounded-md border border-line px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-faint">Compensation</span>
              <StatusBadge status={step.compensation.status} />
              <span className="text-faint">{formatDateTime(step.compensation.at)}</span>
            </div>
            {step.compensation.error && (
              <p className="mt-2 whitespace-pre-wrap text-danger">{step.compensation.error}</p>
            )}
          </div>
        )}
        <StepPayloads step={step} />
      </div>
    </li>
  );
}

function StepPayloads({ step }: { step: WorkflowStepRecord }) {
  return (
    <>
      {Object.hasOwn(step, 'result') && <Payload label="Result" value={step.result} />}
      {Object.hasOwn(step, 'loopItem') && <Payload label="Loop item" value={step.loopItem} />}
    </>
  );
}

function Payload({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs text-muted">{label}</summary>
      <div className="mt-2">
        <JsonBlock value={value} />
      </div>
    </details>
  );
}
