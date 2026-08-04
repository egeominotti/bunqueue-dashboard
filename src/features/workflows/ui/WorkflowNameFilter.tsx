import type { WorkflowStats } from '@/lib/bqTypes';

export function WorkflowNameFilter({
  label = 'Workflow',
  value,
  stats,
  onChange,
}: {
  label?: string;
  value: string;
  stats?: WorkflowStats;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs text-faint">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block h-9 min-w-52 rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg"
      >
        <option value="">All workflows</option>
        {stats?.workflowNames.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
