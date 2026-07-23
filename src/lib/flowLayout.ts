/**
 * Pure layered (Sugiyama-lite) layout for a job-flow DAG. No rendering, no React,
 * no external deps, so it is unit-testable in isolation. Each edge `from -> to`
 * means `to` sits at least one layer after `from` (a child, or a dependency
 * consumer). Nodes are placed in columns by layer (left to right) and stacked
 * vertically within each column, then every column is centred.
 *
 * Cycle-safe: a genuine cycle (which a job DAG should never contain, but a
 * corrupt/looping `dependsOn` could) can't starve the queue — when nothing is
 * left with in-degree 0 the earliest unplaced node is forced ready, so only the
 * cycle's back-edge is ignored and everything downstream still layers normally.
 */
export type FlowEdgeKind = 'child' | 'depends';
export interface FlowEdge {
  from: string;
  to: string;
  kind: FlowEdgeKind;
}
export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  layer: number;
}
export interface FlowLayout {
  nodes: PositionedNode[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  colGap?: number;
  rowGap?: number;
  padding?: number;
}

const DEFAULTS = { nodeWidth: 168, nodeHeight: 60, colGap: 72, rowGap: 20, padding: 24 };

/**
 * Compute the layer of every node via longest-path (Kahn's algorithm on the DAG,
 * relaxing `layer[to] = max(layer[to], layer[from] + 1)`). Returns a layer index
 * for each id; ids not present in any edge stay at layer 0.
 */
export function computeLayers(ids: string[], edges: FlowEdge[]): Map<string, number> {
  const layer = new Map<string, number>();
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const id of ids) {
    layer.set(id, 0);
    indeg.set(id, 0);
    out.set(id, []);
  }
  for (const e of edges) {
    if (!layer.has(e.from) || !layer.has(e.to) || e.from === e.to) continue;
    out.get(e.from)?.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const placed = new Set<string>();
  while (placed.size < layer.size) {
    while (queue.length) {
      const u = queue.shift() as string;
      if (placed.has(u)) continue;
      placed.add(u);
      for (const v of out.get(u) ?? []) {
        // An already-placed target is never relaxed again: in a real DAG that
        // cannot happen (a node is popped only once every predecessor relaxed
        // it), and inside a cycle it is exactly the back-edge to ignore.
        if (placed.has(v)) continue;
        layer.set(v, Math.max(layer.get(v) ?? 0, (layer.get(u) ?? 0) + 1));
        const d = (indeg.get(v) ?? 0) - 1;
        indeg.set(v, d);
        if (d === 0) queue.push(v);
      }
    }
    // Cycle backstop: nothing is left with in-degree 0, so force the earliest
    // unplaced node (input order) ready. That drops one back-edge instead of
    // stranding the whole downstream subgraph at layer 0.
    const stuck = ids.find((id) => !placed.has(id));
    if (stuck === undefined) break;
    queue.push(stuck);
  }
  return layer;
}

/** Lay the DAG out in columns (one per layer), each column vertically centred. */
export function layoutDag(
  ids: string[],
  edges: FlowEdge[],
  options: LayoutOptions = {}
): FlowLayout {
  const o = { ...DEFAULTS, ...options };
  const layer = computeLayers(ids, edges);

  // Group node ids by layer, preserving input order for stable placement.
  const byLayer = new Map<number, string[]>();
  let maxLayer = 0;
  for (const id of ids) {
    const l = layer.get(id) ?? 0;
    maxLayer = Math.max(maxLayer, l);
    const arr = byLayer.get(l);
    if (arr) arr.push(id);
    else byLayer.set(l, [id]);
  }

  let tallest = 0;
  for (const arr of byLayer.values()) tallest = Math.max(tallest, arr.length);
  const colHeight = tallest * o.nodeHeight + Math.max(0, tallest - 1) * o.rowGap;

  const nodes: PositionedNode[] = [];
  for (let l = 0; l <= maxLayer; l++) {
    const arr = byLayer.get(l) ?? [];
    const thisHeight = arr.length * o.nodeHeight + Math.max(0, arr.length - 1) * o.rowGap;
    const startY = o.padding + (colHeight - thisHeight) / 2;
    arr.forEach((id, i) => {
      nodes.push({
        id,
        layer: l,
        x: o.padding + l * (o.nodeWidth + o.colGap),
        y: startY + i * (o.nodeHeight + o.rowGap),
      });
    });
  }

  const width = o.padding * 2 + (maxLayer + 1) * o.nodeWidth + maxLayer * o.colGap;
  const height = o.padding * 2 + colHeight;
  return { nodes, width, height };
}
