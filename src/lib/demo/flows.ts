import type { Json } from './shared';

export const DEMO_FLOW: Record<string, Json> = {
  'flow-order-9a3f': {
    id: 'flow-order-9a3f',
    queue: 'orders',
    data: {
      name: 'process-order',
      orderId: 'demo-9a3f',
      __childrenIds: ['flow-charge-1', 'flow-ship-2', 'flow-notify-3'],
    },
    state: 'waiting-children',
    priority: 1,
    parentId: null,
    childrenIds: ['flow-charge-1', 'flow-ship-2', 'flow-notify-3'],
    dependsOn: ['flow-charge-1', 'flow-ship-2', 'flow-notify-3'],
  },
  'flow-charge-1': {
    id: 'flow-charge-1',
    queue: 'payments',
    data: {
      name: 'charge-payment',
      __parentId: 'flow-order-9a3f',
      __parentQueue: 'orders',
    },
    state: 'completed',
    priority: 2,
    parentId: 'flow-order-9a3f',
    childrenIds: [],
    dependsOn: [],
  },
  'flow-ship-2': {
    id: 'flow-ship-2',
    queue: 'shipping',
    data: {
      name: 'ship-order',
      __parentId: 'flow-order-9a3f',
      __parentQueue: 'orders',
      __childrenIds: ['flow-label-4'],
    },
    state: 'waiting-children',
    priority: 1,
    parentId: 'flow-order-9a3f',
    childrenIds: ['flow-label-4'],
    dependsOn: ['flow-label-4'],
  },
  'flow-label-4': {
    id: 'flow-label-4',
    queue: 'shipping',
    data: {
      name: 'create-label',
      __parentId: 'flow-ship-2',
      __parentQueue: 'shipping',
    },
    state: 'waiting',
    priority: 0,
    parentId: 'flow-ship-2',
    childrenIds: [],
    dependsOn: [],
  },
  'flow-notify-3': {
    id: 'flow-notify-3',
    queue: 'emails',
    data: {
      name: 'notify-customer',
      __parentId: 'flow-order-9a3f',
      __parentQueue: 'orders',
    },
    state: 'delayed',
    priority: 0,
    parentId: 'flow-order-9a3f',
    childrenIds: [],
    dependsOn: ['flow-charge-1'],
  },
};

interface DemoTreeNode {
  id: string;
  name: string;
  queueName: string;
  state: string;
  children: DemoTreeNode[];
}

const DEMO_TREE: DemoTreeNode = {
  id: 'flow-order-9a3f',
  name: 'process-order',
  queueName: 'orders',
  state: 'waiting-children',
  children: [
    {
      id: 'flow-charge-1',
      name: 'charge-payment',
      queueName: 'payments',
      state: 'completed',
      children: [],
    },
    {
      id: 'flow-ship-2',
      name: 'ship-order',
      queueName: 'shipping',
      state: 'waiting-children',
      children: [
        {
          id: 'flow-label-4',
          name: 'create-label',
          queueName: 'shipping',
          state: 'waiting',
          children: [],
        },
      ],
    },
    {
      id: 'flow-notify-3',
      name: 'notify-customer',
      queueName: 'emails',
      state: 'delayed',
      children: [],
    },
  ],
};

export function demoFlowResponse(segments: string[], method: string, search = ''): Json {
  if (segments[1] === 'results') {
    return {
      ok: true,
      result: {
        operation: 'getParentResults',
        entries: [
          ['flow-demo-child', { rows: 42 }],
          ['flow-demo-zero', 0],
        ],
      },
    };
  }
  if (segments[1] === 'tree') {
    return {
      ok: true,
      result: {
        flow: boundedDemoTree(search),
      },
    };
  }
  if (segments[1] === 'create') {
    return {
      ok: true,
      result: {
        operation: 'add',
        root: {
          id: 'flow-demo-created',
          name: 'aggregate',
          queueName: 'reports',
          state: 'waiting-children',
          children: [],
        },
      },
    };
  }
  if (method === 'GET') {
    return {
      ok: true,
      result: {
        values: {},
        dependencies: { processed: {}, unprocessed: ['flow-demo-child'] },
        counts: { processed: 0, unprocessed: 1 },
      },
    };
  }
  return { ok: true, result: { applied: true, removed: true } };
}

function boundedDemoTree(search: string): DemoTreeNode {
  const query = new URLSearchParams(search);
  const depth = demoLimit(query.get('depth'), 500);
  const maxChildren = demoLimit(query.get('maxChildren'), 500);
  const visit = (node: DemoTreeNode, level: number): DemoTreeNode => ({
    ...node,
    children:
      level >= depth
        ? []
        : node.children.slice(0, maxChildren).map((child) => visit(child, level + 1)),
  });
  return visit(DEMO_TREE, 0);
}

function demoLimit(value: string | null, fallback: number): number {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  return Math.min(Number(value), 500);
}
