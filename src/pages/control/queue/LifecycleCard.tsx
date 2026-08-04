import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Select } from '@/components/ui/form';
import { bq } from '@/lib/bq';
import {
  FLOW_COMPLETED_REQUEUE_UNAVAILABLE,
  FLOW_DELETION_UNAVAILABLE,
} from '@/lib/flowMutationSafety';
import {
  type CleanState,
  cleanArgs,
  promoteConfirmation,
  promoteCountArgs,
  type RunAction,
} from './queueActionModel';

export function LifecycleCard({
  queue,
  paused,
  busy,
  run,
}: {
  queue: string;
  paused: boolean;
  busy: boolean;
  run: RunAction;
}) {
  const [cleanGrace, setCleanGrace] = useState('0');
  const [cleanLimit, setCleanLimit] = useState('1000');
  const [cleanState, setCleanState] = useState<CleanState>('completed');
  const [promoteCount, setPromoteCount] = useState('');
  const clean = cleanArgs(cleanGrace, cleanLimit);
  const promote = promoteCountArgs(promoteCount);

  return (
    <Card className="mb-6">
      <CardHeader title="Lifecycle" />
      <div className="flex flex-wrap items-end gap-3">
        {paused ? (
          <Button
            variant="success"
            size="sm"
            disabled={busy}
            onClick={() => run('Resumed', () => bq.resume(queue))}
          >
            Resume
          </Button>
        ) : (
          <Button
            variant="warning"
            size="sm"
            disabled={busy}
            onClick={() => run('Paused', () => bq.pause(queue))}
          >
            Pause
          </Button>
        )}
        <Button size="sm" disabled title={FLOW_COMPLETED_REQUEUE_UNAVAILABLE}>
          Requeue completed
        </Button>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-24">
            <Field label="Promote N">
              <Input
                type="number"
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                name="promote-count"
                aria-invalid={!promote.valid}
                value={promoteCount}
                onChange={(event) => setPromoteCount(event.target.value)}
                placeholder="all"
              />
            </Field>
          </div>
          <Button
            size="sm"
            disabled={busy || !promote.valid}
            onClick={() =>
              run(
                'Promoted',
                () => bq.promoteJobs(queue, promote.count),
                promoteConfirmation(queue, promote.count)
              )
            }
          >
            Promote delayed
          </Button>
          {!promote.valid && (
            <span role="alert" className="pb-2 text-xs text-danger">
              Promote N must be a positive whole number, or blank for all.
            </span>
          )}
        </div>
      </div>
      <p className="mt-3 text-xs text-warning">{FLOW_COMPLETED_REQUEUE_UNAVAILABLE}</p>
      <div className="mt-4 border-t border-line pt-3">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-faint">
          Destructive — these permanently remove jobs
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Button size="sm" disabled title={FLOW_DELETION_UNAVAILABLE}>
            Drain
          </Button>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-40">
              <Field label="State">
                <Select
                  name="clean-state"
                  disabled
                  value={cleanState}
                  onChange={(event) => setCleanState(event.target.value as CleanState)}
                >
                  <option value="completed">Completed</option>
                  <option value="failed">Failed / DLQ</option>
                  <option value="waiting">Queued</option>
                </Select>
              </Field>
            </div>
            <div className="w-24">
              <Field label="Grace (ms)">
                <Input
                  type="number"
                  min={0}
                  max={Number.MAX_SAFE_INTEGER}
                  step={1}
                  name="clean-grace"
                  disabled
                  aria-invalid={!clean.valid}
                  value={cleanGrace}
                  onChange={(event) => setCleanGrace(event.target.value)}
                />
              </Field>
            </div>
            <div className="w-24">
              <Field label="Limit">
                <Input
                  type="number"
                  min={1}
                  max={Number.MAX_SAFE_INTEGER}
                  step={1}
                  name="clean-limit"
                  disabled
                  aria-invalid={!clean.valid}
                  value={cleanLimit}
                  onChange={(event) => setCleanLimit(event.target.value)}
                />
              </Field>
            </div>
            <Button variant="danger" size="sm" disabled title={FLOW_DELETION_UNAVAILABLE}>
              Clean
            </Button>
            {!clean.valid && (
              <span role="alert" className="pb-2 text-xs text-danger">
                Grace and limit must be whole numbers; limit must be positive.
              </span>
            )}
          </div>
        </div>
        <p className="mt-3 text-xs text-warning">{FLOW_DELETION_UNAVAILABLE}</p>
      </div>
    </Card>
  );
}
