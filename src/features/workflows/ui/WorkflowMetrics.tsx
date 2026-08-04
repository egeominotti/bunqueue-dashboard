import type { WorkflowStats } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';

const METRICS = [
  ['Active', 'activeTotal', 'text-fg'],
  ['Running', 'running', 'text-blue-400'],
  ['Waiting', 'waiting', 'text-warning'],
  ['Completed', 'completed', 'text-success'],
  ['Failed', 'failed', 'text-danger'],
  ['Compensating', 'compensating', 'text-violet-400'],
  ['Stuck', 'compensation-stuck', 'text-danger'],
] as const;

export function WorkflowMetrics({ stats }: { stats: WorkflowStats }) {
  return (
    <dl className="mb-4 grid grid-cols-2 divide-x divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface sm:grid-cols-4 xl:grid-cols-7 xl:divide-y-0">
      {METRICS.map(([label, key, tone]) => (
        <div key={key} className="px-3 py-2.5 first:border-0">
          <dt className="text-[10px] font-medium uppercase tracking-wider text-faint">{label}</dt>
          <dd className={cn('mt-1 tnum font-mono text-lg font-semibold', tone)}>
            {key === 'activeTotal' ? stats.activeTotal : stats.states[key]}
          </dd>
        </div>
      ))}
    </dl>
  );
}
