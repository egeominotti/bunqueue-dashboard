import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import type { FlowLayout } from '@/lib/flowLayout';
import {
  FLOW_NODE_HEIGHT,
  FLOW_NODE_WIDTH,
  flowStateStyle,
  shortFlowId,
} from '../domain/flowConstants';
import type { Graph } from '../domain/flowSnapshot';

export function FlowCanvas({
  graph,
  layout,
  selected,
  onSelect,
}: {
  graph: Graph;
  layout: FlowLayout;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const positions = new Map(layout.nodes.map((node) => [node.id, node]));
  return (
    <Card padded={false} className="max-h-[70vh] overflow-auto overscroll-contain p-4">
      <h2 className="sr-only">Flow Graph</h2>
      <ul className="sr-only" aria-label="Flow relationships">
        {graph.edges.map((edge) => (
          <li key={`accessible-${edge.from}-${edge.to}-${edge.kind}`}>
            {edge.kind === 'child'
              ? `${edge.from} has child ${edge.to}`
              : `${edge.to} depends on ${edge.from}`}
          </li>
        ))}
      </ul>
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <svg
          aria-hidden="true"
          className="absolute inset-0 text-line"
          width={layout.width}
          height={layout.height}
        >
          <defs>
            <marker
              id="flow-arrow-child"
              markerWidth="6"
              markerHeight="6"
              refX="5"
              refY="3"
              orient="auto"
            >
              <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" />
            </marker>
            <marker
              id="flow-arrow-dependency"
              markerWidth="6"
              markerHeight="6"
              refX="5"
              refY="3"
              orient="auto"
            >
              <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" />
            </marker>
          </defs>
          {graph.edges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            return (
              <path
                key={`${edge.from}-${edge.to}-${edge.kind}`}
                d={pathBetween(from, to)}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeDasharray={edge.kind === 'depends' ? '4 4' : undefined}
                markerEnd={`url(#flow-arrow-${edge.kind === 'depends' ? 'dependency' : 'child'})`}
                opacity={0.5}
              />
            );
          })}
        </svg>
        {layout.nodes.map((node) => {
          const job = graph.jobs.get(node.id);
          const unavailable = graph.failures.has(node.id);
          const state = unavailable ? 'unavailable' : (job?.state ?? 'unknown');
          return (
            <button
              type="button"
              key={node.id}
              data-flow-node={node.id}
              onClick={() => onSelect(node.id)}
              aria-pressed={selected === node.id}
              aria-label={`${node.id}, queue ${job?.queue ?? 'unknown'}, state ${state}`}
              title={node.id}
              style={{
                left: node.x,
                top: node.y,
                width: FLOW_NODE_WIDTH,
                height: FLOW_NODE_HEIGHT,
              }}
              className={cn(
                'absolute flex flex-col justify-center gap-0.5 rounded-lg border px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70',
                flowStateStyle(job?.state),
                selected === node.id && 'ring-2 ring-accent'
              )}
            >
              <span translate="no" className="truncate font-mono text-xs text-fg">
                {shortFlowId(node.id)}
              </span>
              <span className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate">{job?.queue ?? '—'}</span>
                <span className="font-medium">{state}</span>
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const middle = (x1 + x2) / 2;
  return `M${x1},${y1} C${middle},${y1} ${middle},${y2} ${x2},${y2}`;
}

function pathBetween(from: { x: number; y: number }, to: { x: number; y: number }): string {
  return from.x <= to.x
    ? edgePath(
        from.x + FLOW_NODE_WIDTH,
        from.y + FLOW_NODE_HEIGHT / 2,
        to.x,
        to.y + FLOW_NODE_HEIGHT / 2
      )
    : edgePath(
        from.x,
        from.y + FLOW_NODE_HEIGHT / 2,
        to.x + FLOW_NODE_WIDTH,
        to.y + FLOW_NODE_HEIGHT / 2
      );
}
