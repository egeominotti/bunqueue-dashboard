import { getBaseUrl } from '@/components/dashboard/stores/connectionStore';
import { queueHttpPathSegment } from '../upstreamPaths';
import { agentRequest, body } from './transport';

const targetQuery = () => encodeURIComponent(getBaseUrl());

/** Raw control-agent transport; the feature adapter validates every response. */
export const queueOperationsApi = {
  limits: (queue: string, maxJobs?: number): Promise<unknown> => {
    const suffix = maxJobs === undefined ? '' : `&maxJobs=${maxJobs}`;
    return agentRequest(
      `/queue-operations/${queueHttpPathSegment(queue)}/limits?target=${targetQuery()}${suffix}`
    );
  },
  deduplicationJobId: (queue: string, deduplicationId: string): Promise<unknown> =>
    agentRequest(
      `/queue-operations/${queueHttpPathSegment(queue)}/deduplication?${new URLSearchParams({ target: getBaseUrl(), deduplicationId })}`
    ),
  removeDeduplicationKey: (queue: string, deduplicationId: string): Promise<unknown> =>
    agentRequest(
      `/queue-operations/${queueHttpPathSegment(queue)}/deduplication/remove?target=${targetQuery()}`,
      body('POST', { deduplicationId })
    ),
  metrics: (
    queue: string,
    type: 'completed' | 'failed',
    start: number,
    end: number
  ): Promise<unknown> =>
    agentRequest(
      `/queue-operations/${queueHttpPathSegment(queue)}/metrics?${new URLSearchParams({ target: getBaseUrl(), type, start: String(start), end: String(end) })}`
    ),
  trimEvents: (queue: string, maxLength: number): Promise<unknown> =>
    agentRequest(
      `/queue-operations/${queueHttpPathSegment(queue)}/events/trim?target=${targetQuery()}`,
      body('POST', { maxLength })
    ),
};
