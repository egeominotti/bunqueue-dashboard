import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  currentControlConnectionEpoch,
  useControlConnectionEpoch,
} from '@/lib/controlConnectionEpoch';
import { type HistoryView, type HistoryWindow, metricWindow } from './model';
import { createMetricHistoryRepository } from './repository';

export function useMetricHistory(queue: string, window: HistoryWindow) {
  const epoch = useControlConnectionEpoch();
  const [revision, setRevision] = useState(0);
  const identity = useMemo(
    () => ({ queue, window, epoch, revision }),
    [queue, window, epoch, revision]
  );
  const [state, setState] = useState<{
    identity: typeof identity;
    view?: HistoryView;
    error?: string;
  }>();
  useEffect(() => {
    if (!queue) return;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && currentControlConnectionEpoch() === epoch;
    const load = async () => {
      try {
        const repository = createMetricHistoryRepository(queue);
        const read = await repository.read(window, controller.signal);
        if (current()) setState({ identity, view: metricWindow(read, window, Date.now()) });
      } catch (error) {
        if (current())
          setState({ identity, error: error instanceof Error ? error.message : String(error) });
      }
    };
    void load();
    return () => controller.abort();
  }, [epoch, identity, queue, window]);
  return {
    view: state?.identity === identity ? state.view : undefined,
    error: state?.identity === identity ? (state.error ?? '') : '',
    loading: Boolean(queue) && state?.identity !== identity,
    reload: useCallback(() => setRevision((value) => value + 1), []),
  };
}
