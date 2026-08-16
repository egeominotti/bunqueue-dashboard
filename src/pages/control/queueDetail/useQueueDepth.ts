import { useEffect, useRef, useState } from 'react';
import { useControlConnectionEpoch } from '@/lib/controlConnectionEpoch';
import { depthTrend } from '@/lib/useThroughputSeries';
import { DEPTH_SAMPLE_MS, MAX_DEPTH_POINTS } from './model';

interface QueueDepthCounts {
  waiting?: number;
  prioritized?: number;
  active?: number;
  delayed?: number;
  'waiting-children'?: number;
}

export function useQueueDepth(name: string, counts?: QueueDepthCounts | null) {
  const connectionEpoch = useControlConnectionEpoch();
  const scope = `${connectionEpoch}\u0000${name}`;
  const [series, setSeries] = useState<{ scope: string; values: number[] }>(() => ({
    scope,
    values: [],
  }));
  const currentDepthRef = useRef<number | null>(null);

  useEffect(() => {
    currentDepthRef.current = null;
    setSeries({ scope, values: [] });
    const interval = setInterval(() => {
      const value = currentDepthRef.current;
      if (value != null) {
        setSeries((current) => ({
          scope,
          values: [...(current.scope === scope ? current.values : []), value].slice(
            -MAX_DEPTH_POINTS
          ),
        }));
      }
    }, DEPTH_SAMPLE_MS);
    return () => clearInterval(interval);
  }, [scope]);

  useEffect(() => {
    if (!counts) return;
    currentDepthRef.current =
      (counts.waiting ?? 0) +
      (counts.prioritized ?? 0) +
      (counts.active ?? 0) +
      (counts.delayed ?? 0) +
      (counts['waiting-children'] ?? 0);
  }, [counts, scope]);

  const depth = series.scope === scope ? series.values : [];
  return { depth, trend: depthTrend(depth) };
}
