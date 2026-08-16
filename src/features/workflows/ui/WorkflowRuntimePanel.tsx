import { useMemo, useState } from 'react';
import { ErrorState, OfflineBanner } from '@/components/ui/feedback';
import { usePolledData } from '@/lib/usePolledData';
import type { WorkflowControlRepository } from '../application/WorkflowControlRepository';
import { bqWorkflowControlRepository } from '../infrastructure/bqWorkflowControlRepository';
import { useWorkflowCommand } from './useWorkflowCommand';
import { JsonBlock } from './WorkflowValue';

export function WorkflowRuntimePanel({
  repository = bqWorkflowControlRepository,
  onApplied,
}: {
  repository?: WorkflowControlRepository;
  onApplied?: () => void | Promise<void>;
}) {
  const [workflowName, setWorkflowName] = useState('');
  const [input, setInput] = useState('{}');
  const commandScope = useMemo(
    () => Symbol(`workflow-runtime:${workflowName.length}:${input.length}`),
    [input, workflowName]
  );
  const status = usePolledData(() => repository.status(), [repository], { intervalMs: 5000 });
  const command = useWorkflowCommand({
    operationGroup: 'runtime',
    scopeKey: commandScope,
    onApplied: async () => {
      await status.refetch();
      await onApplied?.();
    },
  });
  const ready = status.data?.ready === true;

  const start = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return void command.run('start', async () => {
        throw new Error('Workflow input must be valid JSON.');
      });
    }
    void command.run('start', () => repository.start(workflowName.trim(), parsed));
  };

  return (
    <section className="mb-5 overflow-hidden rounded-lg border border-line bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">Workflow runtime</h2>
          <p className="mt-0.5 text-xs text-faint">
            Registered application handlers stay in the agent-side runtime; commands never edit
            SQLite directly.
          </p>
        </div>
        <RuntimeBadge
          ready={ready}
          configured={status.data?.configured === true}
          unavailable={Boolean(status.error && !status.data)}
        />
      </header>
      {status.data?.configured && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-line px-4 py-2 text-[11px] text-faint">
          <span>
            Module{' '}
            <strong className="font-mono font-medium text-muted">
              {status.data.moduleName ?? '—'}
            </strong>
          </span>
          <span>
            Queue{' '}
            <strong className="font-mono font-medium text-muted">
              {status.data.queueName ?? '—'}
            </strong>
          </span>
          <span>
            Concurrency{' '}
            <strong className="font-mono font-medium text-muted">
              {status.data.concurrency ?? '—'}
            </strong>
          </span>
        </div>
      )}
      {status.error && status.data && (
        <OfflineBanner
          message="Runtime status refresh failed; showing the last snapshot."
          onRetry={status.refetch}
        />
      )}
      {status.error && !status.data && (
        <div className="p-4">
          <ErrorState error={status.error} onRetry={status.refetch} />
        </div>
      )}
      <div className="grid gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-faint">
            Registered workflow
            <input
              aria-label="Registered workflow"
              list="workflow-runtime-names"
              value={workflowName}
              onChange={(event) => setWorkflowName(event.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg"
            />
            <datalist id="workflow-runtime-names">
              {status.data?.workflowNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <label className="text-xs text-faint">
            Input JSON
            <textarea
              aria-label="Workflow input JSON"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              className="mt-1 min-h-20 w-full resize-y rounded-lg border border-line bg-surface-2 p-2 font-mono text-xs text-fg"
            />
          </label>
        </div>
        <div className="flex flex-wrap content-start gap-2 lg:w-48 lg:flex-col">
          <button
            type="button"
            disabled={!ready || !workflowName.trim() || Boolean(command.busy)}
            onClick={start}
            className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-accent-fg disabled:opacity-40"
          >
            {command.busy === 'start' ? 'Starting…' : 'Start execution'}
          </button>
          <button
            type="button"
            disabled={!ready || Boolean(command.busy)}
            onClick={() => {
              if (
                window.confirm(
                  'Recover every orphaned workflow using the registered idempotent handlers?'
                )
              ) {
                void command.run('recover', () => repository.recover());
              }
            }}
            className="rounded-md border border-line px-3 py-2 text-xs text-muted disabled:opacity-40"
          >
            Recover orphaned
          </button>
          <button
            type="button"
            disabled={!status.data?.configured || Boolean(command.busy)}
            onClick={() => void command.run('reload', () => repository.reload())}
            className="rounded-md border border-line px-3 py-2 text-xs text-muted disabled:opacity-40"
          >
            Reload definitions
          </button>
        </div>
      </div>
      {!status.loading && !status.error && !status.data?.configured && (
        <p className="border-t border-line px-4 py-3 text-xs text-warning">
          Set <code>BUNQUEUE_WORKFLOW_MODULE</code> to an absolute module path in Server → Extra
          environment, then start the managed server.
        </p>
      )}
      {status.data?.error && (
        <p role="alert" className="border-t border-line px-4 py-3 text-xs text-danger">
          {status.data.error}
        </p>
      )}
      {command.error && (
        <p role="alert" className="border-t border-line px-4 py-3 text-xs text-danger">
          {command.error}
        </p>
      )}
      {command.result !== undefined && (
        <div className="border-t border-line p-4">
          <JsonBlock value={command.result} />
        </div>
      )}
    </section>
  );
}

function RuntimeBadge({
  ready,
  configured,
  unavailable,
}: {
  ready: boolean;
  configured: boolean;
  unavailable: boolean;
}) {
  const label = ready
    ? 'Handlers loaded'
    : unavailable
      ? 'Status unavailable'
      : configured
        ? 'Unavailable'
        : 'Not configured';
  return (
    <span
      className={
        ready
          ? 'rounded-full bg-success/10 px-2 py-1 text-[11px] text-success'
          : 'rounded-full bg-warning/10 px-2 py-1 text-[11px] text-warning'
      }
    >
      {label}
    </span>
  );
}
