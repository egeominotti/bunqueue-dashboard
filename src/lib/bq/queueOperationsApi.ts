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
  group: (
    queue: string,
    groupId: string,
    maxJobs?: number,
    maxCount?: number,
    start?: number,
    end?: number
  ): Promise<unknown> => {
    const query = new URLSearchParams({ target: getBaseUrl(), groupId });
    if (maxJobs !== undefined) query.set('maxJobs', String(maxJobs));
    if (maxCount !== undefined) query.set('maxCount', String(maxCount));
    if (start !== undefined) query.set('start', String(start));
    if (end !== undefined) query.set('end', String(end));
    return agentRequest(`/queue-operations/${queueHttpPathSegment(queue)}/groups?${query}`);
  },
  setGroupRateLimit: (
    queue: string,
    groupId: string,
    max: number,
    duration: number
  ): Promise<unknown> =>
    agentRequest(
      `/queue-operations/${queueHttpPathSegment(queue)}/groups/rate-limit?target=${targetQuery()}`,
      body('POST', { groupId, max, duration })
    ),
  removeGroupRateLimit: (queue: string, groupId: string): Promise<unknown> =>
    agentRequest(
      `/queue-operations/${queueHttpPathSegment(queue)}/groups/rate-limit/remove?target=${targetQuery()}`,
      body('POST', { groupId })
    ),
  setGroupConcurrency: (queue: string, groupId: string, concurrency: number): Promise<unknown> =>
    agentRequest(
      `/queue-operations/${queueHttpPathSegment(queue)}/groups/concurrency?target=${targetQuery()}`,
      body('POST', { groupId, concurrency })
    ),
  removeGroupConcurrency: (queue: string, groupId: string): Promise<unknown> =>
    agentRequest(
      `/queue-operations/${queueHttpPathSegment(queue)}/groups/concurrency/remove?target=${targetQuery()}`,
      body('POST', { groupId })
    ),
  pauseGroup: (queue: string, groupId: string): Promise<unknown> =>
    agentRequest(
      `/queue-operations/${queueHttpPathSegment(queue)}/groups/pause?target=${targetQuery()}`,
      body('POST', { groupId })
    ),
  resumeGroup: (queue: string, groupId: string): Promise<unknown> =>
    agentRequest(
      `/queue-operations/${queueHttpPathSegment(queue)}/groups/resume?target=${targetQuery()}`,
      body('POST', { groupId })
    ),
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
