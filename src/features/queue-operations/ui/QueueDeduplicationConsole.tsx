import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/form';
import type { QueueOperationsRepository } from '../application/QueueOperationsRepository';
import type { QueueOperationRunner } from './QueueOperationsPanel';

export function QueueDeduplicationConsole({
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
  const [id, setId] = useState('');
  const [owner, setOwner] = useState<string | null | undefined>();
  const [receipt, setReceipt] = useState('');
  const valid = id.length > 0 && id.length <= 1024;
  const lookup = () =>
    run('Looking up deduplication key', () => repository.deduplicationJobId(queue, id), setOwner);
  const remove = () => {
    if (
      !window.confirm(
        `Remove deduplication key "${id}" from queue "${queue}"? The job is not deleted, but a later enqueue may reuse this key.`
      )
    )
      return;
    run(
      'Removing deduplication key',
      () => repository.removeDeduplicationKey(queue, id),
      (removed) => {
        setReceipt(removed ? 'Deduplication key removed.' : 'No matching key was active.');
        setOwner(undefined);
      },
      true
    );
  };
  return (
    <section
      aria-labelledby="queue-dedup-title"
      className="border-t border-line pt-4 xl:border-t-0"
    >
      <h3 id="queue-dedup-title" className="text-sm font-semibold text-fg">
        Deduplication registry
      </h3>
      <p className="mt-1 mb-4 text-xs leading-5 text-faint">
        Resolve an official deduplication ID to its current job, or release only the registry key.
      </p>
      <Field label="Deduplication ID">
        <Input
          name="queue-sdk-deduplication-id"
          autoComplete="off"
          spellCheck={false}
          maxLength={1024}
          value={id}
          onChange={(event) => {
            setId(event.target.value);
            setOwner(undefined);
            setReceipt('');
          }}
        />
      </Field>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={!valid || Boolean(busy)} onClick={lookup}>
          Find owner
        </Button>
        <Button variant="warning" size="sm" disabled={!valid || Boolean(busy)} onClick={remove}>
          Remove key
        </Button>
      </div>
      {owner !== undefined && (
        <p role="status" className="mt-3 break-all text-xs text-muted">
          {owner === null ? 'No active owner.' : `Current job: ${owner}`}
        </p>
      )}
      {receipt && (
        <p role="status" className="mt-3 text-xs text-success">
          {receipt}
        </p>
      )}
    </section>
  );
}
