import { Queue, type QueueMetricType, type QueueMetrics } from 'bunqueue/client';
import { managedAuthToken } from '../managedTarget';
import type { ServerConfig } from '../manager';
import type { QueueLimitSnapshot, QueueOperationsPort } from './types';
import { QueueOperationsUnavailableError } from './types';

export type QueueOperationsClient = Pick<
  Queue,
  | 'waitUntilReady'
  | 'getGlobalRateLimit'
  | 'getGlobalConcurrency'
  | 'getRateLimitTtl'
  | 'isMaxed'
  | 'getDeduplicationJobId'
  | 'removeDeduplicationKey'
  | 'getMetrics'
  | 'trimEvents'
  | 'close'
>;
export type QueueOperationsClientFactory = (
  config: ServerConfig,
  queue: string
) => QueueOperationsClient;

/** Serializes operator reads and mutations and owns each dedicated TCP session. */
export class QueueOperationsRuntime implements QueueOperationsPort {
  private gate: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly createClient: QueueOperationsClientFactory = defaultClient) {}

  limits(config: ServerConfig, queue: string, maxJobs?: number): Promise<QueueLimitSnapshot> {
    return this.withQueue(config, queue, async (client) => {
      const [rateLimit, concurrency, rateLimitTtl, maxed] = await Promise.all([
        client.getGlobalRateLimit(),
        client.getGlobalConcurrency(),
        client.getRateLimitTtl(maxJobs),
        client.isMaxed(),
      ]);
      return { rateLimit, concurrency, rateLimitTtl, maxed };
    });
  }

  deduplicationJobId(
    config: ServerConfig,
    queue: string,
    deduplicationId: string
  ): Promise<string | null> {
    return this.withQueue(config, queue, (client) =>
      client.getDeduplicationJobId(deduplicationId)
    );
  }

  removeDeduplicationKey(
    config: ServerConfig,
    queue: string,
    deduplicationId: string
  ): Promise<number> {
    return this.withQueue(config, queue, (client) => client.removeDeduplicationKey(deduplicationId));
  }

  metrics(
    config: ServerConfig,
    queue: string,
    type: QueueMetricType,
    start: number,
    end: number
  ): Promise<QueueMetrics> {
    return this.withQueue(config, queue, (client) => client.getMetrics(type, start, end));
  }

  trimEvents(config: ServerConfig, queue: string, maxLength: number): Promise<number> {
    return this.withQueue(config, queue, (client) => client.trimEvents(maxLength));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.gate;
  }

  private withQueue<T>(
    config: ServerConfig,
    queue: string,
    operation: (client: QueueOperationsClient) => Promise<T>
  ): Promise<T> {
    return this.serial(async () => {
      const client = this.createClient(config, queue);
      try {
        await client.waitUntilReady();
        return await operation(client);
      } finally {
        client.close();
      }
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new QueueOperationsUnavailableError('Queue operations runtime is closed'));
    }
    const result = this.gate.then(operation, operation);
    this.gate = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function connectionFor(config: ServerConfig) {
  return { host: '127.0.0.1', port: config.tcpPort, token: managedAuthToken(config) };
}

function defaultClient(config: ServerConfig, queue: string): QueueOperationsClient {
  return new Queue(queue, {
    autoBatch: { enabled: false },
    connection: { ...connectionFor(config), poolSize: 1 },
  });
}
