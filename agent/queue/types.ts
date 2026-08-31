import type { QueueMetricType, QueueMetrics } from 'bunqueue/client';
import type { ServerConfig } from '../manager';

export interface QueueLimitSnapshot {
  rateLimit: { max: number; duration: number } | null;
  concurrency: number | null;
  rateLimitTtl: number;
  maxed: boolean;
}

export interface QueueOperationsPort {
  limits(config: ServerConfig, queue: string, maxJobs?: number): Promise<QueueLimitSnapshot>;
  deduplicationJobId(
    config: ServerConfig,
    queue: string,
    deduplicationId: string
  ): Promise<string | null>;
  removeDeduplicationKey(
    config: ServerConfig,
    queue: string,
    deduplicationId: string
  ): Promise<number>;
  removeDlqJob(config: ServerConfig, queue: string, jobId: string): Promise<boolean>;
  metrics(
    config: ServerConfig,
    queue: string,
    type: QueueMetricType,
    start: number,
    end: number
  ): Promise<QueueMetrics>;
  trimEvents(config: ServerConfig, queue: string, maxLength: number): Promise<number>;
  close(): Promise<void>;
}

export class QueueOperationsUnavailableError extends Error {}
