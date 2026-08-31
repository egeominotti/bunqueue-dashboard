import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/form';
import type {
  QueueGroupSnapshot,
  QueueOperationsRepository,
} from '../application/QueueOperationsRepository';
import type { QueueOperationRunner } from './QueueOperationsPanel';

export function QueueGroupConsole({
  queue,
  repository,
  busy,
  run,
}: {
  queue: string;
  repository: QueueOperationsRepository;
  busy: string;
  run: QueueOperationRunner;
}) {
  const [groupId, setGroupId] = useState('default');
  const [maxJobs, setMaxJobs] = useState('');
  const [maxCount, setMaxCount] = useState('100');
  const [rateMax, setRateMax] = useState('100');
  const [duration, setDuration] = useState('60000');
  const [concurrency, setConcurrency] = useState('1');
  const [snapshot, setSnapshot] = useState<QueueGroupSnapshot | null>(null);

  const id = validGroupId(groupId);
  const read = () => {
    const threshold = optionalInteger(maxJobs, 0);
    const count = optionalInteger(maxCount, 1);
    if (!id || threshold === null || count === null) return;
    run('Reading group', () => repository.group(queue, id, threshold, count), setSnapshot);
  };
  const setRate = () => {
    const max = positiveInteger(rateMax);
    const milliseconds = positiveInteger(duration);
    if (!id || max === null || milliseconds === null) return;
    run(
      'Setting group rate limit',
      async () => {
        await repository.setGroupRateLimit(queue, id, max, milliseconds);
        return repository.group(queue, id);
      },
      setSnapshot,
      true
    );
  };
  const setConcurrencyLimit = () => {
    const value = positiveInteger(concurrency);
    if (!id || value === null) return;
    run(
      'Setting group concurrency',
      async () => {
        await repository.setGroupConcurrency(queue, id, value);
        return repository.group(queue, id);
      },
      setSnapshot,
      true
    );
  };

  return (
    <section className="xl:col-span-2" aria-labelledby="queue-groups-title">
      <h3 id="queue-groups-title" className="mb-3 text-sm font-medium text-fg">
        Groups
      </h3>
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Field label="Group ID">
          <Input
            value={groupId}
            maxLength={256}
            onChange={(event) => setGroupId(event.target.value)}
          />
        </Field>
        <Field label="TTL maxJobs" hint="Optional">
          <Input
            type="number"
            min={0}
            value={maxJobs}
            onChange={(event) => setMaxJobs(event.target.value)}
          />
        </Field>
        <Field label="Groups maxCount">
          <Input
            type="number"
            min={1}
            value={maxCount}
            onChange={(event) => setMaxCount(event.target.value)}
          />
        </Field>
        <Field label="Rate max">
          <Input
            type="number"
            min={1}
            value={rateMax}
            onChange={(event) => setRateMax(event.target.value)}
          />
        </Field>
        <Field label="Duration (ms)">
          <Input
            type="number"
            min={1}
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
          />
        </Field>
        <Field label="Concurrency">
          <Input
            type="number"
            min={1}
            value={concurrency}
            onChange={(event) => setConcurrency(event.target.value)}
          />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={Boolean(busy) || !id} onClick={read}>
          Read group
        </Button>
        <Button size="sm" disabled={Boolean(busy) || !id} onClick={setRate}>
          Set rate limit
        </Button>
        <Button
          size="sm"
          disabled={Boolean(busy) || !id}
          onClick={() =>
            run(
              'Clearing group rate limit',
              async () => {
                await repository.removeGroupRateLimit(queue, id!);
                return repository.group(queue, id!);
              },
              setSnapshot,
              true
            )
          }
        >
          Clear rate limit
        </Button>
        <Button size="sm" disabled={Boolean(busy) || !id} onClick={setConcurrencyLimit}>
          Set concurrency
        </Button>
        <Button
          size="sm"
          disabled={Boolean(busy) || !id}
          onClick={() =>
            run(
              'Clearing group concurrency',
              async () => {
                await repository.removeGroupConcurrency(queue, id!);
                return repository.group(queue, id!);
              },
              setSnapshot,
              true
            )
          }
        >
          Clear concurrency
        </Button>
      </div>
      {!id && (
        <p role="alert" className="mt-3 text-xs text-danger">
          Group ID must contain 1–256 characters and no NUL.
        </p>
      )}
      {snapshot && (
        <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-line p-3 text-xs sm:grid-cols-6">
          <Readback label="Jobs" value={snapshot.jobs} />
          <Readback label="Active" value={snapshot.active} />
          <Readback label="All grouped" value={snapshot.totalGrouped} />
          <Readback
            label="Rate"
            value={
              snapshot.rateLimit
                ? `${snapshot.rateLimit.max}/${snapshot.rateLimit.duration}ms`
                : 'None'
            }
          />
          <Readback label="TTL" value={`${snapshot.rateLimitTtl} ms`} />
          <Readback label="Concurrency" value={snapshot.concurrency ?? 'None'} />
        </dl>
      )}
    </section>
  );
}

function Readback({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className="mt-1 font-mono text-fg">{value}</dd>
    </div>
  );
}

const validGroupId = (value: string) =>
  value.length >= 1 && value.length <= 256 && !value.includes('\0') ? value : null;
const positiveInteger = (value: string) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const optionalInteger = (value: string, minimum: number) => {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
};
