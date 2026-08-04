import type { LayoutOptions } from '@/lib/flowLayout';

export const FLOW_NODE_WIDTH = 168;
export const FLOW_NODE_HEIGHT = 60;
export const FLOW_LAYOUT: LayoutOptions = {
  nodeWidth: FLOW_NODE_WIDTH,
  nodeHeight: FLOW_NODE_HEIGHT,
};
export const MAX_FLOW_NODES = 500;
export const MAX_FLOW_DEPTH = 100;
export const MAX_PARENT_HOPS = 100;
export const DEMO_FLOW_ROOT = 'flow-order-9a3f';

const STATE_STYLE: Record<string, string> = {
  completed: 'border-success/50 bg-success/10 text-success',
  failed: 'border-danger/50 bg-danger/10 text-danger',
  active: 'border-blue-400/60 bg-blue-400/10 text-blue-400',
  delayed: 'border-accent/50 bg-accent/10 text-accent',
  waiting: 'border-warning/50 bg-warning/10 text-warning',
  prioritized: 'border-warning/50 bg-warning/10 text-warning',
  'waiting-children': 'border-cyan-400/60 bg-cyan-400/10 text-cyan-400',
};

export const flowStateStyle = (state?: string) =>
  (state && STATE_STYLE[state]) || 'border-line bg-surface-2 text-muted';

export const shortFlowId = (id: string) =>
  id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
