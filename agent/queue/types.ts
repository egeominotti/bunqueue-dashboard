import type { QueueMetricType, QueueMetrics } from 'bunqueue/client';
import type { ServerConfig } from '../manager';

export interface QueueLimitSnapshot {
  rateLimit: { max: number; duration: number } | null;
  concurrency: number | null;
  rateLimitTtl: number;
  maxed: boolean;
}

export interface QueueGroupSnapshot {
  jobs: number;
  active: number;
  totalGrouped: number;
  rateLimit: { max: number; duration: number } | null;
  rateLimitTtl: number;
  concurrency: number | null;
}

export interface QueueOperationsPort {
  limits(config: ServerConfig, queue: string, maxJobs?: number): Promise<QueueLimitSnapshot>;
  group(
    config: ServerConfig,
    queue: string,
    groupId: string,
    maxJobs?: number,
    maxCount?: number
  ): Promise<QueueGroupSnapshot>;
  setGroupRateLimit(
    config: ServerConfig,
    queue: string,
    groupId: string,
    max: number,
    duration: number
  ): Promise<void>;
  removeGroupRateLimit(config: ServerConfig, queue: string, groupId: string): Promise<number>;
  setGroupConcurrency(
    config: ServerConfig,
    queue: string,
    groupId: string,
    concurrency: number
  ): Promise<void>;
  removeGroupConcurrency(config: ServerConfig, queue: string, groupId: string): Promise<number>;
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
