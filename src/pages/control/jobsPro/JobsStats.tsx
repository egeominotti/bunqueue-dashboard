import { useId, useState } from 'react';
import { StatCard } from '@/components/ui/StatCard';
import { cn } from '@/lib/cn';

interface JobsStatsProps {
  total: string;
  waiting: string;
  prioritized: string;
  active: string;
  flowBlocked: string;
  completed: string;
  failed: string;
  failedCount: number | null;
  errorRate: string;
  errorRateTone: 'default' | 'red' | 'green';
}

export function JobsStats(props: JobsStatsProps) {
  const [expanded, setExpanded] = useState(false);
  const statisticsId = useId();
  return (
    <div className="mb-6">
      <div className="rounded-xl border border-line bg-surface p-3 md:hidden">
        <dl aria-label="Job summary" className="grid grid-cols-3 gap-3 text-xs">
          {[
            ['Total', props.total],
            ['Active', props.active],
            ['Failed', props.failed],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-faint">{label}</dt>
              <dd className="mt-1 break-words font-semibold tnum text-fg">{value}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={statisticsId}
          onClick={() => setExpanded((value) => !value)}
          className="mt-2 min-h-[44px] w-full rounded-lg border border-line text-xs font-medium text-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {expanded ? 'Hide detailed statistics' : 'Show all 8 statistics'}
        </button>
      </div>
      <div
        id={statisticsId}
        className={cn(
          'mt-3 grid-cols-2 gap-3 md:mt-0 md:grid md:grid-cols-4 md:gap-4 xl:grid-cols-8',
          expanded ? 'grid' : 'hidden'
        )}
      >
        <StatCard label="Total" value={props.total} hint="all queues" compact />
        <StatCard
          label="Waiting"
          value={props.waiting}
          tone="amber"
          hint="standard priority"
          compact
        />
        <StatCard label="Prioritized" value={props.prioritized} tone="amber" compact />
        <StatCard label="Active" value={props.active} tone="blue" compact />
        <StatCard label="Flow-blocked" value={props.flowBlocked} tone="blue" compact />
        <StatCard label="Completed" value={props.completed} tone="green" compact />
        <StatCard
          label="Failed"
          value={props.failed}
          tone={props.failedCount != null && props.failedCount > 0 ? 'red' : 'default'}
          compact
        />
        <StatCard label="Error Rate" value={props.errorRate} tone={props.errorRateTone} compact />
      </div>
    </div>
  );
}
