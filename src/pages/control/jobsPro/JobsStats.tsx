import { StatCard } from '@/components/ui/StatCard';

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
  return (
    <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-8">
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
  );
}
