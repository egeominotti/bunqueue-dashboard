import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import type { QueueSummaryFull } from '@/lib/bqTypes';
import {
  currentControlConnectionEpoch,
  useControlConnectionEpoch,
} from '@/lib/controlConnectionEpoch';
import { JOB_STATUSES, type JobStatusFilter } from './model';

const EMPTY_SELECTION = new Set<string>();

/**
 * The URL owns queue and status, including history navigation on the same
 * mounted route. Page and selection are scoped to that view so old rows or
 * selected IDs cannot briefly become actionable under a different target.
 */
export function useJobsView(summary: QueueSummaryFull[] | null) {
  const [params, setParams] = useSearchParams();
  const requestedQueue = params.get('queue') ?? '';
  const requestedStatus = params.get('status') as JobStatusFilter | null;
  const status =
    requestedStatus && JOB_STATUSES.includes(requestedStatus) ? requestedStatus : 'all';
  const queue =
    summary && !summary.some((item) => item.name === requestedQueue)
      ? (summary[0]?.name ?? '')
      : requestedQueue;
  const connectionEpoch = useControlConnectionEpoch();
  const listIdentity = JSON.stringify([connectionEpoch, queue, status]);
  const listVersion = useRef({ identity: listIdentity, generation: 0 });
  if (listVersion.current.identity !== listIdentity) {
    listVersion.current = {
      identity: listIdentity,
      generation: listVersion.current.generation + 1,
    };
  }
  const listGeneration = listVersion.current.generation;
  const [pagination, setPagination] = useState({ generation: -1, page: 0 });
  const page = pagination.generation === listGeneration ? pagination.page : 0;
  const pageVersion = useRef({ listGeneration, page, generation: 0 });
  if (pageVersion.current.listGeneration !== listGeneration || pageVersion.current.page !== page) {
    pageVersion.current = { listGeneration, page, generation: pageVersion.current.generation + 1 };
  }
  const generation = pageVersion.current.generation;
  const view = JSON.stringify([connectionEpoch, listGeneration, generation, queue, status, page]);
  const [selection, setSelection] = useState<{ generation: number; ids: Set<string> }>({
    generation: -1,
    ids: new Set(),
  });
  const selected = selection.generation === generation ? selection.ids : EMPTY_SELECTION;

  const setPage = useCallback(
    (next: number) =>
      setPagination((previous) =>
        listVersion.current.generation === listGeneration &&
        currentControlConnectionEpoch() === connectionEpoch
          ? { generation: listGeneration, page: next }
          : previous
      ),
    [connectionEpoch, listGeneration]
  );
  const setSelected: Dispatch<SetStateAction<Set<string>>> = useCallback(
    (next) =>
      setSelection((previous) => {
        if (
          pageVersion.current.generation !== generation ||
          currentControlConnectionEpoch() !== connectionEpoch
        )
          return previous;
        const current = previous.generation === generation ? previous.ids : EMPTY_SELECTION;
        return { generation, ids: typeof next === 'function' ? next(current) : next };
      }),
    [connectionEpoch, generation]
  );

  // Canonicalize a missing or stale URL queue after discovery, while preserving
  // other query parameters. If discovery fails, an explicit URL target remains
  // usable instead of being replaced with a guessed queue.
  useEffect(() => {
    if (!summary || requestedQueue === queue) return;
    const next = new URLSearchParams(params);
    if (queue) next.set('queue', queue);
    else next.delete('queue');
    setParams(next, { replace: true });
  }, [params, queue, requestedQueue, setParams, summary]);

  const selectQueue = (next: string) => {
    const updated = new URLSearchParams(params);
    if (next) updated.set('queue', next);
    else updated.delete('queue');
    setParams(updated, { replace: true });
  };
  const selectStatus = (next: JobStatusFilter) => {
    const updated = new URLSearchParams(params);
    if (next === 'all') updated.delete('status');
    else updated.set('status', next);
    setParams(updated, { replace: true });
  };
  return { queue, status, page, view, selected, setSelected, setPage, selectQueue, selectStatus };
}
