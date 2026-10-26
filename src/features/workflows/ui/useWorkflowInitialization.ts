import { useEffect, useRef } from 'react';
import { useControlConnectionEpoch } from '@/lib/controlConnectionEpoch';
import type { PolledData } from '@/lib/usePolledData';
import type {
  WorkflowControlRepository,
  WorkflowRuntimeStatus,
} from '../application/WorkflowControlRepository';
import { useWorkflowCommand } from './useWorkflowCommand';

/** Opening Workflow initializes handlers through an authenticated, idempotent POST. */
export function useWorkflowInitialization(
  repository: WorkflowControlRepository,
  status: PolledData<WorkflowRuntimeStatus>
) {
  const epoch = useControlConnectionEpoch();
  const attempted = useRef<{ repository: WorkflowControlRepository; key: string } | null>(null);
  const command = useWorkflowCommand({
    operationGroup: 'runtime-initialization',
    scopeKey: repository,
    onApplied: status.refetch,
  });
  useEffect(() => {
    if (status.data?.ready) attempted.current = null;
    if (!status.data?.needsInitialization || status.error || command.busy) return;
    const key = JSON.stringify([epoch, status.data.moduleName]);
    if (attempted.current?.repository === repository && attempted.current.key === key) return;
    attempted.current = { repository, key };
    void command.run('initialize', () => repository.initialize());
  }, [command, epoch, repository, status.data, status.error]);
  return command;
}
