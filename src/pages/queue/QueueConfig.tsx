import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, Input, Select } from '@/components/ui/form';
import { IconLightning, IconWorkers } from '@/components/ui/icons';
import { bq } from '@/lib/bq';
import { assertSuccessfulMutationResponse, useServerActionGuard } from '@/lib/useServerActionGuard';

/** Rate-limit + concurrency desired-state controls for one verified queue. */
export function QueueConfig({ queue }: { queue: string }) {
  return (
    <div className="mt-8">
      <h2 className="mb-3 text-lg font-semibold text-fg">Configuration</h2>
      <p className="mb-4 text-xs text-warning">
        Bunqueue v2.8.55 cannot read either current policy. Every command below is an explicit blind
        desired-state write; a receipt proves only what this dashboard applied at that time.
      </p>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <RateLimitCard queue={queue} />
        <ConcurrencyCard queue={queue} />
      </div>
    </div>
  );
}

function positiveWhole(raw: string): number | null {
  if (!raw.trim()) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function useAction(queue: string, kind: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const guard = useServerActionGuard(`classic-queue-policy:${queue}:${kind}`);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the queue+connection lifecycle boundary
  useEffect(() => {
    setBusy(false);
    setError(null);
    setReceipt(null);
  }, [guard.scopeKey]);

  const run = async (label: string, confirmation: string, fn: () => Promise<unknown>) => {
    if (!window.confirm(confirmation)) return;
    const lease = guard.begin(kind);
    if (!lease) return;
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      // The dashboard detail endpoint synthesizes an empty queue for unknown
      // names. Re-establish real membership immediately before every write.
      const queues = await bq.queuesSummary();
      if (!lease.isCurrent()) return;
      if (!queues.some((candidate) => candidate.name === queue)) {
        throw new Error(`Queue "${queue}" no longer exists`);
      }
      const response = await fn();
      assertSuccessfulMutationResponse(response, label);
      if (!lease.isCurrent()) return;
      setReceipt(
        `${label} applied at ${new Date().toISOString()}. Current server state cannot be read.`
      );
    } catch (actionError) {
      if (lease.isCurrent()) setError((actionError as Error).message);
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  return { busy, error, receipt, run };
}

function RateLimitCard({ queue }: { queue: string }) {
  const [limitRaw, setLimitRaw] = useState('');
  const [durationRaw, setDurationRaw] = useState('');
  const [ttlMode, setTtlMode] = useState<'permanent' | 'expires'>('permanent');
  const [ttlRaw, setTtlRaw] = useState('');
  const [clearQueue, setClearQueue] = useState('');
  const { busy, error, receipt, run } = useAction(queue, 'rate-limit');
  const limit = positiveWhole(limitRaw);
  const duration = positiveWhole(durationRaw);
  const ttl = ttlMode === 'expires' ? positiveWhole(ttlRaw) : undefined;
  const valid = limit !== null && duration !== null && (ttlMode === 'permanent' || ttl != null);

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-fg">Rate-limit desired state</h3>
        <IconLightning className="size-4 text-faint" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Limit">
          <Input
            type="number"
            min={1}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            inputMode="numeric"
            name="classic-rate-limit"
            value={limitRaw}
            aria-invalid={limitRaw.trim() !== '' && limit === null}
            onChange={(event) => setLimitRaw(event.target.value)}
            placeholder="100"
          />
        </Field>
        <Field label="Window (ms)">
          <Input
            type="number"
            min={1}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            inputMode="numeric"
            name="classic-rate-duration"
            value={durationRaw}
            aria-invalid={durationRaw.trim() !== '' && duration === null}
            onChange={(event) => setDurationRaw(event.target.value)}
            placeholder="60000"
          />
        </Field>
        <Field label="TTL">
          <Select
            name="classic-rate-ttl-mode"
            value={ttlMode}
            onChange={(event) => setTtlMode(event.target.value as 'permanent' | 'expires')}
          >
            <option value="permanent">Permanent</option>
            <option value="expires">Expires after</option>
          </Select>
        </Field>
        <Field label="TTL (ms)" hint={ttlMode === 'permanent' ? 'Not sent' : undefined}>
          <Input
            type="number"
            min={1}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            inputMode="numeric"
            name="classic-rate-ttl"
            disabled={ttlMode === 'permanent'}
            value={ttlRaw}
            aria-invalid={ttlMode === 'expires' && ttlRaw.trim() !== '' && ttl == null}
            onChange={(event) => setTtlRaw(event.target.value)}
            placeholder="3600000"
          />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant="accent"
          size="sm"
          disabled={busy || !valid}
          onClick={() => {
            if (limit === null || duration === null) return;
            if (ttlMode === 'expires' && ttl === null) return;
            const ttlValue = typeof ttl === 'number' ? ttl : undefined;
            const ttlDescription = ttlMode === 'permanent' ? 'permanent' : `TTL ${ttl}ms`;
            void run(
              'Rate-limit policy replaced',
              `Replace the unknown rate-limit policy for "${queue}" with limit ${limit}, window ${duration}ms, ${ttlDescription}?`,
              () => bq.setRateLimit(queue, limit, duration, ttlValue)
            );
          }}
        >
          Replace rate-limit policy
        </Button>
      </div>
      <div className="mt-4 border-t border-line pt-4">
        <Field label={`Type ${queue} to clear`}>
          <Input
            name="classic-rate-clear-queue"
            autoComplete="off"
            spellCheck={false}
            value={clearQueue}
            onChange={(event) => setClearQueue(event.target.value)}
          />
        </Field>
        <Button
          className="mt-2"
          size="sm"
          disabled={busy || clearQueue !== queue}
          onClick={() =>
            void run(
              'No rate limit ensured',
              `Ensure queue "${queue}" has no rate-limit policy? The previous value is unavailable.`,
              () => bq.clearRateLimit(queue)
            )
          }
        >
          Ensure no rate limit
        </Button>
      </div>
      {receipt && (
        <p role="status" className="mt-3 text-xs text-success">
          {receipt}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}

function ConcurrencyCard({ queue }: { queue: string }) {
  const [concurrencyRaw, setConcurrencyRaw] = useState('');
  const [clearQueue, setClearQueue] = useState('');
  const { busy, error, receipt, run } = useAction(queue, 'concurrency');
  const concurrency = positiveWhole(concurrencyRaw);

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-fg">Concurrency desired state</h3>
        <IconWorkers className="size-4 text-faint" />
      </div>
      <Field label="Maximum in-flight jobs">
        <Input
          type="number"
          min={1}
          max={Number.MAX_SAFE_INTEGER}
          step={1}
          inputMode="numeric"
          name="classic-concurrency"
          value={concurrencyRaw}
          aria-invalid={concurrencyRaw.trim() !== '' && concurrency === null}
          onChange={(event) => setConcurrencyRaw(event.target.value)}
          placeholder="5"
        />
      </Field>
      <div className="mt-4 flex items-center gap-2">
        <Button
          variant="accent"
          size="sm"
          disabled={busy || concurrency === null}
          onClick={() => {
            if (concurrency === null) return;
            void run(
              'Concurrency policy replaced',
              `Replace the unknown concurrency policy for "${queue}" with ${concurrency} maximum in-flight jobs?`,
              () => bq.setConcurrency(queue, concurrency)
            );
          }}
        >
          Replace concurrency policy
        </Button>
      </div>
      <div className="mt-4 border-t border-line pt-4">
        <Field label={`Type ${queue} to clear`}>
          <Input
            name="classic-concurrency-clear-queue"
            autoComplete="off"
            spellCheck={false}
            value={clearQueue}
            onChange={(event) => setClearQueue(event.target.value)}
          />
        </Field>
        <Button
          className="mt-2"
          size="sm"
          disabled={busy || clearQueue !== queue}
          onClick={() =>
            void run(
              'No concurrency limit ensured',
              `Ensure queue "${queue}" has no concurrency policy? The previous value is unavailable.`,
              () => bq.clearConcurrency(queue)
            )
          }
        >
          Ensure no concurrency limit
        </Button>
      </div>
      {receipt && (
        <p role="status" className="mt-3 text-xs text-success">
          {receipt}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}
