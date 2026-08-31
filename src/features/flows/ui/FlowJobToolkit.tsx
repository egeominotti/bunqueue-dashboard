import { useState } from 'react';
import type {
  FlowInspectOperation,
  FlowMutationOperation,
  FlowOperationsRepository,
  FlowTarget,
} from '../application/FlowOperationsRepository';
import { bqFlowOperationsRepository } from '../infrastructure/bqFlowOperationsRepository';
import { FlowDependencyConsole } from './FlowDependencyConsole';
import { FlowJson } from './FlowJson';
import { FlowParentResults } from './FlowParentResults';
import { FlowTargetFields } from './FlowTargetFields';
import { FlowTreeReader } from './FlowTreeReader';
import { flowRequestKey, useLatestFlowRequest } from './useLatestFlowRequest';

const INSPECTIONS: FlowInspectOperation[] = [
  'getState',
  'isWaiting',
  'isActive',
  'isDelayed',
  'isCompleted',
  'isFailed',
  'isWaitingChildren',
  'toJSON',
  'asJSON',
];
const TEMPLATES = {
  updateData: { data: {} },
  updateProgress: { progress: 50, message: 'Halfway' },
  log: { message: 'Operator note' },
  changeDelay: { delay: 1000 },
  changePriority: { priority: 1, lifo: false },
  clearLogs: { keepLogs: 0 },
  removeDeduplicationKey: {},
} satisfies Partial<Record<FlowMutationOperation, Record<string, unknown>>>;
const OBJECT_PROGRESS_TEMPLATE = {
  progress: { stage: 'hydrate', completed: 4, total: 10 },
};
type PayloadOperation = keyof typeof TEMPLATES;

export function FlowJobToolkit({
  repository = bqFlowOperationsRepository,
  initialTarget = { id: '', queueName: '' },
}: {
  repository?: FlowOperationsRepository;
  initialTarget?: FlowTarget;
}) {
  const [target, setTarget] = useState<FlowTarget>(initialTarget);
  const [operation, setOperation] = useState<PayloadOperation>('updateData');
  const [source, setSource] = useState(JSON.stringify(TEMPLATES.updateData, null, 2));
  const [ttl, setTtl] = useState('30000');
  const request = useLatestFlowRequest<unknown>(
    flowRequestKey(target.id, target.queueName, operation, source, ttl),
    'job-toolkit'
  );
  const busy = request.busy;
  const valid = Boolean(target.id.trim() && target.queueName.trim());
  const changeOperation = (next: PayloadOperation) => {
    setOperation(next);
    setSource(JSON.stringify(TEMPLATES[next], null, 2));
  };
  const mutate = () => {
    let payload: unknown;
    try {
      payload = JSON.parse(source);
    } catch {
      return request.reject('Mutation payload must be valid JSON.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return request.reject('Mutation payload must be a JSON object.');
    }
    const pinnedTarget = clean(target);
    const pinnedOperation = operation;
    if (
      !window.confirm(
        `${pinnedOperation} on ${pinnedTarget.id}? This writes durable job state without a compare-and-swap precondition.`
      )
    )
      return;
    void request.run(
      pinnedOperation,
      () => repository.mutate(pinnedTarget, pinnedOperation, payload as Record<string, unknown>),
      { exclusive: true }
    );
  };
  return (
    <div className="space-y-5">
      <FlowTreeReader repository={repository} target={target} onTargetChange={setTarget} />
      <section className="rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">Flow Job methods</h2>
            <p className="mt-1 text-xs text-faint">
              State predicates, serialization, bounded waiting, and durable mutations from Bunqueue
              2.9.0.
            </p>
          </div>
          {busy && <span className="font-mono text-xs text-accent">{busy}…</span>}
        </div>
        <div className="mt-4">
          <FlowTargetFields target={target} onChange={setTarget} />
        </div>
        <h3 className="mt-5 mb-2 text-[10px] font-semibold uppercase tracking-wider text-faint">
          Inspect state and wire JSON
        </h3>
        <div className="flex flex-wrap gap-2">
          {INSPECTIONS.map((item) => (
            <button
              key={item}
              type="button"
              disabled={!valid || Boolean(busy)}
              onClick={() => {
                const pinnedTarget = clean(target);
                void request.run(item, () => repository.inspect(pinnedTarget, item));
              }}
              className="rounded-md border border-line px-2.5 py-1.5 font-mono text-[11px] text-muted disabled:opacity-40"
            >
              {item}
            </button>
          ))}
        </div>
        <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.7fr)]">
          <div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-faint">
                Mutation
                <select
                  aria-label="Flow Job mutation"
                  value={operation}
                  onChange={(event) => changeOperation(event.target.value as PayloadOperation)}
                  className="mt-1 block h-9 rounded-lg border border-line bg-surface-2 px-3 font-mono text-xs text-fg"
                >
                  {Object.keys(TEMPLATES).map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!valid || Boolean(busy)}
                onClick={mutate}
                className="h-9 rounded-md border border-warning/40 px-3 text-xs text-warning disabled:opacity-40"
              >
                Apply mutation
              </button>
              {operation === 'updateProgress' && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSource(JSON.stringify(TEMPLATES.updateProgress, null, 2))}
                    className="h-9 rounded-md border border-line px-3 text-xs text-muted"
                  >
                    Numeric progress
                  </button>
                  <button
                    type="button"
                    onClick={() => setSource(JSON.stringify(OBJECT_PROGRESS_TEMPLATE, null, 2))}
                    className="h-9 rounded-md border border-line px-3 text-xs text-muted"
                  >
                    Object progress
                  </button>
                </div>
              )}
            </div>
            <textarea
              aria-label="Flow Job mutation JSON"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              className="mt-3 min-h-32 w-full resize-y rounded-lg border border-line bg-bg p-3 font-mono text-xs text-fg"
            />
          </div>
          <div>
            <label className="text-xs text-faint">
              waitUntilFinished TTL (ms)
              <input
                aria-label="Flow wait TTL"
                type="number"
                min="1"
                max="60000"
                value={ttl}
                onChange={(event) => setTtl(event.target.value)}
                className="mt-1 block h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg"
              />
            </label>
            <button
              type="button"
              disabled={!valid || Boolean(busy) || !validTtl(ttl)}
              onClick={() => {
                const pinnedTarget = clean(target);
                const pinnedTtl = Number(ttl);
                void request.run('waitUntilFinished', () =>
                  repository.waitUntilFinished(pinnedTarget, pinnedTtl)
                );
              }}
              className="mt-3 rounded-md border border-line px-3 py-2 font-mono text-xs text-muted disabled:opacity-40"
            >
              waitUntilFinished
            </button>
            <p className="mt-3 text-[11px] leading-5 text-faint">
              Lease-only methods are not forged here: extendLock and worker state transitions
              require the active worker token; discard is process-local and non-awaitable.
            </p>
          </div>
        </div>
        {request.error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {request.error}
          </p>
        )}
        {request.result !== undefined && (
          <div className="mt-4">
            <FlowJson value={request.result} />
          </div>
        )}
      </section>
      <FlowDependencyConsole
        repository={repository}
        target={target}
        onTargetChange={setTarget}
        showTarget={false}
      />
      <FlowParentResults repository={repository} />
    </div>
  );
}

const clean = (target: FlowTarget): FlowTarget => ({
  id: target.id.trim(),
  queueName: target.queueName.trim(),
});
const validTtl = (value: string) =>
  Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 60_000;
