import { useState } from 'react';
import { flowOperationError } from '@/lib/flowOperationPolicy';
import type {
  FlowInspectOperation,
  FlowMutationOperation,
  FlowOperationsRepository,
  FlowTarget,
} from '../application/FlowOperationsRepository';
import { bqFlowOperationsRepository } from '../infrastructure/bqFlowOperationsRepository';
import { FlowJson } from './FlowJson';
import { FlowTargetFields } from './FlowTargetFields';
import { flowRequestKey, useLatestFlowRequest } from './useLatestFlowRequest';

const INSPECTIONS: FlowInspectOperation[] = [
  'getChildrenValues',
  'getDependencies',
  'getDependenciesCount',
  'getFailedChildrenValues',
  'getIgnoredChildrenFailures',
];
const MUTATIONS: Array<{ id: FlowMutationOperation; label: string; dangerous?: boolean }> = [
  { id: 'removeChildDependency', label: 'Release dependency', dangerous: true },
  { id: 'removeUnprocessedChildren', label: 'Remove unprocessed children', dangerous: true },
  { id: 'retry', label: 'Retry job' },
  { id: 'promote', label: 'Promote delayed job' },
  { id: 'remove', label: 'Remove job', dangerous: true },
];

export function FlowDependencyConsole({
  repository = bqFlowOperationsRepository,
  initialTarget = { id: '', queueName: '' },
  target: controlledTarget,
  onTargetChange,
  showTarget = true,
}: {
  repository?: FlowOperationsRepository;
  initialTarget?: FlowTarget;
  target?: FlowTarget;
  onTargetChange?: (target: FlowTarget) => void;
  showTarget?: boolean;
}) {
  const [localTarget, setLocalTarget] = useState<FlowTarget>(initialTarget);
  const target = controlledTarget ?? localTarget;
  const setTarget = onTargetChange ?? setLocalTarget;
  const request = useLatestFlowRequest<unknown>(
    flowRequestKey(target.id, target.queueName),
    'dependency-console'
  );
  const busy = request.busy;
  const valid = Boolean(target.id.trim() && target.queueName.trim());
  const inspect = (operation: FlowInspectOperation) => {
    const pinnedTarget = cleanTarget(target);
    void request.run(operation, () => repository.inspect(pinnedTarget, operation));
  };
  const mutate = (operation: FlowMutationOperation) => {
    const error = flowOperationError(operation);
    if (error) return request.reject(error);
    const pinnedTarget = cleanTarget(target);
    if (
      !window.confirm(
        `${operation} on ${pinnedTarget.id} in ${pinnedTarget.queueName}? This changes durable queue state and has no compare-and-swap precondition.`
      )
    )
      return;
    void request.run(operation, () => repository.mutate(pinnedTarget, operation), {
      exclusive: true,
    });
  };
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(360px,0.8fr)_minmax(0,1.2fr)]">
      <section className="rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-fg">Dependency control</h2>
        <p className="mt-1 text-xs text-faint">
          Run the official Flow Job dependency methods against the managed server TCP endpoint.
        </p>
        {showTarget && (
          <div className="mt-4">
            <FlowTargetFields target={target} onChange={setTarget} />
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          Payload replacement, retry and removal are unavailable because they can damage flow
          dependencies or restart active work.
        </p>
        <h3 className="mt-5 mb-2 text-[10px] font-semibold uppercase tracking-wider text-faint">
          Inspect
        </h3>
        <div className="flex flex-wrap gap-2">
          {INSPECTIONS.map((operation) => (
            <button
              key={operation}
              type="button"
              disabled={!valid || Boolean(busy)}
              onClick={() => inspect(operation)}
              className="rounded-md border border-line px-2.5 py-1.5 font-mono text-[11px] text-muted disabled:opacity-40"
            >
              {operation}
            </button>
          ))}
        </div>
        <h3 className="mt-5 mb-2 text-[10px] font-semibold uppercase tracking-wider text-faint">
          Mutate
        </h3>
        <div className="flex flex-wrap gap-2">
          {MUTATIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={!valid || Boolean(busy) || Boolean(flowOperationError(action.id))}
              title={flowOperationError(action.id) ?? undefined}
              onClick={() => mutate(action.id)}
              className={
                action.dangerous
                  ? 'rounded-md border border-danger/40 px-2.5 py-1.5 text-xs text-danger disabled:opacity-40'
                  : 'rounded-md border border-line px-2.5 py-1.5 text-xs text-muted disabled:opacity-40'
              }
            >
              {action.label}
            </button>
          ))}
        </div>
      </section>
      <section className="rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-fg">Operation result</h2>
        <p className="mt-1 mb-4 text-xs text-faint">
          {busy ? `Running ${busy}…` : 'The last authoritative broker response appears here.'}
        </p>
        {request.error && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {request.error}
          </p>
        )}
        {request.result !== undefined ? (
          <FlowJson value={request.result} />
        ) : (
          <p className="text-sm text-muted">Choose an inspection or mutation.</p>
        )}
      </section>
    </div>
  );
}

const cleanTarget = (target: FlowTarget): FlowTarget => ({
  id: target.id.trim(),
  queueName: target.queueName.trim(),
});
