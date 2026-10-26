import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { parseMetrics } from '@/features/queue-operations/infrastructure/bqQueueOperationsRepository';
import {
  agentHeadersFor,
  call,
  captureAgentRequestTarget,
  captureServerRequestTarget,
} from '@/lib/bq/transport';
import { currentControlConnectionEpoch } from '@/lib/controlConnectionEpoch';
import { queueHttpPathSegment } from '@/lib/upstreamPaths';
import { type HistoryRead, type HistoryWindow, METRIC_TYPES, windowMinutes } from './model';

export interface MetricHistoryRepository {
  read(window: HistoryWindow, signal: AbortSignal): Promise<HistoryRead>;
}

/** Capture once; neither a later response nor a second type can retarget the read. */
export function createMetricHistoryRepository(queue: string): MetricHistoryRepository {
  const path = `/queue-operations/${queueHttpPathSegment(queue)}/metrics`;
  if (!useConnectionStore.getState().agentBaseUrl.trim()) {
    throw new Error('Metric history is unavailable: configure a paired agent for this server.');
  }
  const epoch = currentControlConnectionEpoch();
  const server = captureServerRequestTarget();
  const agent = captureAgentRequestTarget();
  return {
    async read(window, signal) {
      signal.throwIfAborted();
      const controller = new AbortController();
      const checkTarget = () => {
        if (currentControlConnectionEpoch() !== epoch) {
          controller.abort(new Error('Connection changed; load metric history again.'));
        }
      };
      const unsubscribe = useConnectionStore.subscribe(checkTarget);
      const combined = AbortSignal.any([signal, controller.signal]);
      try {
        checkTarget();
        combined.throwIfAborted();
        const end = windowMinutes(window) - 1;
        const responses = await Promise.allSettled(
          METRIC_TYPES.map(async (type) => {
            const query = new URLSearchParams({
              target: server.baseUrl,
              type,
              start: '0',
              end: String(end),
            });
            const result = await call<unknown>(
              agent.baseUrl,
              `${path}?${query}`,
              {
                ...agentHeadersFor(agent),
              },
              { signal: combined },
              true,
              'agent'
            );
            combined.throwIfAborted();
            return parseMetrics(result);
          })
        );
        combined.throwIfAborted();
        const result: HistoryRead = { errors: {} };
        responses.forEach((response, index) => {
          const type = METRIC_TYPES[index];
          if (response.status === 'fulfilled') result[type] = response.value;
          else
            result.errors[type] =
              response.reason instanceof Error ? response.reason.message : String(response.reason);
        });
        return result;
      } finally {
        unsubscribe();
      }
    },
  };
}
