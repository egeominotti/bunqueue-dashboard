import { bq } from '@/lib/bq';
import type { WorkflowRepository } from '../application/WorkflowRepository';

export const bqWorkflowRepository: WorkflowRepository = {
  stats: () => bq.workflows.stats(),
  list: (query) => bq.workflows.list(query),
  get: (id, kind) => bq.workflows.get(id, kind),
};
