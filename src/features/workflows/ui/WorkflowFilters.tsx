import { Card } from '@/components/ui/Card';
import type { WorkflowStateFilter, WorkflowStats, WorkflowStoreKind } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import type { WorkflowSection } from '../domain/workflowSections';

export const WORKFLOW_STATES: Array<WorkflowStateFilter | ''> = [
  '',
  'running',
  'waiting',
  'completed',
  'failed',
  'compensating',
  'compensation-stuck',
  'compensation',
];

export function WorkflowFilters({
  section,
  kind,
  workflowName,
  state,
  stats,
  total,
  onKind,
  onWorkflowName,
  onState,
}: {
  section: WorkflowSection;
  kind: WorkflowStoreKind;
  workflowName: string;
  state: WorkflowStateFilter | '';
  stats?: WorkflowStats;
  total?: number;
  onKind: (kind: WorkflowStoreKind) => void;
  onWorkflowName: (name: string) => void;
  onState: (state: WorkflowStateFilter | '') => void;
}) {
  return (
    <Card className="mb-5">
      <div className="flex flex-wrap items-end gap-3">
        {section.lockKind ? (
          <LockedValue
            label="Store"
            value={`${section.kind}${section.kind === 'archive' && stats ? ` · ${stats.archiveTotal}` : ''}`}
            capitalize
          />
        ) : (
          <StoreSelector kind={kind} archiveTotal={stats?.archiveTotal} onChange={onKind} />
        )}
        <label className="text-xs text-faint">
          Workflow
          <select
            value={workflowName}
            onChange={(event) => onWorkflowName(event.target.value)}
            className="mt-1 block h-9 min-w-48 rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg"
          >
            <option value="">All workflows</option>
            {stats?.workflowNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {section.lockState ? (
          <LockedValue
            label="State scope"
            value={section.state === 'compensation' ? 'Compensating + stuck' : section.state}
          />
        ) : (
          <StateSelector state={state} onChange={onState} />
        )}
        {total !== undefined && (
          <span className="ml-auto text-xs text-faint">
            {total} execution{total === 1 ? '' : 's'}
          </span>
        )}
      </div>
    </Card>
  );
}

function StoreSelector({
  kind,
  archiveTotal,
  onChange,
}: {
  kind: WorkflowStoreKind;
  archiveTotal?: number;
  onChange: (kind: WorkflowStoreKind) => void;
}) {
  return (
    <div>
      <span className="mb-1 block text-xs text-faint">Store</span>
      <div className="flex rounded-lg border border-line p-0.5">
        {(['active', 'archive'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={kind === value}
            onClick={() => onChange(value)}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs capitalize',
              kind === value ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg'
            )}
          >
            {value}
            {value === 'archive' && archiveTotal !== undefined ? ` (${archiveTotal})` : ''}
          </button>
        ))}
      </div>
    </div>
  );
}

function StateSelector({
  state,
  onChange,
}: {
  state: WorkflowStateFilter | '';
  onChange: (state: WorkflowStateFilter | '') => void;
}) {
  return (
    <label className="text-xs text-faint">
      State
      <select
        value={state}
        onChange={(event) => onChange(event.target.value as WorkflowStateFilter | '')}
        className="mt-1 block h-9 min-w-44 rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg"
      >
        {WORKFLOW_STATES.map((value) => (
          <option key={value || 'all'} value={value}>
            {value === 'compensation' ? 'All compensation' : value || 'All states'}
          </option>
        ))}
      </select>
    </label>
  );
}

function LockedValue({
  label,
  value,
  capitalize = false,
}: {
  label: string;
  value: string;
  capitalize?: boolean;
}) {
  return (
    <div>
      <span className="mb-1 block text-xs text-faint">{label}</span>
      <span
        className={cn(
          'inline-flex h-9 items-center rounded-lg border border-line bg-surface-2 px-3 text-xs text-fg',
          capitalize && 'capitalize'
        )}
      >
        {value}
      </span>
    </div>
  );
}
