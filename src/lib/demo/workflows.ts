import type { Json } from './shared';

const ACTIVE: Json[] = [
  {
    id: 'wf-order-2026-0804',
    workflowName: 'order-fulfillment',
    state: 'running',
    currentNodeIndex: 3,
    createdAt: 1785838920000,
    updatedAt: 1785839040000,
    definitionHash: 'sha256:8a03c8e91db4d8f5',
    input: { orderId: 'ord_9a3f', customerId: 'cus_417', total: 129.9 },
    steps: {
      validate: {
        status: 'completed',
        attempts: 1,
        startedAt: 1785838920100,
        completedAt: 1785838920210,
        result: { valid: true },
      },
      charge: {
        status: 'completed',
        attempts: 1,
        startedAt: 1785838920300,
        completedAt: 1785838921120,
        compensatable: true,
        idempotencyKey: 'charge:ord_9a3f',
        result: { paymentId: 'pay_802' },
      },
      reserveInventory: {
        status: 'completed',
        attempts: 2,
        startedAt: 1785838921200,
        completedAt: 1785838930600,
        compensatable: true,
        result: { reservationId: 'res_551' },
      },
      ship: {
        status: 'running',
        attempts: 1,
        startedAt: 1785839040000,
        childExecutionId: 'wf-shipping-0804',
      },
    },
    resolvedSteps: ['validate', 'charge', 'reserveInventory', 'ship'],
    signals: {},
    decisions: { 'branch:payment': 'card' },
  },
  {
    id: 'wf-refund-2026-0803',
    workflowName: 'refund-order',
    state: 'compensation-stuck',
    currentNodeIndex: 4,
    createdAt: 1785751200000,
    updatedAt: 1785751320000,
    rollbackStatus: 'stuck',
    failureReason: 'Refund provider unavailable after 3 attempts',
    definitionHash: 'sha256:cc89ab41c1b2f011',
    input: { orderId: 'ord_772', reason: 'customer_request' },
    steps: {
      loadOrder: { status: 'completed', attempts: 1, result: { paymentId: 'pay_331' } },
      revokeShipment: {
        status: 'completed',
        attempts: 1,
        compensatable: true,
        compensation: { status: 'compensated', at: 1785751300100 },
      },
      refundPayment: {
        status: 'failed',
        attempts: 3,
        compensatable: true,
        error: 'Provider timeout',
        compensation: {
          status: 'compensation-failed',
          at: 1785751320000,
          error: 'Provider unavailable',
        },
      },
    },
    resolvedSteps: ['loadOrder', 'revokeShipment', 'refundPayment'],
    signals: { approved: { actor: 'ops@example.com' } },
    decisions: { 'branch:refund-method': 'original-payment' },
  },
  {
    id: 'wf-signup-2026-0802',
    workflowName: 'customer-onboarding',
    state: 'waiting',
    currentNodeIndex: 2,
    createdAt: 1785664800000,
    updatedAt: 1785664920000,
    input: { customerId: 'cus_881', plan: 'pro' },
    steps: {
      createAccount: { status: 'completed', attempts: 1, result: { accountId: 'acc_881' } },
      sendVerification: { status: 'completed', attempts: 1, result: { messageId: 'msg_194' } },
    },
    resolvedSteps: ['createAccount', 'sendVerification'],
    signals: {},
  },
];

const ARCHIVED: Json[] = [
  {
    id: 'wf-month-close-2026-07',
    workflowName: 'month-end-close',
    state: 'completed',
    currentNodeIndex: 4,
    createdAt: 1785578400000,
    updatedAt: 1785578465000,
    archivedAt: 1785664800000,
    rollbackStatus: 'not-applicable',
    definitionHash: 'sha256:78b6fd851d8b32a1',
    input: { period: '2026-07' },
    steps: {
      lockPeriod: { status: 'completed', attempts: 1, result: { locked: true } },
      aggregate: { status: 'completed', attempts: 1, result: { entries: 1842 } },
      publish: { status: 'completed', attempts: 1, result: { reportId: 'rep_2026_07' } },
    },
    resolvedSteps: ['lockPeriod', 'aggregate', 'publish'],
    signals: {},
    decisions: {},
  },
  {
    id: 'wf-import-legacy-441',
    workflowName: 'legacy-import',
    state: 'failed',
    currentNodeIndex: 1,
    createdAt: 1785492000000,
    updatedAt: 1785492009000,
    archivedAt: 1785664800000,
    rollbackStatus: 'not-applicable',
    failureReason: 'Input schema rejected row 441',
    input: { batch: 'legacy-2026-07' },
    steps: {
      validate: { status: 'failed', attempts: 1, error: 'Invalid customer reference at row 441' },
    },
    resolvedSteps: ['validate'],
    signals: {},
    decisions: {},
  },
];

const runtimeStatus = {
  configured: true,
  ready: true,
  moduleName: 'demo-workflows',
  workflowNames: ['customer-onboarding', 'order-fulfillment', 'refund-order'],
};
const envelope = (result: unknown): Json => ({ ok: true, result });

function controlResponse(segments: string[], method: string): Json | null {
  if (segments[1] === 'runtime' && (segments.length === 2 || segments[2] === 'reload')) {
    return envelope(runtimeStatus);
  }
  if (method !== 'POST') return null;
  if (segments[1] === 'start') {
    return envelope({ run: { id: 'wf-demo-started', workflowName: 'order-fulfillment' } });
  }
  if (segments[1] === 'recover') {
    return envelope({ recovered: { running: 1, waiting: 1, compensating: 0, total: 2 } });
  }
  if (segments[1] === 'archive' || segments[1] === 'cleanup') {
    return envelope({ affected: 1 });
  }
  if (
    segments[2] === 'signal' ||
    segments[2] === 'resume-compensation' ||
    segments[2] === 'abandon-compensation'
  ) {
    return envelope({ applied: true });
  }
  return null;
}

export function demoWorkflowResponse(segments: string[], search: string, method: string): Json {
  const control = controlResponse(segments, method);
  if (control) return control;
  if (segments[1] === 'stats') {
    const states = {
      running: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      compensating: 0,
      'compensation-stuck': 0,
    };
    for (const execution of ACTIVE) {
      states[execution.state as keyof typeof states]++;
    }
    return {
      ok: true,
      available: true,
      activeTotal: ACTIVE.length,
      archiveTotal: ARCHIVED.length,
      states,
      workflowNames: [
        ...new Set([...ACTIVE, ...ARCHIVED].map((execution) => String(execution.workflowName))),
      ].sort(),
    };
  }
  const params = new URLSearchParams(search);
  const source = params.get('kind') === 'archive' ? ARCHIVED : ACTIVE;
  if (segments[1]) {
    const execution = source.find((item) => item.id === decodeURIComponent(segments[1]));
    return execution
      ? { ok: true, execution }
      : { ok: false, error: 'Workflow execution not found' };
  }
  const workflowName = params.get('workflowName');
  const state = params.get('state');
  const offset = Number(params.get('offset') ?? 0);
  const limit = Number(params.get('limit') ?? 50);
  const filtered = source.filter(
    (execution) =>
      (!workflowName || execution.workflowName === workflowName) &&
      (!state ||
        execution.state === state ||
        (state === 'compensation' &&
          (execution.state === 'compensating' || execution.state === 'compensation-stuck')))
  );
  const executions = filtered
    .slice(offset, offset + limit)
    .map(
      ({
        input: _input,
        steps: _steps,
        resolvedSteps: _resolved,
        signals: _signals,
        decisions: _decisions,
        ...summary
      }) => summary
    );
  return { ok: true, available: true, executions, total: filtered.length, limit, offset };
}
