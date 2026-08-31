import type { QueueMetricType } from 'bunqueue/client';
import type { ServerConfig } from '../manager';
import { assertManagedTarget, type ManagedTargetPolicy } from '../managedTarget';
import type {
  ManagedRuntimeAdmission,
  ManagedRuntimeSnapshot,
} from '../server/managedRuntime';
import type { RouteResponse } from '../server/types';
import type { QueueOperationsPort } from './types';
import { QueueOperationsUnavailableError } from './types';
import {
  eventRetention,
  exactJsonBody,
  exactQuery,
  metricsRange,
  optionalMaxJobs,
  requiredDeduplicationId,
  validateQueueName,
} from './validation';

const READ_ROUTE = /^\/queue-operations\/([^/]+)\/(limits|deduplication|metrics)$/;
const MUTATION_ROUTE = /^\/queue-operations\/([^/]+)\/(deduplication\/remove|events\/trim)$/;

export async function routeQueueOperationsRequest(
  request: Request,
  pathname: string,
  method: string,
  config: ServerConfig,
  runtime: QueueOperationsPort,
  running: boolean,
  admission?: ManagedRuntimeAdmission,
  targetPolicy?: ManagedTargetPolicy
): Promise<RouteResponse | null> {
  const read = pathname.match(READ_ROUTE);
  if (read && method === 'GET') {
    const queue = decodedQueue(read[1]);
    if (read[2] === 'limits') {
      const query = pinnedQuery(request, config, ['target', 'maxJobs'], targetPolicy);
      assertRunning(running);
      const maxJobs = optionalMaxJobs(query);
      return admitted(query, config, running, admission, targetPolicy, async ({ config: current }) =>
        ok({ limits: await runtime.limits(current, queue, maxJobs) })
      );
    }
    if (read[2] === 'deduplication') {
      const query = pinnedQuery(request, config, ['target', 'deduplicationId'], targetPolicy);
      const id = requiredDeduplicationId(query.get('deduplicationId'));
      assertRunning(running);
      return admitted(query, config, running, admission, targetPolicy, async ({ config: current }) =>
        ok({ jobId: await runtime.deduplicationJobId(current, queue, id) })
      );
    }
    const query = pinnedQuery(request, config, ['target', 'type', 'start', 'end'], targetPolicy);
    const type = metricType(query.get('type'));
    const range = metricsRange(query);
    assertRunning(running);
    return admitted(query, config, running, admission, targetPolicy, async ({ config: current }) =>
      ok({ metrics: await runtime.metrics(current, queue, type, range.start, range.end) })
    );
  }

  const mutation = pathname.match(MUTATION_ROUTE);
  if (mutation && method === 'POST') {
    const queue = decodedQueue(mutation[1]);
    const query = pinnedQuery(request, config, ['target'], targetPolicy);
    assertRunning(running);
    if (mutation[2] === 'deduplication/remove') {
      const body = await exactJsonBody(request, ['deduplicationId']);
      const id = requiredDeduplicationId(
        typeof body.deduplicationId === 'string' ? body.deduplicationId : null
      );
      return admitted(query, config, running, admission, targetPolicy, async ({ config: current }) =>
        ok({ removed: await runtime.removeDeduplicationKey(current, queue, id) })
      );
    }
    const body = await exactJsonBody(request, ['maxLength']);
    const retention = eventRetention(body.maxLength);
    return admitted(query, config, running, admission, targetPolicy, async ({ config: current }) =>
      ok({ removed: await runtime.trimEvents(current, queue, retention) })
    );
  }
  if (pathname.startsWith('/queue-operations/')) {
    return { status: 404, body: { ok: false, error: 'Unknown Queue operation' } };
  }
  return null;
}

function admitted<T>(
  query: URLSearchParams,
  config: ServerConfig,
  running: boolean,
  admission: ManagedRuntimeAdmission | undefined,
  targetPolicy: ManagedTargetPolicy | undefined,
  operation: (snapshot: ManagedRuntimeSnapshot) => Promise<T>
): Promise<T> {
  const execute = async (snapshot: ManagedRuntimeSnapshot) => {
    assertManagedTarget(query, snapshot.config, targetPolicy);
    assertRunning(snapshot.running);
    return operation(snapshot);
  };
  return admission ? admission(execute) : execute({ config, running });
}

function pinnedQuery(
  request: Request,
  config: ServerConfig,
  allowed: string[],
  targetPolicy?: ManagedTargetPolicy
) {
  const query = exactQuery(request.url, allowed);
  assertManagedTarget(query, config, targetPolicy);
  return query;
}

function decodedQueue(value: string): string {
  return validateQueueName(decodeURIComponent(value));
}

function metricType(value: string | null): QueueMetricType {
  if (value !== 'completed' && value !== 'failed') {
    throw new Error('Metrics type must be completed or failed');
  }
  return value;
}

function assertRunning(running: boolean): void {
  if (!running) {
    throw new QueueOperationsUnavailableError('Start the managed Bunqueue server before using Queue operations');
  }
}

function ok(body: Record<string, unknown>): RouteResponse {
  return { status: 200, body: { ok: true, ...body } };
}
