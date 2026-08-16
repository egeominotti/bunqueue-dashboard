import { useRef, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { bq } from '@/lib/bq';
import { useControlActionGuard } from '@/lib/useControlActionGuard';
import type { HeapStats } from './DiagnosticsPanels';

export function useDiagnosticActions(refetch: () => Promise<void>) {
  const actionGuard = useControlActionGuard('diagnostics');
  const [pingState, setPingState] = useState<{ scope: string; value: string | null } | null>(null);
  const ping = pingState?.scope === actionGuard.scopeKey ? pingState.value : null;
  const pingGeneration = useRef(0);
  const doPing = async () => {
    const sequence = ++pingGeneration.current;
    const lease = actionGuard.begin(`ping:${sequence}`);
    if (!lease) return;
    setPingState({ scope: actionGuard.scopeKey, value: '…' });
    const t0 = performance.now();
    try {
      await bq.ping();
      if (lease.isCurrent() && pingGeneration.current === sequence) {
        setPingState({
          scope: actionGuard.scopeKey,
          value: `${Math.round(performance.now() - t0)} ms`,
        });
      }
    } catch {
      if (lease.isCurrent() && pingGeneration.current === sequence) {
        setPingState({ scope: actionGuard.scopeKey, value: 'unreachable' });
      }
    } finally {
      lease.finish();
    }
  };

  const [gcState, setGcState] = useState<{
    busy: boolean;
    message: string | null;
    scope: string;
  } | null>(null);
  const gcBusy = gcState?.scope === actionGuard.scopeKey && gcState.busy;
  const gcMsg = gcState?.scope === actionGuard.scopeKey ? gcState.message : null;
  const doGc = async () => {
    const lease = actionGuard.begin('gc');
    if (!lease) return;
    setGcState({ busy: true, message: null, scope: actionGuard.scopeKey });
    try {
      const result = await bq.gc();
      if (!lease.isCurrent()) return;
      const freed = result.before.rss - result.after.rss;
      const text =
        freed > 0
          ? `Freed ${freed} MB (RSS ${result.before.rss}→${result.after.rss})`
          : 'No memory reclaimed';
      setGcState({ busy: true, message: text, scope: actionGuard.scopeKey });
      toast.success('Memory compacted', text);
      void refetch();
    } catch (error) {
      if (!lease.isCurrent()) return;
      const message = (error as Error).message;
      toast.error('GC failed', message);
      setGcState({ busy: true, message, scope: actionGuard.scopeKey });
    } finally {
      if (lease.finish()) {
        setGcState((current) =>
          current?.scope === actionGuard.scopeKey ? { ...current, busy: false } : current
        );
      }
    }
  };

  const [heapState, setHeapState] = useState<{
    busy: boolean;
    scope: string;
    value: HeapStats | null;
  } | null>(null);
  const heap = heapState?.scope === actionGuard.scopeKey ? heapState.value : null;
  const heapBusy = heapState?.scope === actionGuard.scopeKey && heapState.busy;
  const loadHeap = async () => {
    const lease = actionGuard.begin('heap');
    if (!lease) return;
    setHeapState({ busy: true, scope: actionGuard.scopeKey, value: null });
    try {
      const value = await bq.heapStats();
      if (lease.isCurrent()) setHeapState({ busy: true, scope: actionGuard.scopeKey, value });
    } catch (error) {
      if (lease.isCurrent()) toast.error('Heap stats failed', (error as Error).message);
    } finally {
      if (lease.finish()) {
        setHeapState((current) =>
          current?.scope === actionGuard.scopeKey ? { ...current, busy: false } : current
        );
      }
    }
  };

  return { doGc, doPing, gcBusy, gcMsg, heap, heapBusy, loadHeap, ping };
}
