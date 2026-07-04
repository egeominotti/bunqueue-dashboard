import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/form';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { actionGates } from '@/lib/jobActions';

type Act = (label: string, fn: () => Promise<unknown>, confirmMsg?: string) => void;

/**
 * State-gated action rail for a single job. Reads the shared actionGates() so it
 * never drifts from JobsPro on what's legal, and routes every mutation through
 * the parent's act() (which handles the status line + reload). Force-fail and
 * move-to-delayed are the two active-only controls added here.
 */
export function JobActionsPanel({ job, busy, act }: { job: JobFull; busy: boolean; act: Act }) {
  const gates = actionGates(job.state);
  const hasAnyAction =
    gates.cancel ||
    gates.discard ||
    gates.promote ||
    gates.retryActive ||
    gates.retryDlq ||
    gates.requeueCompleted ||
    gates.setPriority ||
    gates.setDelay ||
    gates.fail ||
    gates.moveToDelayed;

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
        {gates.retryActive && (
          <Button size="sm" disabled={busy} onClick={() => act('Retry', () => bq.retryJob(job.id))}>
            Retry (move to waiting)
          </Button>
        )}
        {gates.retryDlq && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => act('Retry', () => bq.retryDlq(job.queue ?? '', job.id))}
          >
            Retry from DLQ
          </Button>
        )}
        {gates.requeueCompleted && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => act('Requeue', () => bq.retryCompleted(job.queue ?? '', job.id))}
          >
            Requeue
          </Button>
        )}
        {gates.moveToDelayed && (
          <InlineNumber
            label="Move to delayed (ms)"
            cta="To delayed"
            disabled={busy}
            onSubmit={(n) => act('Move to delayed', () => bq.moveToDelayed(job.id, n))}
          />
        )}
        {job.state === 'active' && (
          <InlineNumber
            label="Set progress (0–100)"
            cta="Progress"
            disabled={busy}
            onSubmit={(n) =>
              act('Progress', () => bq.setJobProgress(job.id, Math.max(0, Math.min(100, n))))
            }
          />
        )}
        {gates.discard && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => act('Discard', () => bq.discardJob(job.id))}
          >
            Discard (to DLQ)
          </Button>
        )}
        {gates.setPriority && (
          <InlineNumber
            label="Set priority"
            cta="Set"
            disabled={busy}
            onSubmit={(n) => act('Priority', () => bq.changePriority(job.id, n))}
          />
        )}
        {gates.setDelay && (
          <InlineNumber
            label="Set delay (ms)"
            cta="Delay"
            disabled={busy}
            onSubmit={(n) => act('Delay', () => bq.changeDelay(job.id, n))}
          />
        )}
        {gates.fail && (
          <InlineText
            label="Fail reason (optional)"
            cta="Fail"
            variant="warning"
            disabled={busy}
            onSubmit={(reason) =>
              act(
                'Fail',
                () => bq.failJob(job.id, reason || undefined),
                'Force-fail this active job?'
              )
            }
          />
        )}
        {gates.cancel && (
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() =>
              act('Cancel', () => bq.cancelJob(job.id), `Cancel and remove job ${job.id}?`)
            }
          >
            Cancel (delete)
          </Button>
        )}
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
  disabled,
  onSubmit,
}: {
  label: string;
  cta: string;
  disabled: boolean;
  onSubmit: (n: number) => void;
}) {
  const [v, setV] = useState('');
  return (
    // A real <form> so Enter in the field submits, same as clicking the button.
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && v.trim() !== '') onSubmit(Number(v));
      }}
    >
      <Input
        type="number"
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={label}
        aria-label={label}
        className="h-8 text-xs"
      />
      <Button type="submit" size="sm" disabled={disabled || v.trim() === ''}>
        {cta}
      </Button>
    </form>
  );
}

function InlineText({
  label,
  cta,
  disabled,
  variant = 'default',
  onSubmit,
}: {
  label: string;
  cta: string;
  disabled: boolean;
  variant?: 'default' | 'warning' | 'danger';
  onSubmit: (v: string) => void;
}) {
  const [v, setV] = useState('');
  return (
    // A real <form> so Enter in the field submits, same as clicking the button.
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) return;
        onSubmit(v);
        setV('');
      }}
    >
      <Input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={label}
        aria-label={label}
        className="h-8 text-xs"
      />
      <Button type="submit" size="sm" variant={variant} disabled={disabled}>
        {cta}
      </Button>
    </form>
  );
}
