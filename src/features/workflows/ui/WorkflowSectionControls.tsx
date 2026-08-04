import type { ComponentProps } from 'react';
import type { WorkflowStateFilter } from '@/lib/bqTypes';
import { WorkflowFilters } from './WorkflowFilters';
import { WorkflowNameFilter } from './WorkflowNameFilter';

export function WorkflowSectionControls(props: ComponentProps<typeof WorkflowFilters>) {
  if (props.section.id === 'overview') return null;
  if (props.section.id === 'executions') return <WorkflowFilters {...props} />;
  return (
    <div className="mb-5 flex items-end gap-4 rounded-lg border border-line bg-surface px-4 py-3">
      <WorkflowNameFilter
        value={props.workflowName}
        stats={props.stats}
        onChange={props.onWorkflowName}
      />
      {props.section.id === 'archive' && (
        <label className="text-xs text-faint">
          Outcome
          <select
            value={props.state}
            onChange={(event) => props.onState(event.target.value as WorkflowStateFilter | '')}
            className="mt-1 block h-9 min-w-36 rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg"
          >
            <option value="">All outcomes</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>
        </label>
      )}
      <span className="ml-auto pb-2 text-xs text-faint">
        {props.total ?? 0} {props.section.id === 'archive' ? 'records' : 'executions'}
      </span>
    </div>
  );
}
