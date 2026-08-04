export interface QueueHealth {
  name: string;
  paused: boolean;
  counts: {
    waiting: number;
    prioritized: number;
    active: number;
    completed: number;
    failed: number;
  } | null;
}

export const EMPTY_OVERVIEW = {
  overview: {
    stats: {
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      dlq: 0,
      totalPushed: 0,
      totalPulled: 0,
      totalCompleted: 0,
      totalFailed: 0,
      uptime: 0,
    },
    throughput: { pushPerSec: 0, pullPerSec: 0, completePerSec: 0, failPerSec: 0 },
    memory: { heapUsed: 0, heapTotal: 0, rss: 0 },
    crons: { total: 0 },
  },
  queuesTotal: 0,
  details: [] as QueueHealth[],
  failedTotal: 0,
  readyTotal: 0,
};

export const WAITING_AMBER_THRESHOLD = 100;
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasFiniteNumbers(value: unknown, keys: readonly string[]): value is JsonObject {
  return (
    isJsonObject(value) &&
    keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
  );
}

export function assertRenderableOverview(value: unknown): void {
  if (
    !isJsonObject(value) ||
    !hasFiniteNumbers(value.stats, [
      'waiting',
      'active',
      'completed',
      'dlq',
      'totalPushed',
      'totalPulled',
      'uptime',
    ]) ||
    !hasFiniteNumbers(value.throughput, ['pushPerSec', 'pullPerSec']) ||
    !hasFiniteNumbers(value.memory, ['rss']) ||
    !hasFiniteNumbers(value.crons, ['total'])
  ) {
    throw new Error(
      'Malformed /dashboard response: required overview metrics are missing or non-numeric.'
    );
  }
}
