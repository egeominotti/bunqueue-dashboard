export const JOB_STATUSES = [
  'all',
  'waiting',
  'prioritized',
  'active',
  'delayed',
  'waiting-children',
  'paused',
  'completed',
  'failed',
] as const;
export type JobStatusFilter = (typeof JOB_STATUSES)[number];
export const JOBS_PAGE_SIZE = 25;

export function selectionLabel(visible: number, total: number): string {
  return visible === total
    ? `${total} selected`
    : `${visible} of ${total} selected match this filter`;
}

export function withoutActed(selected: Set<string>, actedIds: string[]): Set<string> {
  const next = new Set(selected);
  for (const id of actedIds) next.delete(id);
  return next;
}

export function priorityLabel(priority = 0) {
  if (priority >= 10) return { text: 'HIGH', className: 'text-warning' };
  if (priority >= 1) return { text: 'MEDIUM', className: 'text-blue-400' };
  return { text: 'LOW', className: 'text-faint' };
}
