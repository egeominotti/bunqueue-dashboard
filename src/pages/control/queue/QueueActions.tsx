import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/form';
import { bq } from '@/lib/bq';

export type RunAction = (label: string, fn: () => Promise<unknown>, confirmMsg?: string) => void;

/**
 * Coerce the two Clean inputs ONCE, so the confirm prompt quotes exactly what
 * the request sends. `<input type="number">` reports '' for an empty (or
 * partially typed) field and `Number('')` is 0 — quoting the raw strings would
 * show a blank where the scope should be while sending `{grace:0, limit:0}`,
 * i.e. a wider deletion than the prompt named. `valid` gates the button.
 */
export function cleanArgs(
  graceRaw: string,
  limitRaw: string
): { grace: number; limit: number; valid: boolean } {
  const grace = Number(graceRaw);
  const limit = Number(limitRaw);
  const valid =
    graceRaw.trim() !== '' &&
    limitRaw.trim() !== '' &&
    Number.isFinite(grace) &&
    Number.isFinite(limit) &&
    grace >= 0 &&
    limit > 0;
  return { grace, limit, valid };
}

/** Pause/resume, drain, retry-completed, promote-delayed, clean. */
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
  const [promoteCount, setPromoteCount] = useState('');
  const clean = cleanArgs(cleanGrace, cleanLimit);

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
        <Button
          size="sm"
          disabled={busy}
          onClick={() => run('Retried completed', () => bq.retryCompleted(queue))}
        >
          Retry completed
        </Button>
        <div className="flex items-end gap-2">
          <div className="w-24">
            <Field label="Promote N">
              <Input
                type="number"
                value={promoteCount}
                onChange={(e) => setPromoteCount(e.target.value)}
                placeholder="all"
              />
            </Field>
          </div>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              run('Promoted', () =>
                bq.promoteJobs(queue, promoteCount ? Number(promoteCount) : undefined)
              )
            }
          >
            Promote delayed
          </Button>
        </div>
      </div>
      {/* Divider: everything below removes jobs; everything above is reversible. */}
      <div className="mt-4 border-t border-line pt-3">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-faint">
          Destructive — these permanently remove jobs
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              run('Drained', () => bq.drain(queue), `Drain waiting jobs from "${queue}"?`)
            }
          >
            Drain
          </Button>
          <div className="flex items-end gap-2">
            <div className="w-24">
              <Field label="Grace (ms)">
                <Input
                  type="number"
                  value={cleanGrace}
                  onChange={(e) => setCleanGrace(e.target.value)}
                />
              </Field>
            </div>
            <div className="w-24">
              <Field label="Limit">
                <Input
                  type="number"
                  value={cleanLimit}
                  onChange={(e) => setCleanLimit(e.target.value)}
                />
              </Field>
            </div>
            <Button
              variant="danger"
              size="sm"
              disabled={busy || !clean.valid}
              onClick={() =>
                run(
                  'Cleaned',
                  () => bq.clean(queue, { grace: clean.grace, limit: clean.limit }),
                  `Permanently delete up to ${clean.limit} completed/failed jobs older than ${clean.grace}ms from "${queue}"?`
                )
              }
            >
              Clean
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** Rate-limit + concurrency setters. */
export function LimitsCards({
  queue,
  busy,
  run,
}: {
  queue: string;
  busy: boolean;
  run: RunAction;
}) {
  const [rateLimit, setRateLimit] = useState('');
  const [concurrency, setConcurrency] = useState('');

  return (
    <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Rate limit" />
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="Limit">
              <Input
                type="number"
                value={rateLimit}
                onChange={(e) => setRateLimit(e.target.value)}
                placeholder="max per window"
              />
            </Field>
          </div>
          <Button
            variant="accent"
            size="sm"
            disabled={busy || !rateLimit}
            onClick={() => run('Rate limit set', () => bq.setRateLimit(queue, Number(rateLimit)))}
          >
            Set
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => run('Rate limit cleared', () => bq.clearRateLimit(queue))}
          >
            Clear
          </Button>
        </div>
      </Card>
      <Card>
        <CardHeader title="Concurrency" />
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="Concurrency">
              <Input
                type="number"
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
                placeholder="max in-flight"
              />
            </Field>
          </div>
          <Button
            variant="accent"
            size="sm"
            disabled={busy || !concurrency}
            onClick={() =>
              run('Concurrency set', () => bq.setConcurrency(queue, Number(concurrency)))
            }
          >
            Set
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => run('Concurrency cleared', () => bq.clearConcurrency(queue))}
          >
            Clear
          </Button>
        </div>
      </Card>
    </div>
  );
}
