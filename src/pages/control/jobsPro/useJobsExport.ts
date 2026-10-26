import { useEffect, useRef, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { bq } from '@/lib/bq';
import { useServerActionGuard } from '@/lib/useServerActionGuard';
import { collectJobsForExport, downloadJobsCsv } from './exportJobs';
import type { JobStatusFilter } from './model';

export function useJobsExport(queue: string, status: JobStatusFilter, search: string) {
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const guard = useServerActionGuard(JSON.stringify(['jobs-export', queue, status, search]));

  useEffect(() => {
    setBusy(false);
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [guard.scopeKey]);

  const exportAll = async () => {
    if (!queue) return;
    const lease = guard.begin('export');
    if (!lease) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      const client = bq.createServerTargetClient(
        bq.captureServerRequestTarget(),
        controller.signal
      );
      const jobs = await collectJobsForExport(client, queue, status, search, controller.signal);
      if (!lease.isCurrent()) return;
      if (jobs.length === 0) {
        toast.info('No jobs match this export');
        return;
      }
      downloadJobsCsv(queue, status, jobs);
      toast.success(`Exported ${jobs.length.toLocaleString()} jobs`);
    } catch (error) {
      if (lease.isCurrent() && !controller.signal.aborted) {
        toast.error('Export failed', error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (active.current === controller) active.current = null;
      if (lease.finish()) setBusy(false);
    }
  };

  return { busy, exportAll };
}
