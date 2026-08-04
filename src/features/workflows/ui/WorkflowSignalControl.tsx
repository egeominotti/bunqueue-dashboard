import { useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import type { WorkflowControlRepository } from '../application/WorkflowControlRepository';
import { useWorkflowCommand } from './useWorkflowCommand';
import { JsonBlock } from './WorkflowValue';

export function WorkflowSignalControl({
  repository,
  executionId,
  onApplied,
}: {
  repository: WorkflowControlRepository;
  executionId: string;
  onApplied?: () => void | Promise<void>;
}) {
  const [event, setEvent] = useState('');
  const [payload, setPayload] = useState('{}');
  const command = useWorkflowCommand({
    scopeKey: executionId,
    onApplied,
    onSucceeded: () =>
      toast.success('Workflow signal accepted', `${event.trim()} · ${executionId}`),
  });
  const send = () => {
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      return void command.run('signal', async () => {
        throw new Error('Signal payload must be valid JSON.');
      });
    }
    if (!window.confirm(`Send durable signal "${event.trim()}" to ${executionId}?`)) return;
    void command.run('signal', () => repository.signal(executionId, event.trim(), value));
  };
  return (
    <div className="border-t border-line p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-faint">Send signal</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-faint">
          Event name
          <input
            aria-label="Workflow signal event"
            value={event}
            onChange={(change) => setEvent(change.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-2 px-3 font-mono text-sm text-fg"
          />
        </label>
        <label className="text-xs text-faint">
          Payload JSON
          <textarea
            aria-label="Workflow signal payload"
            value={payload}
            onChange={(change) => setPayload(change.target.value)}
            className="mt-1 min-h-20 w-full resize-y rounded-lg border border-line bg-surface-2 p-2 font-mono text-xs text-fg"
          />
        </label>
      </div>
      <button
        type="button"
        disabled={!event.trim() || Boolean(command.busy)}
        onClick={send}
        className="mt-3 rounded-md bg-accent px-3 py-2 text-xs font-medium text-accent-fg disabled:opacity-40"
      >
        {command.busy ? 'Sending…' : 'Send durable signal'}
      </button>
      {command.error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {command.error}
        </p>
      )}
      {command.succeeded && (
        <p role="status" className="mt-3 text-xs text-success">
          Durable signal accepted; execution and list refreshed.
        </p>
      )}
      {command.result !== undefined && (
        <div className="mt-3">
          <JsonBlock value={command.result} />
        </div>
      )}
    </div>
  );
}
