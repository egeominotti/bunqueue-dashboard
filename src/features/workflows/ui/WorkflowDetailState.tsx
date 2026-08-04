import { useEffect, useState } from 'react';
import { OfflineBanner } from '@/components/ui/feedback';
import { formatDuration } from '@/lib/format';

export interface WorkflowClock {
  now(): number;
  subscribe(update: () => void): () => void;
}

export const systemWorkflowClock: WorkflowClock = {
  now: Date.now,
  subscribe: (update) => {
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  },
};

export function LiveWorkflowDuration({
  since,
  clock = systemWorkflowClock,
}: {
  since: number;
  clock?: WorkflowClock;
}) {
  const now = useWorkflowNow(clock);
  return <>{formatDuration(Math.max(0, now - since))}</>;
}

/** One ticking value per surface; callers can reuse it for every visible row. */
export function useWorkflowNow(clock: WorkflowClock = systemWorkflowClock, enabled = true): number {
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    setNow(clock.now());
    if (!enabled) return;
    return clock.subscribe(() => setNow(clock.now()));
  }, [clock, enabled]);
  return now;
}

export function WorkflowDetailStaleBanner({
  error,
  onRetry,
}: {
  error: Error | null;
  onRetry: () => void | Promise<void>;
}) {
  if (!error) return null;
  return (
    <OfflineBanner
      message="Execution refresh failed; showing the last persisted snapshot."
      onRetry={onRetry}
    />
  );
}

export async function refreshWorkflowViews(
  refreshDetail: () => Promise<void>,
  refreshList?: () => void | Promise<void>
): Promise<void> {
  await Promise.all([refreshDetail(), refreshList?.()]);
}
