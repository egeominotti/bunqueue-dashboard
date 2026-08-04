import type { ServerRequestTarget, ServerTargetClient } from '@/lib/bq';
import { createBenchmarkQueueName, type RunConfig } from './engine';

export const BENCHMARK_MODES = ['count', 'duration'] as const;
export const CLEAN_STATES: readonly string[] = ['waiting', 'completed', 'failed'];

let tabBenchmarkQueue: string | null = null;
export function sessionBenchmarkQueue(): string {
  tabBenchmarkQueue ??= createBenchmarkQueueName();
  return tabBenchmarkQueue;
}

export type BenchmarkNumKey =
  | 'total'
  | 'durationS'
  | 'batch'
  | 'producers'
  | 'payload'
  | 'workers'
  | 'workerBatch'
  | 'processMs';
export type BenchmarkDraft = Omit<RunConfig, BenchmarkNumKey> & Record<BenchmarkNumKey, string>;

export interface PinnedBenchmarkTarget {
  target: ServerRequestTarget;
  client: ServerTargetClient;
}

export const BENCHMARK_NUM_KEYS: readonly BenchmarkNumKey[] = [
  'total',
  'durationS',
  'batch',
  'producers',
  'payload',
  'workers',
  'workerBatch',
  'processMs',
];

export const toBenchmarkDraft = (config: RunConfig): BenchmarkDraft => ({
  ...config,
  total: String(config.total),
  durationS: String(config.durationS),
  batch: String(config.batch),
  producers: String(config.producers),
  payload: String(config.payload),
  workers: String(config.workers),
  workerBatch: String(config.workerBatch),
  processMs: String(config.processMs),
});

export const toBenchmarkConfig = (draft: BenchmarkDraft): RunConfig => ({
  ...draft,
  total: Number(draft.total),
  durationS: Number(draft.durationS),
  batch: Number(draft.batch),
  producers: Number(draft.producers),
  payload: Number(draft.payload),
  workers: Number(draft.workers),
  workerBatch: Number(draft.workerBatch),
  processMs: Number(draft.processMs),
});
