import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Select } from '@/components/ui/form';
import { bq } from '@/lib/bq';
import { concurrencyArgs, type RunAction, rateLimitArgs } from './queueActionModel';

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
        <CardHeader title="Rate-limit policy" />
        <p className="mb-3 text-xs text-faint">
          Live SDK readback is available in Queue Control. Applying a policy replaces the broker
          value for this queue.
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
                onChange={(event) => setRateLimit(event.target.value)}
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
                onChange={(event) => setRateDuration(event.target.value)}
                placeholder="60000"
              />
            </Field>
          </div>
          <div className="min-w-28 flex-1">
            <Field label="TTL">
              <Select
                name="rate-ttl-mode"
                value={rateTtlMode}
                onChange={(event) => setRateTtlMode(event.target.value as 'permanent' | 'expires')}
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
                onChange={(event) => setRateTtl(event.target.value)}
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
                `Replace the current rate-limit policy for "${queue}" with limit ${rate.limit}, window ${rate.duration}ms${rate.ttl === undefined ? ', permanent' : `, TTL ${rate.ttl}ms`}?`,
                () =>
                  setRateReceipt(
                    `Applied limit ${rate.limit} per ${rate.duration}ms${rate.ttl === undefined ? ', permanent' : `, TTL ${rate.ttl}ms`} at ${new Date().toISOString()}.`
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
                onChange={(event) => setRateClearQueue(event.target.value)}
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
                `Remove the current rate-limit policy from queue "${queue}"?`,
                () =>
                  setRateReceipt(`Removed the rate-limit policy at ${new Date().toISOString()}.`)
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
        <CardHeader title="Concurrency policy" />
        <p className="mb-3 text-xs text-faint">
          Live SDK readback is available in Queue Control. Applying a value replaces the broker
          concurrency for this queue.
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
                onChange={(event) => setConcurrency(event.target.value)}
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
                `Replace the current concurrency policy for "${queue}" with ${concurrencyInput.value} maximum in-flight jobs?`,
                () =>
                  setConcurrencyReceipt(
                    `Applied concurrency ${concurrencyInput.value} at ${new Date().toISOString()}.`
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
                onChange={(event) => setConcurrencyClearQueue(event.target.value)}
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
                `Remove the current concurrency policy from queue "${queue}"?`,
                () =>
                  setConcurrencyReceipt(
                    `Removed the concurrency policy at ${new Date().toISOString()}.`
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
