import { useMemo } from 'react';
import { layoutDag } from '@/lib/flowLayout';
import { FLOW_LAYOUT } from '../domain/flowConstants';
import type { Graph } from '../domain/flowSnapshot';
import { FlowCanvas } from './FlowCanvas';
import { FlowInspector } from './FlowInspector';

export function FlowWorkspace({
  graph,
  selected,
  onSelect,
}: {
  graph: Graph;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const layout = useMemo(
    () => layoutDag([...graph.jobs.keys()], graph.edges, FLOW_LAYOUT),
    [graph]
  );
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
      <FlowCanvas graph={graph} layout={layout} selected={selected} onSelect={onSelect} />
      <FlowInspector graph={graph} selected={selected} />
    </div>
  );
}
