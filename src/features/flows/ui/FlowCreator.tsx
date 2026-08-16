import { useState } from 'react';
import type {
  FlowCreateOperation,
  FlowOperationsRepository,
} from '../application/FlowOperationsRepository';
import { bqFlowOperationsRepository } from '../infrastructure/bqFlowOperationsRepository';
import { FlowJson } from './FlowJson';
import { flowRequestKey, useLatestFlowRequest } from './useLatestFlowRequest';

const TEMPLATES: Record<FlowCreateOperation, Record<string, unknown>> = {
  add: {
    flow: {
      name: 'aggregate',
      queueName: 'reports',
      data: {},
      children: [{ name: 'fetch', queueName: 'io', data: { source: 'orders' } }],
    },
    options: { queuesOptions: { io: { attempts: 3, backoff: 1000 } } },
  },
  addBulk: {
    flows: [
      { name: 'report-a', queueName: 'reports', data: { region: 'eu' } },
      { name: 'report-b', queueName: 'reports', data: { region: 'us' } },
    ],
  },
  addChain: {
    steps: [
      { name: 'extract', queueName: 'pipeline', data: {} },
      { name: 'transform', queueName: 'pipeline', data: {} },
      { name: 'load', queueName: 'pipeline', data: {} },
    ],
  },
  addBulkThen: {
    parallel: [
      { name: 'part-a', queueName: 'parallel', data: {} },
      { name: 'part-b', queueName: 'parallel', data: {} },
    ],
    final: { name: 'merge', queueName: 'final', data: {} },
  },
  addTree: {
    root: {
      name: 'root',
      queueName: 'tree',
      data: {},
      children: [{ name: 'child', queueName: 'tree', data: {} }],
    },
  },
};

export function FlowCreator({
  repository = bqFlowOperationsRepository,
  onOpen,
}: {
  repository?: FlowOperationsRepository;
  onOpen: (id: string) => void;
}) {
  const [operation, setOperation] = useState<FlowCreateOperation>('add');
  const [source, setSource] = useState(() => JSON.stringify(TEMPLATES.add, null, 2));
  const request = useLatestFlowRequest<unknown>(flowRequestKey(operation, source), 'creator');
  const busy = Boolean(request.busy);
  const changeOperation = (next: FlowCreateOperation) => {
    setOperation(next);
    setSource(JSON.stringify(TEMPLATES[next], null, 2));
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    let payload: unknown;
    try {
      payload = JSON.parse(source);
    } catch {
      return request.reject('The definition must be valid JSON.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return request.reject('The definition must be a JSON object.');
    const pinnedOperation = operation;
    await request.run(
      pinnedOperation,
      () => repository.create(pinnedOperation, payload as Record<string, unknown>),
      { exclusive: true }
    );
  };
  const rootId = createdRootId(request.result);
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.7fr)]">
      <form onSubmit={submit} className="rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="text-xs text-faint">
            FlowProducer method
            <select
              aria-label="FlowProducer method"
              value={operation}
              onChange={(event) => changeOperation(event.target.value as FlowCreateOperation)}
              className="mt-1 block h-9 rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg"
            >
              {Object.keys(TEMPLATES).map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {busy ? 'Creating…' : `Run ${operation}`}
          </button>
        </div>
        <label className="mt-4 block text-xs text-faint">
          Definition
          <textarea
            aria-label="Flow definition JSON"
            spellCheck={false}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className="mt-1 min-h-80 w-full resize-y rounded-lg border border-line bg-bg p-3 font-mono text-xs text-fg outline-none focus:ring-2 focus:ring-accent/50"
          />
        </label>
      </form>
      <section className="rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-fg">Atomic commit result</h2>
        <p className="mt-1 mb-4 text-xs text-faint">
          Validation is performed by Bunqueue before the graph is committed.
        </p>
        {request.error && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {request.error}
          </p>
        )}
        {request.result !== undefined ? (
          <>
            <FlowJson value={request.result} />
            {rootId && (
              <button
                type="button"
                onClick={() => onOpen(rootId)}
                className="mt-3 rounded-lg border border-line px-3 py-2 text-xs text-fg"
              >
                Open created flow
              </button>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">No flow created in this session.</p>
        )}
      </section>
    </div>
  );
}

export function createdRootId(value: unknown): string | null {
  const envelope = value as
    | {
        result?: {
          root?: { id?: unknown };
          roots?: Array<{ id?: unknown }>;
          jobIds?: unknown[];
          finalId?: unknown;
        };
      }
    | undefined;
  const id =
    envelope?.result?.root?.id ??
    envelope?.result?.roots?.[0]?.id ??
    envelope?.result?.finalId ??
    envelope?.result?.jobIds?.at(-1);
  return typeof id === 'string' ? id : null;
}
