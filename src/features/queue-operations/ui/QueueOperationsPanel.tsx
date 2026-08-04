import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/form';
import type {
  QueueLimitSnapshot,
  QueueOperationsRepository,
} from '../application/QueueOperationsRepository';
import { bqQueueOperationsRepository } from '../infrastructure/bqQueueOperationsRepository';
import { QueueDeduplicationConsole } from './QueueDeduplicationConsole';
import { QueueLimitReadback } from './QueueLimitReadback';
import { QueueTelemetryConsole } from './QueueTelemetryConsole';

export type QueueOperationRunner = <T>(
  label: string,
  task: () => Promise<T>,
  onSuccess: (value: T) => void,
  mutation?: boolean
) => void;

export function QueueOperationsPanel({
  queue,
  refreshKey = 0,
  repository = bqQueueOperationsRepository,
  onApplied,
}: {
  queue: string;
  refreshKey?: number;
  repository?: QueueOperationsRepository;
  onApplied?: () => void;
}) {
  const [maxJobs, setMaxJobs] = useState('');
  const [limitsState, setLimitsState] = useState<{
    queue: string;
    snapshot: QueueLimitSnapshot | null;
    loading: boolean;
    error: string;
  } | null>(null);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const lock = useRef(false);
  const limitRequest = useRef(0);
  const active = useRef(true);
  const limits =
    limitsState?.queue === queue
      ? limitsState
      : { queue, snapshot: null, loading: true, error: '' };

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      limitRequest.current += 1;
    };
  }, []);

  const loadLimits = useCallback(async () => {
    const parsed = optionalMaxJobs(maxJobs);
    if (parsed === null) {
      setLimitsState((current) => ({
        queue,
        snapshot: current?.queue === queue ? current.snapshot : null,
        loading: false,
        error: 'maxJobs must be a whole number from 0 to 1000000.',
      }));
      return;
    }
    const mine = ++limitRequest.current;
    setLimitsState((current) => ({
      queue,
      snapshot: current?.queue === queue ? current.snapshot : null,
      loading: true,
      error: '',
    }));
    try {
      const next = await repository.limits(queue, parsed);
      if (active.current && mine === limitRequest.current) {
        setLimitsState({ queue, snapshot: next, loading: false, error: '' });
      }
    } catch (error) {
      if (active.current && mine === limitRequest.current) {
        setLimitsState({ queue, snapshot: null, loading: false, error: messageOf(error) });
      }
    }
  }, [maxJobs, queue, repository]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey explicitly invalidates the snapshot
  useEffect(() => void loadLimits(), [queue, refreshKey]);

  const run: QueueOperationRunner = (label, task, onSuccess, mutation = false) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setActionError('');
    void task()
      .then((value) => {
        if (!active.current) return;
        onSuccess(value);
        if (mutation) {
          onApplied?.();
          if (!onApplied) void loadLimits();
        }
      })
      .catch((error) => {
        if (active.current) setActionError(messageOf(error));
      })
      .finally(() => {
        lock.current = false;
        if (active.current) setBusy('');
      });
  };

  return (
    <Card className="mb-6">
      <CardHeader
        title="Queue SDK operations"
        action={busy ? <span className="font-mono text-xs text-accent">{busy}...</span> : undefined}
      />
      <p className="mb-5 max-w-3xl text-xs leading-5 text-faint">
        Live Bunqueue 2.8.57 limit, deduplication, metric, and event-journal contracts. Requests are
        pinned to the server managed by this control agent.
      </p>
      <div className="mb-5 flex flex-wrap items-end gap-3 border-b border-line pb-5">
        <div className="w-48">
          <Field label="TTL threshold (maxJobs)" hint="Optional token-consumption threshold">
            <Input
              name="queue-sdk-max-jobs"
              type="number"
              min={0}
              max={1_000_000}
              step={1}
              value={maxJobs}
              onChange={(event) => setMaxJobs(event.target.value)}
              placeholder="Not set"
            />
          </Field>
        </div>
        <Button size="sm" disabled={limits.loading || Boolean(busy)} onClick={loadLimits}>
          Refresh limits
        </Button>
      </div>
      <QueueLimitReadback
        snapshot={limits.snapshot}
        loading={limits.loading}
        error={limits.error}
      />
      {actionError && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {actionError}
        </p>
      )}
      <div className="mt-6 grid gap-6 xl:grid-cols-[0.8fr_1.2fr]">
        <QueueDeduplicationConsole
          key={`${queue}:deduplication`}
          queue={queue}
          repository={repository}
          busy={busy}
          run={run}
        />
        <QueueTelemetryConsole
          key={`${queue}:telemetry`}
          queue={queue}
          repository={repository}
          busy={busy}
          run={run}
        />
      </div>
    </Card>
  );
}

function optionalMaxJobs(value: string): number | undefined | null {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 1_000_000 ? parsed : null;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
