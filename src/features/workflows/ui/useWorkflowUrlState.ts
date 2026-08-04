import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { WorkflowSection, WorkflowSelection } from '../domain/workflowSections';
import {
  patchWorkflowSearchParams,
  readWorkflowUrlState,
  type WorkflowUrlPatch,
  workflowSearchParams,
} from '../domain/workflowUrlState';

export function useWorkflowUrlState(section: WorkflowSection) {
  const [params, setParams] = useSearchParams();
  const serialized = params.toString();
  const value = useMemo(
    () => readWorkflowUrlState(new URLSearchParams(serialized), section),
    [serialized, section]
  );
  const canonical = useMemo(
    () => workflowSearchParams(section, value).toString(),
    [section, value]
  );
  const selectionSource = useRef<WorkflowSelection | null>(null);

  useEffect(() => {
    if (canonical !== serialized) setParams(canonical, { replace: true });
  }, [canonical, serialized, setParams]);

  const update = useCallback(
    (patch: WorkflowUrlPatch, replace = false) => {
      setParams((current) => patchWorkflowSearchParams(current, section, patch), { replace });
    },
    [section, setParams]
  );

  const select = useCallback(
    (selection: WorkflowSelection | null, replace = false) => {
      selectionSource.current = selection;
      update(
        {
          executionId: selection?.id ?? null,
          tab: 'summary',
        },
        replace
      );
    },
    [update]
  );

  const selected: WorkflowSelection | null = value.executionId
    ? {
        id: value.executionId,
        source:
          selectionSource.current?.id === value.executionId
            ? selectionSource.current.source
            : 'link',
      }
    : null;

  return { ...value, selected, update, select };
}
