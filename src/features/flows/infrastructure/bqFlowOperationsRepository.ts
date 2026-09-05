import { getBaseUrl } from '@/components/dashboard/stores/connectionStore';
import { agentRequest } from '@/lib/bq';
import { assertFlowOperationAllowed } from '@/lib/flowOperationPolicy';
import type { FlowOperationsRepository } from '../application/FlowOperationsRepository';

const jsonBody = (value: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(value),
});

const BODYLESS_MUTATIONS = new Set([
  'removeChildDependency',
  'removeUnprocessedChildren',
  'removeDeduplicationKey',
  'retry',
  'promote',
  'remove',
]);

export const flowWaitRequestTimeout = (ttl: number) => ttl + 5_000;

export const bqFlowOperationsRepository: FlowOperationsRepository = {
  create: (operation, payload) =>
    agentRequest(
      `/flows/create?target=${encodeURIComponent(getBaseUrl())}`,
      jsonBody({ operation, ...payload })
    ),
  getFlow: (target) => {
    const query = new URLSearchParams({
      id: target.id,
      queueName: target.queueName,
      target: getBaseUrl(),
    });
    if (target.depth !== undefined) query.set('depth', String(target.depth));
    if (target.maxChildren !== undefined) query.set('maxChildren', String(target.maxChildren));
    return agentRequest(`/flows/tree?${query}`);
  },
  inspect: (target, operation) =>
    agentRequest(
      `/flows/jobs/${encodeURIComponent(target.id)}/${operation}?${new URLSearchParams({ queueName: target.queueName, target: getBaseUrl() })}`
    ),
  getParentResult: (parentId) =>
    agentRequest(
      `/flows/results?target=${encodeURIComponent(getBaseUrl())}`,
      jsonBody({ operation: 'getParentResult', parentId })
    ),
  getParentResults: (parentIds) =>
    agentRequest(
      `/flows/results?target=${encodeURIComponent(getBaseUrl())}`,
      jsonBody({ operation: 'getParentResults', parentIds })
    ),
  waitUntilFinished: (target, ttl) =>
    agentRequest(
      `/flows/jobs/${encodeURIComponent(target.id)}/waitUntilFinished?${new URLSearchParams({ queueName: target.queueName, target: getBaseUrl(), ttl: String(ttl) })}`,
      undefined,
      flowWaitRequestTimeout(ttl)
    ),
  mutate: (target, operation, payload) => {
    assertFlowOperationAllowed(operation);
    return agentRequest(
      `/flows/jobs/${encodeURIComponent(target.id)}/${operation}?${new URLSearchParams({ queueName: target.queueName, target: getBaseUrl() })}`,
      BODYLESS_MUTATIONS.has(operation) ? { method: 'POST' } : jsonBody(payload ?? {})
    );
  },
};
