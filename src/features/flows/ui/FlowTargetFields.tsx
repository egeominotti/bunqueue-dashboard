import type { FlowTarget } from '../application/FlowOperationsRepository';

export function FlowTargetFields({
  target,
  onChange,
}: {
  target: FlowTarget;
  onChange: (target: FlowTarget) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs text-faint">
        Job ID
        <input
          aria-label="Flow job ID"
          value={target.id}
          onChange={(event) => onChange({ ...target, id: event.target.value })}
          className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-2 px-3 font-mono text-sm text-fg"
        />
      </label>
      <label className="text-xs text-faint">
        Queue name
        <input
          aria-label="Flow queue name"
          value={target.queueName}
          onChange={(event) => onChange({ ...target, queueName: event.target.value })}
          className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg"
        />
      </label>
    </div>
  );
}
