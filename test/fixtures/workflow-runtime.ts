import { type Engine, Workflow } from 'bunqueue/workflow';

const compensationAttempts = new Map<string, number>();

const approval = new Workflow<{ value: number }>('dashboard-approval-e2e', { revision: 1 })
  .step('prepare', ({ input }) => input.value * 2)
  .waitFor('approved')
  .step('finish', ({ steps, signals }) => ({
    prepared: steps.prepare,
    approved: signals.approved,
  }));

const instant = new Workflow<{ value: number }>('dashboard-instant-e2e', { revision: 1 }).step(
  'finish',
  ({ input }) => input.value
);

const compensation = new Workflow<{ decision: 'resume' | 'abandon' }>(
  'dashboard-compensation-e2e',
  { revision: 1 }
)
  .step('reserve', ({ executionId }) => ({ executionId }), {
    compensate: ({ executionId, input }) => {
      const count = (compensationAttempts.get(executionId) ?? 0) + 1;
      compensationAttempts.set(executionId, count);
      if (input.decision === 'abandon' || count === 1) throw new Error('synthetic reversal outage');
    },
  })
  .step('fail-forward', () => {
    throw new Error('synthetic forward failure');
  });

const workflows = [approval, instant, compensation];

export function registerWorkflowRuntime(engine: Engine): void {
  for (const workflow of workflows) engine.register(workflow);
}
