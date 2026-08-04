import { getBaseUrl } from '@/components/dashboard/stores/connectionStore';
import { agentRequest } from '@/lib/bq';
import type {
  WorkflowControlRepository,
  WorkflowRuntimeStatus,
} from '../application/WorkflowControlRepository';

interface Envelope<T> {
  ok: true;
  result: T;
}

const route = (path: string) => `${path}?target=${encodeURIComponent(getBaseUrl())}`;
const post = (value?: unknown): RequestInit => ({
  method: 'POST',
  headers: value === undefined ? undefined : { 'Content-Type': 'application/json' },
  body: value === undefined ? undefined : JSON.stringify(value),
});

async function result<T>(path: string, init?: RequestInit): Promise<T> {
  return (await agentRequest<Envelope<T>>(route(path), init)).result;
}

export const bqWorkflowControlRepository: WorkflowControlRepository = {
  status: () => result<WorkflowRuntimeStatus>('/workflows/runtime'),
  reload: () => result<WorkflowRuntimeStatus>('/workflows/runtime/reload', post()),
  start: async (workflowName, input) =>
    (
      await result<{ run: { id: string; workflowName: string } }>(
        '/workflows/start',
        post({ workflowName, input })
      )
    ).run,
  signal: async (executionId, event, payload) => {
    await result(`/workflows/${encodeURIComponent(executionId)}/signal`, post({ event, payload }));
  },
  recover: async () =>
    (await result<{ recovered: ReturnTypeShape }>('/workflows/recover', post())).recovered,
  resumeCompensation: async (executionId) => {
    await result(`/workflows/${encodeURIComponent(executionId)}/resume-compensation`, post());
  },
  abandonCompensation: async (executionId) => {
    await result(`/workflows/${encodeURIComponent(executionId)}/abandon-compensation`, post());
  },
  archive: async (maxAgeMs, states) =>
    (await result<{ affected: number }>('/workflows/archive', post({ maxAgeMs, states }))).affected,
  cleanup: async (maxAgeMs, states) =>
    (await result<{ affected: number }>('/workflows/cleanup', post({ maxAgeMs, states }))).affected,
};

type ReturnTypeShape = {
  running: number;
  waiting: number;
  compensating: number;
  total: number;
};
