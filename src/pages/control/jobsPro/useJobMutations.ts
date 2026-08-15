import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import type { JobFull } from '@/lib/bqTypes';
import { assertSuccessfulMutationResponse, useServerActionGuard } from '@/lib/useServerActionGuard';
import { withoutActed } from './model';

export function useJobMutations({
  queue,
  rows,
  selected,
  setSelected,
  refetch,
}: {
  queue: string;
  rows: JobFull[];
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  refetch: () => unknown;
}) {
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const actionGuard = useServerActionGuard(`jobs:${queue}`);

  // scopeKey is the connection and queue lifecycle boundary.
  useEffect(() => {
    setBusyIds(new Set());
    setBulkBusy(false);
    setActionMsg(null);
  }, [actionGuard.scopeKey]);

  const runOne = async (
    job: JobFull,
    label: string,
    operation: () => Promise<unknown>,
    confirmText?: string
  ) => {
    if (confirmText && !window.confirm(confirmText)) return;
    const lease = actionGuard.begin(`job:${job.id}`);
    if (!lease) return;
    setBusyIds((current) => new Set(current).add(job.id));
    setActionMsg(null);
    try {
      const response = await operation();
      assertSuccessfulMutationResponse(response, label);
      if (!lease.isCurrent()) return;
      setActionMsg({ ok: true, text: `${label} ✓` });
      toast.success(`${label} ✓`, job.id);
      void refetch();
    } catch (error) {
      if (!lease.isCurrent()) return;
      setActionMsg({ ok: false, text: `${label} failed: ${(error as Error).message}` });
      toast.error(`${label} failed`, (error as Error).message);
    } finally {
      if (lease.finish()) {
        setBusyIds((current) => {
          const next = new Set(current);
          next.delete(job.id);
          return next;
        });
      }
    }
  };

  const runBulk = async (
    label: string,
    operation: (job: JobFull) => Promise<unknown>,
    eligible: (job: JobFull) => boolean,
    confirmText?: (count: number) => string
  ) => {
    const targets = rows.filter((job) => selected.has(job.id) && eligible(job));
    if (targets.length === 0) return;
    if (confirmText && !window.confirm(confirmText(targets.length))) return;
    const lease = actionGuard.begin(['bulk', ...targets.map((job) => `job:${job.id}`)]);
    if (!lease) return;
    setBulkBusy(true);
    setActionMsg(null);
    try {
      const results = await Promise.allSettled(
        targets.map(async (job) => {
          const response = await operation(job);
          assertSuccessfulMutationResponse(response, `${label} ${job.id}`);
        })
      );
      if (!lease.isCurrent()) return;
      const okCount = results.filter((result) => result.status === 'fulfilled').length;
      const failCount = results.length - okCount;
      const text = `${label}: ${okCount} succeeded${failCount ? `, ${failCount} failed` : ''}`;
      setActionMsg({ ok: failCount === 0, text });
      if (failCount === 0) toast.success(text);
      else toast.error(text);
      setSelected((current) =>
        withoutActed(
          current,
          targets.map((target) => target.id)
        )
      );
      void refetch();
    } finally {
      if (lease.finish()) setBulkBusy(false);
    }
  };

  return { actionMsg, bulkBusy, busyIds, runBulk, runOne };
}
