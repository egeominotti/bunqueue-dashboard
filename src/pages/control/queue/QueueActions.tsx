import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Select } from '@/components/ui/form';
import { bq } from '@/lib/bq';
import {
  FLOW_COMPLETED_REQUEUE_UNAVAILABLE,
  FLOW_DELETION_UNAVAILABLE,
} from '@/lib/flowMutationSafety';

export type RunAction = (
  label: string,
  fn: () => Promise<unknown>,
  confirmMsg?: string,
  onSuccess?: () => void
) => void;

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
    Number.isSafeInteger(grace) &&
    Number.isSafeInteger(limit) &&
    grace >= 0 &&
    limit > 0;
  return { grace, limit, valid };
}

/** Blank promotes all; a supplied count must be a positive safe integer. */
export function promoteCountArgs(raw: string): { count?: number; valid: boolean } {
  if (!raw.trim()) return { valid: true };
  const count = Number(raw);
  return Number.isSafeInteger(count) && count > 0 ? { count, valid: true } : { valid: false };
}

export function promoteConfirmation(queue: string, count?: number): string {
  return count === undefined
    ? `Promote every delayed job in "${queue}" and make it eligible to run now?`
    : `Promote up to ${count} delayed jobs in "${queue}" and make them eligible to run now?`;
}

/** Validate the v2.8.55 rate-limit body without turning blank optionals into 0. */
export function rateLimitArgs(
  limitRaw: string,
  durationRaw: string,
  ttlRaw: string
): { limit: number; duration: number; ttl?: number; valid: boolean } {
  const parseOptional = (raw: string): number | undefined | null => {
    if (!raw.trim()) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  const limit = parseOptional(limitRaw);
  const duration = parseOptional(durationRaw);
  const ttl = parseOptional(ttlRaw);
  return {
    limit: typeof limit === 'number' ? limit : 0,
    duration: typeof duration === 'number' ? duration : 0,
    ...(typeof ttl === 'number' ? { ttl } : {}),
    valid: typeof limit === 'number' && typeof duration === 'number' && ttl !== null,
  };
}

export function concurrencyArgs(raw: string): { value: number; valid: boolean } {
  const value = Number(raw);
  return {
    value,
    valid: raw.trim() !== '' && Number.isSafeInteger(value) && value > 0,
  };
}

export type CleanState = 'completed' | 'failed' | 'waiting';

/**
 * v2.8.55 cleans exactly one state per call. Its waiting-like branch owns the
 * shared queued structure, so it also removes delayed and prioritized jobs.
 */
export function cleanStateDescription(state: CleanState): string {
  switch (state) {
    case 'completed':
      return 'completed jobs';
    case 'failed':
      return 'failed jobs and their DLQ entries';
    case 'waiting':
      return 'queued jobs (waiting, delayed, and prioritized)';
  }
}

/** Pause/resume and promote-delayed; unsafe destructive transitions stay visible but disabled. */
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
                onChange={(e) => setPromoteCount(e.target.value)}
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
      {/* Divider: everything below removes jobs; everything above is reversible. */}
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
                  onChange={(e) => setCleanState(e.target.value as CleanState)}
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
                  onChange={(e) => setCleanGrace(e.target.value)}
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
                  onChange={(e) => setCleanLimit(e.target.value)}
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
  const [rateDuration, setRateDuration] = useState('');
  const [rateTtlMode, setRateTtlMode] = useState<'permanent' | 'expires'>('permanent');
  const [rateTtl, setRateTtl] = useState('');
  const [concurrency, setConcurrency] = useState('');
  const [rateClearQueue, setRateClearQueue] = useState('');
  const [concurrencyClearQueue, setConcurrencyClearQueue] = useState('');
  const [rateReceipt, setRateReceipt] = useState<string | null>(null);
  const [concurrencyReceipt, setConcurrencyReceipt] = useState<string | null>(null);
  const rate = rateLimitArgs(rateLimit, rateDuration, rateTtlMode === 'expires' ? rateTtl : '');
  const concurrencyInput = concurrencyArgs(concurrency);
  return (
    <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Rate-limit desired state" />
        <p className="mb-3 text-xs text-warning">
          Bunqueue v2.8.55 has no read endpoint. This blindly replaces an unknown policy; a receipt
          proves only what this dashboard applied at that time.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-24 flex-1">
            <Field label="Limit">
              <Input
                type="number"
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                name="rate-limit"
                value={rateLimit}
                onChange={(e) => setRateLimit(e.target.value)}
                placeholder="max per window"
              />
            </Field>
          </div>
          <div className="min-w-28 flex-1">
            <Field label="Window (ms)">
              <Input
                type="number"
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                name="rate-duration"
                value={rateDuration}
                onChange={(e) => setRateDuration(e.target.value)}
                placeholder="60000"
              />
            </Field>
          </div>
          <div className="min-w-28 flex-1">
            <Field label="TTL">
              <Select
                name="rate-ttl-mode"
                value={rateTtlMode}
                onChange={(e) => setRateTtlMode(e.target.value as 'permanent' | 'expires')}
              >
                <option value="permanent">Permanent</option>
                <option value="expires">Expires after</option>
              </Select>
            </Field>
          </div>
          <div className="min-w-24 flex-1">
            <Field label="TTL (ms)" hint={rateTtlMode === 'permanent' ? 'Not sent' : undefined}>
              <Input
                type="number"
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                name="rate-ttl"
                disabled={rateTtlMode === 'permanent'}
                value={rateTtl}
                onChange={(e) => setRateTtl(e.target.value)}
                placeholder="—"
              />
            </Field>
          </div>
          <Button
            variant="accent"
            size="sm"
            disabled={busy || !rate.valid}
            onClick={() =>
              run(
                'Rate limit set',
                () => bq.setRateLimit(queue, rate.limit, rate.duration, rate.ttl),
                `Replace the unknown rate-limit policy for "${queue}" with limit ${rate.limit}, window ${rate.duration}ms${rate.ttl === undefined ? ', permanent' : `, TTL ${rate.ttl}ms`}?`,
                () =>
                  setRateReceipt(
                    `Applied limit ${rate.limit} per ${rate.duration}ms${rate.ttl === undefined ? ', permanent' : `, TTL ${rate.ttl}ms`} at ${new Date().toISOString()}. Current server state cannot be read.`
                  )
              )
            }
          >
            Replace policy
          </Button>
          <div className="min-w-40 flex-1">
            <Field label={`Type ${queue} to clear`}>
              <Input
                name="rate-clear-queue"
                autoComplete="off"
                spellCheck={false}
                value={rateClearQueue}
                onChange={(e) => setRateClearQueue(e.target.value)}
              />
            </Field>
          </div>
          <Button
            size="sm"
            disabled={busy || rateClearQueue !== queue}
            onClick={() =>
              run(
                'No rate limit ensured',
                () => bq.clearRateLimit(queue),
                `Ensure queue "${queue}" has no rate-limit policy? Bunqueue v2.8.55 cannot report its previous value.`,
                () =>
                  setRateReceipt(
                    `Applied no rate-limit policy at ${new Date().toISOString()}. Current server state cannot be read.`
                  )
              )
            }
          >
            Ensure no rate limit
          </Button>
          {!rate.valid && (rateLimit.trim() || rateDuration.trim() || rateTtl.trim()) && (
            <span role="alert" className="w-full text-xs text-danger">
              Limit and window are required; all values must be positive whole numbers.
            </span>
          )}
          {rateReceipt && (
            <span role="status" className="w-full text-xs text-success">
              {rateReceipt}
            </span>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="Concurrency desired state" />
        <p className="mb-3 text-xs text-warning">
          Bunqueue v2.8.55 has no read endpoint. This blindly replaces an unknown policy; a receipt
          proves only what this dashboard applied at that time.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field label="Concurrency">
              <Input
                type="number"
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                name="concurrency"
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
                placeholder="max in-flight"
              />
            </Field>
          </div>
          <Button
            variant="accent"
            size="sm"
            disabled={busy || !concurrencyInput.valid}
            onClick={() =>
              run(
                'Concurrency set',
                () => bq.setConcurrency(queue, concurrencyInput.value),
                `Replace the unknown concurrency policy for "${queue}" with ${concurrencyInput.value} maximum in-flight jobs?`,
                () =>
                  setConcurrencyReceipt(
                    `Applied concurrency ${concurrencyInput.value} at ${new Date().toISOString()}. Current server state cannot be read.`
                  )
              )
            }
          >
            Replace policy
          </Button>
          <div className="min-w-40 flex-1">
            <Field label={`Type ${queue} to clear`}>
              <Input
                name="concurrency-clear-queue"
                autoComplete="off"
                spellCheck={false}
                value={concurrencyClearQueue}
                onChange={(e) => setConcurrencyClearQueue(e.target.value)}
              />
            </Field>
          </div>
          <Button
            size="sm"
            disabled={busy || concurrencyClearQueue !== queue}
            onClick={() =>
              run(
                'No concurrency limit ensured',
                () => bq.clearConcurrency(queue),
                `Ensure queue "${queue}" has no concurrency policy? Bunqueue v2.8.55 cannot report its previous value.`,
                () =>
                  setConcurrencyReceipt(
                    `Applied no concurrency policy at ${new Date().toISOString()}. Current server state cannot be read.`
                  )
              )
            }
          >
            Ensure no concurrency limit
          </Button>
          {!concurrencyInput.valid && concurrency.trim() && (
            <span role="alert" className="self-center text-xs text-danger">
              Concurrency must be a positive whole number.
            </span>
          )}
          {concurrencyReceipt && (
            <span role="status" className="w-full text-xs text-success">
              {concurrencyReceipt}
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}
