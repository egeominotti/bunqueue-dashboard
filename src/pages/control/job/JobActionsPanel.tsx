import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Input, Toggle } from '@/components/ui/form';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import {
  FLOW_COMPLETED_REQUEUE_UNAVAILABLE,
  FLOW_DELETION_UNAVAILABLE,
  FLOW_DLQ_RETRY_UNAVAILABLE,
} from '@/lib/flowMutationSafety';
import { actionGates } from '@/lib/jobActions';

type Act = (label: string, fn: () => Promise<unknown>, confirmMsg?: string) => void;

const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;

type JobNumberKind = 'delay' | 'progress' | 'priority';

export function parseJobActionNumber(
  raw: string,
  kind: JobNumberKind
): { ok: true; value: number } | { ok: false; msg: string } {
  if (!raw.trim()) return { ok: false, msg: 'A value is required' };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { ok: false, msg: 'Value must be a finite number' };
  if (kind === 'progress') {
    return value >= 0 && value <= 100
      ? { ok: true, value }
      : { ok: false, msg: 'Progress must be between 0 and 100' };
  }
  if (!Number.isSafeInteger(value)) {
    return { ok: false, msg: 'Value must be a whole, safe integer' };
  }
  if (kind === 'priority') {
    return value >= -1_000_000 && value <= 1_000_000
      ? { ok: true, value }
      : { ok: false, msg: 'Priority must be between -1000000 and 1000000' };
  }
  return value >= 0 && value <= MAX_DELAY_MS
    ? { ok: true, value }
    : { ok: false, msg: `Delay must be between 0 and ${MAX_DELAY_MS} ms` };
}

export function parseFailureStack(
  text: string
): { ok: true; stack?: string[] } | { ok: false; msg: string } {
  const stack = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (stack.length > 100) return { ok: false, msg: 'Stack trace is limited to 100 frames' };
  if (stack.some((line) => line.length > 16_384)) {
    return { ok: false, msg: 'Each stack frame must be 16384 characters or fewer' };
  }
  if (stack.reduce((total, line) => total + line.length, 0) > 256 * 1024) {
    return { ok: false, msg: 'Stack trace must be 256 KB or smaller' };
  }
  return { ok: true, ...(stack.length ? { stack } : {}) };
}

/**
 * State-gated action rail for a single job. Reads the shared actionGates() so it
 * never drifts from JobsPro on what's legal, and routes every mutation through
 * the parent's act() (which handles the status line + reload). Active jobs only
 * expose progress: state-changing controls cannot cancel the running worker in
 * v2.9.0 and could otherwise create duplicate processing side effects.
 */
export function JobActionsPanel({ job, busy, act }: { job: JobFull; busy: boolean; act: Act }) {
  const gates = actionGates(job.state);
  const hasAnyAction =
    gates.promote || gates.setPriority || gates.setDelay || job.state === 'active';

  return (
    <Card>
      <CardHeader title="Actions" />
      <div className="flex flex-col gap-2">
        {gates.promote && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => act('Promote', () => bq.promoteJob(job.id))}
          >
            Promote (run now)
          </Button>
        )}
        {job.state === 'failed' && (
          <p
            role="note"
            className="rounded-lg border border-warning/30 bg-warning/5 p-2 text-xs text-warning"
          >
            {FLOW_DLQ_RETRY_UNAVAILABLE}
          </p>
        )}
        {job.state === 'completed' && (
          <p
            role="note"
            className="rounded-lg border border-warning/30 bg-warning/5 p-2 text-xs text-warning"
          >
            {FLOW_COMPLETED_REQUEUE_UNAVAILABLE}
          </p>
        )}
        {job.state === 'active' && (
          <>
            <p
              role="note"
              className="rounded-lg border border-warning/30 bg-warning/5 p-2 text-xs text-warning"
            >
              Active-job state changes are unavailable: Bunqueue cannot stop the worker that is
              already processing this job, so retrying, delaying, discarding or failing it here
              could run side effects twice.
            </p>
            <InlineNumber
              label="Set progress (0–100)"
              cta="Progress"
              kind="progress"
              disabled={busy}
              onSubmit={(n) => act('Progress', () => bq.setJobProgress(job.id, n))}
            />
          </>
        )}
        {gates.setPriority && (
          <PriorityAction
            disabled={busy}
            onSubmit={(priority, lifo) =>
              act('Priority', () => bq.changePriority(job.id, priority, lifo))
            }
          />
        )}
        {gates.setDelay && (
          <InlineNumber
            label="Set delay (ms)"
            cta="Delay"
            kind="delay"
            disabled={busy}
            onSubmit={(n) => act('Delay', () => bq.changeDelay(job.id, n))}
          />
        )}
        <p role="note" className="text-xs text-faint">
          Cancel/delete/discard: {FLOW_DELETION_UNAVAILABLE}
        </p>
        {!hasAnyAction && (
          <p className="text-xs text-faint">
            No actions available for a job in state "{job.state ?? 'unknown'}".
          </p>
        )}
      </div>
    </Card>
  );
}

function InlineNumber({
  label,
  cta,
  kind,
  disabled,
  onSubmit,
}: {
  label: string;
  cta: string;
  kind: Exclude<JobNumberKind, 'priority'>;
  disabled: boolean;
  onSubmit: (n: number) => void;
}) {
  const [v, setV] = useState('');
  const parsed = parseJobActionNumber(v, kind);
  return (
    // A real <form> so Enter in the field submits, same as clicking the button.
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && parsed.ok) onSubmit(parsed.value);
      }}
    >
      <Input
        type="number"
        min={0}
        max={kind === 'progress' ? 100 : MAX_DELAY_MS}
        step={kind === 'progress' ? 'any' : 1}
        name={kind === 'progress' ? 'job-progress' : 'job-delay'}
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={label}
        aria-label={label}
        className="h-8 text-xs"
      />
      <Button type="submit" size="sm" disabled={disabled || !parsed.ok}>
        {cta}
      </Button>
      {!parsed.ok && v.trim() && (
        <span role="alert" className="self-center text-[11px] text-danger">
          {parsed.msg}
        </span>
      )}
    </form>
  );
}

function PriorityAction({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (priority: number, lifo: boolean) => void;
}) {
  const [v, setV] = useState('');
  const [lifo, setLifo] = useState(false);
  const parsed = parseJobActionNumber(v, 'priority');
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && parsed.ok) onSubmit(parsed.value, lifo);
      }}
    >
      <Input
        type="number"
        min={-1_000_000}
        max={1_000_000}
        step={1}
        name="job-priority"
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="Set priority"
        aria-label="Set priority"
        className="h-8 min-w-28 flex-1 text-xs"
      />
      <div className="flex items-center gap-1.5">
        <Toggle checked={lifo} onChange={setLifo} label="Place first among equal priorities" />
        <span className="text-xs text-muted">LIFO</span>
      </div>
      <Button type="submit" size="sm" disabled={disabled || !parsed.ok}>
        Set
      </Button>
      {!parsed.ok && v.trim() && (
        <span role="alert" className="w-full text-[11px] text-danger">
          {parsed.msg}
        </span>
      )}
    </form>
  );
}
