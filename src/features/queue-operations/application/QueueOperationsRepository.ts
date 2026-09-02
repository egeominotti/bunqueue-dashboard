export interface QueueLimitSnapshot {
  rateLimit: { max: number; duration: number } | null;
  concurrency: number | null;
  rateLimitTtl: number;
  maxed: boolean;
}

export interface QueueMetricsSnapshot {
  meta: { count: number; prevTS: number; prevCount: number };
  data: number[];
  count: number;
}

export interface QueueGroupSnapshot {
  jobs: number;
  active: number;
  totalGrouped: number;
  paused: boolean;
  entries: QueueGroupJobSummary[];
  priorityCounts: Record<string, number>;
  rateLimit: { max: number; duration: number } | null;
  rateLimitTtl: number;
  concurrency: number | null;
}

export interface QueueGroupJobSummary {
  id: string;
  name: string;
  priority: number;
  delay: number;
  timestamp: number;
}

export interface QueueOperationsRepository {
  limits(queue: string, maxJobs?: number): Promise<QueueLimitSnapshot>;
  group(
    queue: string,
    groupId: string,
    maxJobs?: number,
    maxCount?: number,
    start?: number,
    end?: number
  ): Promise<QueueGroupSnapshot>;
  pauseGroup(queue: string, groupId: string): Promise<boolean>;
  resumeGroup(queue: string, groupId: string): Promise<boolean>;
  setGroupRateLimit(queue: string, groupId: string, max: number, duration: number): Promise<void>;
  removeGroupRateLimit(queue: string, groupId: string): Promise<number>;
  setGroupConcurrency(queue: string, groupId: string, concurrency: number): Promise<void>;
  removeGroupConcurrency(queue: string, groupId: string): Promise<number>;
  deduplicationJobId(queue: string, deduplicationId: string): Promise<string | null>;
  removeDeduplicationKey(queue: string, deduplicationId: string): Promise<number>;
  metrics(
    queue: string,
    type: 'completed' | 'failed',
    start: number,
    end: number
  ): Promise<QueueMetricsSnapshot>;
  trimEvents(queue: string, maxLength: number): Promise<number>;
}
