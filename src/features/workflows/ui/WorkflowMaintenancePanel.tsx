import { useMemo, useState } from 'react';
import type {
  WorkflowControlRepository,
  WorkflowTerminalState,
} from '../application/WorkflowControlRepository';
import { bqWorkflowControlRepository } from '../infrastructure/bqWorkflowControlRepository';
import { useWorkflowCommand } from './useWorkflowCommand';
import { JsonBlock } from './WorkflowValue';

const HOUR = 60 * 60 * 1_000;

export function WorkflowMaintenancePanel({
  repository = bqWorkflowControlRepository,
  onApplied,
}: {
  repository?: WorkflowControlRepository;
  onApplied?: () => void | Promise<void>;
}) {
  const [hours, setHours] = useState('720');
  const [completed, setCompleted] = useState(true);
  const [failed, setFailed] = useState(true);
  const commandScope = useMemo(
    () => Symbol(`workflow-maintenance:${hours.length}:${completed}:${failed}`),
    [completed, failed, hours]
  );
  const command = useWorkflowCommand({
    operationGroup: 'maintenance',
    scopeKey: commandScope,
    onApplied,
  });
  const states: WorkflowTerminalState[] = [
    ...(completed ? (['completed'] as const) : []),
    ...(failed ? (['failed'] as const) : []),
  ];
  const parsedHours = Number(hours);
  const valid = Number.isFinite(parsedHours) && parsedHours >= 0 && states.length > 0;
  const run = (operation: 'archive' | 'cleanup') => {
    if (!valid) return;
    const prompt =
      operation === 'archive'
        ? `Archive ${states.join(' and ')} workflows at least ${parsedHours} hours old?`
        : `Permanently delete ${states.join(' and ')} workflows at least ${parsedHours} hours old from the active execution store? Archive records are not deleted.`;
    if (!window.confirm(prompt)) return;
    const age = Math.round(parsedHours * HOUR);
    void command.run(operation, async () => ({
      operation,
      affected:
        operation === 'archive'
          ? await repository.archive(age, states)
          : await repository.cleanup(age, states),
    }));
  };
  return (
    <section className="mb-5 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">Retention operations</h2>
          <p className="mt-1 text-xs text-faint">
            Archive moves terminal runs into retention. Cleanup permanently deletes eligible
            terminal runs from the active store only; archive records remain intact.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-faint">
            Minimum age (hours)
            <input
              aria-label="Workflow retention age hours"
              type="number"
              min="0"
              step="1"
              value={hours}
              onChange={(event) => setHours(event.target.value)}
              className="mt-1 block h-9 w-32 rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg"
            />
          </label>
          <label className="flex h-9 items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={completed}
              onChange={(event) => setCompleted(event.target.checked)}
            />
            Completed
          </label>
          <label className="flex h-9 items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={failed}
              onChange={(event) => setFailed(event.target.checked)}
            />
            Failed
          </label>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!valid || Boolean(command.busy)}
          onClick={() => run('archive')}
          className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-accent-fg disabled:opacity-40"
        >
          Archive eligible
        </button>
        <button
          type="button"
          disabled={!valid || Boolean(command.busy)}
          onClick={() => run('cleanup')}
          className="rounded-md border border-danger/40 px-3 py-2 text-xs text-danger disabled:opacity-40"
        >
          Delete eligible
        </button>
      </div>
      {command.error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {command.error}
        </p>
      )}
      {command.result !== undefined && (
        <div className="mt-3">
          <JsonBlock value={command.result} />
        </div>
      )}
    </section>
  );
}
