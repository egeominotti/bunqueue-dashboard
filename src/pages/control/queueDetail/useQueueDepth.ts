import { useEffect, useRef, useState } from 'react';
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
  const [depth, setDepth] = useState<number[]>([]);
  const currentDepthRef = useRef<number | null>(null);

  useEffect(() => {
    if (!counts) return;
    currentDepthRef.current =
      (counts.waiting ?? 0) +
      (counts.prioritized ?? 0) +
      (counts.active ?? 0) +
      (counts.delayed ?? 0) +
      (counts['waiting-children'] ?? 0);
  }, [counts]);

  // Reset and re-arm only when the queue changes.
  useEffect(() => {
    currentDepthRef.current = null;
    setDepth([]);
    const interval = setInterval(() => {
      const value = currentDepthRef.current;
      if (value != null) setDepth((series) => [...series, value].slice(-MAX_DEPTH_POINTS));
    }, DEPTH_SAMPLE_MS);
    return () => clearInterval(interval);
  }, [name]);

  return { depth, trend: depthTrend(depth) };
}
