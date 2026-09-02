import { useEffect, useRef, useState } from 'react';
import type { ServerTargetClient } from '@/lib/bq';
import type { Phase, RunConfig, RunRecord, Summary } from './engine';
import { runBenchmark } from './runBenchmark';
import { EMPTY_LIVE, freshBenchmarkStats, type Live, sampleLive } from './runtimeState';

export {
  assertBenchmarkSuccess,
  BENCHMARK_QUEUE_STATES,
  benchmarkQueueJobs,
  runnableQueueJobs,
} from './queueValidation';
export type { Live } from './runtimeState';

export function useBenchmark() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [live, setLive] = useState<Live>(EMPTY_LIVE);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [history, setHistory] = useState<RunRecord[]>([]);
  const [runCfg, setRunCfg] = useState<RunConfig | null>(null);

  const stopRef = useRef(false);
  const mountedRef = useRef(true);
  const runGenerationRef = useRef(0);
  const runningRef = useRef(false);
  const producersDoneRef = useRef(false);
  const configRef = useRef<RunConfig | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const statsRef = useRef(freshBenchmarkStats());
  phaseRef.current = phase;

  useEffect(() => {
    const mounted = mountedRef;
    const stop = stopRef;
    const runGeneration = runGenerationRef;
    mountedRef.current = true;
    return () => {
      mounted.current = false;
      stop.current = true;
      runGeneration.current++;
    };
  }, []);

  useEffect(() => {
    if (phase !== 'running' && phase !== 'draining') return;
    const interval = setInterval(() => {
      setLive(sampleLive(statsRef.current, configRef.current, phaseRef.current, performance.now()));
    }, 200);
    return () => clearInterval(interval);
  }, [phase]);

  const run = (config: RunConfig, pinnedClient?: ServerTargetClient) =>
    runBenchmark(
      {
        configRef,
        mountedRef,
        phaseRef,
        producersDoneRef,
        runningRef,
        runGenerationRef,
        setHistory,
        setLive,
        setPhase,
        setRunConfig: setRunCfg,
        setSummary,
        statsRef,
        stopRef,
      },
      config,
      pinnedClient
    );

  const stop = () => {
    stopRef.current = true;
    if (phaseRef.current === 'running' || phaseRef.current === 'draining') {
      phaseRef.current = 'stopping';
      setPhase('stopping');
    }
  };

  const reset = () => {
    stopRef.current = true;
    runGenerationRef.current++;
    phaseRef.current = 'idle';
    setSummary(null);
    setLive(EMPTY_LIVE);
    setPhase('idle');
  };

  return {
    phase,
    live,
    summary,
    history,
    runCfg,
    run,
    stop,
    reset,
    clearHistory: () => setHistory([]),
  };
}
