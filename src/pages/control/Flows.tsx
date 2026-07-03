import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { isDemo } from '@/lib/demo/isDemo';
import { type FlowEdge, type LayoutOptions, layoutDag } from '@/lib/flowLayout';

/**
 * Flows — an interactive DAG of a job flow (parent / children / dependsOn). Paste
 * a job id (or arrive via ?root=), and the page climbs to the flow's root, walks
 * the graph client-side from JobFull.childrenIds + dependsOn (bunqueue has no
 * single "get whole flow" HTTP endpoint), lays it out with the pure layoutDag
 * engine, and draws it: nodes coloured by state, solid edges for children,
 * dashed for dependencies. Click a node to inspect it. 100% frontend, no graph
 * library. In demo mode it auto-loads a sample flow.
 */

const NODE_W = 168;
const NODE_H = 60;
const LAYOUT: LayoutOptions = { nodeWidth: NODE_W, nodeHeight: NODE_H };
const MAX_NODES = 60;
const MAX_DEPTH = 6;
const DEMO_ROOT = 'flow-order-9a3f';

const STATE_STYLE: Record<string, string> = {
  completed: 'border-success/50 bg-success/10 text-success',
  failed: 'border-danger/50 bg-danger/10 text-danger',
  active: 'border-blue-400/60 bg-blue-400/10 text-blue-400',
  delayed: 'border-accent/50 bg-accent/10 text-accent',
  waiting: 'border-warning/50 bg-warning/10 text-warning',
  prioritized: 'border-warning/50 bg-warning/10 text-warning',
};
const stateStyle = (s?: string) => (s && STATE_STYLE[s]) || 'border-line bg-surface-2 text-muted';

const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

// bunqueue has no "list flows" endpoint, so the empty state offers the flows
// this browser has already viewed (persisted locally) instead of a dead end.
const RECENT_KEY = 'bq-dash-recent-flows';
const RECENT_MAX = 8;

interface RecentFlow {
  root: string;
  nodes: number;
  at: number;
}

function readRecentFlows(): RecentFlow[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is RecentFlow =>
        typeof (r as RecentFlow)?.root === 'string' &&
        typeof (r as RecentFlow)?.nodes === 'number' &&
        typeof (r as RecentFlow)?.at === 'number'
    );
  } catch {
    return [];
  }
}

function pushRecentFlow(list: RecentFlow[], entry: RecentFlow): RecentFlow[] {
  const next = [entry, ...list.filter((r) => r.root !== entry.root)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage full/blocked — the in-memory list still works this session */
  }
  return next;
}

interface Graph {
  jobs: Map<string, JobFull>;
  edges: FlowEdge[];
}

/** Climb parentId to the flow's true root so pasting any node shows the whole flow. */
async function findRoot(id: string): Promise<string> {
  let cur = id;
  const seen = new Set<string>([id]);
  for (let hops = 0; hops < 12; hops++) {
    try {
      const { job } = await bq.job(cur);
      const parent = job?.parentId;
      if (parent && !seen.has(parent)) {
        seen.add(parent);
        cur = parent;
        continue;
      }
    } catch {
      /* unreachable / missing: stop climbing */
    }
    break;
  }
  return cur;
}

/** BFS from the root over childrenIds (child edges) + dependsOn (depends edges). */
async function walkFlow(rootId: string): Promise<Graph> {
  const jobs = new Map<string, JobFull>();
  const edges: FlowEdge[] = [];
  const seenEdge = new Set<string>();
  const queue: { id: string; depth: number }[] = [{ id: rootId, depth: 0 }];

  while (queue.length && jobs.size < MAX_NODES) {
    const { id, depth } = queue.shift() as { id: string; depth: number };
    if (jobs.has(id)) continue;

    let job: JobFull | null = null;
    try {
      job = (await bq.job(id)).job ?? null;
    } catch {
      /* keep a placeholder node so a dangling reference still renders */
    }
    jobs.set(id, job ?? ({ id, state: 'unknown' } as JobFull));
    if (!job || depth >= MAX_DEPTH) continue;

    const addEdge = (from: string, to: string, kind: FlowEdge['kind'], next: string) => {
      const k = `${from}->${to}:${kind}`;
      if (!seenEdge.has(k)) {
        seenEdge.add(k);
        edges.push({ from, to, kind });
      }
      queue.push({ id: next, depth: depth + 1 });
    };
    for (const c of job.childrenIds ?? []) addEdge(id, c, 'child', c);
    for (const d of job.dependsOn ?? []) addEdge(d, id, 'depends', d);
  }
  return { jobs, edges };
}

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

export function Flows() {
  const [params, setParams] = useSearchParams();
  const rootParam = params.get('root') ?? (isDemo() ? DEMO_ROOT : '');
  const [input, setInput] = useState(rootParam);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentFlow[]>(readRecentFlows);
  const reqId = useRef(0);

  const load = useCallback(async (seed: string) => {
    const id = seed.trim();
    if (!id) {
      setGraph(null);
      return;
    }
    const mine = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const root = await findRoot(id);
      const g = await walkFlow(root);
      if (mine !== reqId.current) return;
      setGraph(g);
      setSelected(root);
      // Remember real flows (2+ nodes) so the empty state can offer them later.
      if (g.jobs.size > 1) {
        setRecent((list) => pushRecentFlow(list, { root, nodes: g.jobs.size, at: Date.now() }));
      }
    } catch (e) {
      if (mine !== reqId.current) return;
      setError((e as Error).message || 'Failed to load flow');
      setGraph(null);
    } finally {
      if (mine === reqId.current) setLoading(false);
    }
  }, []);

  // Auto-load from ?root= (or the demo sample) on mount / when the param changes.
  useEffect(() => {
    if (rootParam) load(rootParam);
  }, [rootParam, load]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = input.trim();
    if (id) setParams(id ? { root: id } : {}, { replace: true });
  };

  const layout = graph ? layoutDag([...graph.jobs.keys()], graph.edges, LAYOUT) : null;
  const pos = new Map(layout?.nodes.map((n) => [n.id, n]) ?? []);
  const selectedJob = selected ? graph?.jobs.get(selected) : undefined;

  return (
    <div>
      <PageHeader
        title="Flows"
        description="Visualize a job flow: parent, children, and dependency edges as an interactive graph."
        actions={
          graph && (
            <button
              type="button"
              onClick={() => load(input || rootParam)}
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
            >
              Refresh
            </button>
          )
        }
      />

      <Card className="mb-6">
        <form onSubmit={submit} className="flex flex-wrap items-center gap-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Job ID (any node in the flow)"
            aria-label="Root job ID"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/50"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50"
          >
            Load flow
          </button>
        </form>
        <p className="mt-2 text-xs text-faint">
          Paste any job ID from the Job Inspector. The graph climbs to the flow root, then walks
          children and dependencies (up to {MAX_NODES} nodes).
        </p>
      </Card>

      {error && <OfflineBanner onRetry={() => load(input || rootParam)} />}
      {loading && !graph && <LoadingState label="Loading flow…" />}

      {!loading && !graph && !error && (
        <Card>
          <div className="py-16 text-center">
            <p className="text-sm text-muted">No flow loaded.</p>
            <p className="mt-1 text-xs text-faint">
              Enter a job ID above, or open a job that is part of a flow and choose “View flow”.
            </p>
            {recent.length > 0 && (
              <div className="mt-6">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-faint">
                  Recently viewed
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {recent.map((r) => (
                    <button
                      key={r.root}
                      type="button"
                      onClick={() => {
                        setInput(r.root);
                        setParams({ root: r.root }, { replace: true });
                      }}
                      className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 font-mono text-xs text-muted transition-colors hover:border-line-strong hover:text-fg"
                    >
                      {shortId(r.root)}
                      <span className="ml-2 text-faint">{r.nodes} nodes</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {graph && layout && (
        <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
          <Card padded={false} className="overflow-auto p-4">
            <div className="relative" style={{ width: layout.width, height: layout.height }}>
              <svg
                aria-hidden="true"
                className="absolute inset-0 text-line"
                width={layout.width}
                height={layout.height}
              >
                <title>Flow edges</title>
                {graph.edges.map((e) => {
                  const a = pos.get(e.from);
                  const b = pos.get(e.to);
                  if (!a || !b) return null;
                  return (
                    <path
                      key={`${e.from}-${e.to}-${e.kind}`}
                      d={edgePath(a.x + NODE_W, a.y + NODE_H / 2, b.x, b.y + NODE_H / 2)}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeDasharray={e.kind === 'depends' ? '4 4' : undefined}
                      opacity={0.5}
                    />
                  );
                })}
              </svg>
              {layout.nodes.map((n) => {
                const job = graph.jobs.get(n.id);
                return (
                  <button
                    type="button"
                    key={n.id}
                    onClick={() => setSelected(n.id)}
                    style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
                    className={cn(
                      'absolute flex flex-col justify-center gap-0.5 rounded-lg border px-3 text-left transition-shadow',
                      stateStyle(job?.state),
                      selected === n.id && 'ring-2 ring-accent'
                    )}
                  >
                    <span className="truncate font-mono text-xs text-fg">{shortId(n.id)}</span>
                    <span className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="truncate">{job?.queue ?? '—'}</span>
                      <span className="font-medium">{job?.state ?? 'unknown'}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card>
            {selectedJob ? (
              <div className="space-y-3 text-sm">
                <div>
                  <div className="text-xs text-faint">Job</div>
                  <div className="break-all font-mono text-xs text-fg">{selectedJob.id}</div>
                </div>
                <Field label="Queue" value={selectedJob.queue ?? '—'} />
                <Field label="State" value={selectedJob.state ?? 'unknown'} />
                <Field label="Priority" value={String(selectedJob.priority ?? 0)} />
                <Field label="Children" value={String(selectedJob.childrenIds?.length ?? 0)} />
                <Field label="Depends on" value={String(selectedJob.dependsOn?.length ?? 0)} />
                <Link
                  to={`/job?id=${encodeURIComponent(selectedJob.id)}`}
                  className="inline-block rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
                >
                  Open in Job Inspector
                </Link>
              </div>
            ) : (
              <p className="text-sm text-muted">Click a node to inspect it.</p>
            )}
            <div className="mt-4 border-t border-line pt-3 text-xs text-faint">
              <div className="mb-1">
                {graph.jobs.size} node{graph.jobs.size === 1 ? '' : 's'} · {graph.edges.length} edge
                {graph.edges.length === 1 ? '' : 's'}
              </div>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-px w-4 bg-current" /> child
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-px w-4 border-t border-dashed border-current" />{' '}
                  depends
                </span>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-faint">{label}</span>
      <span className="text-fg">{value}</span>
    </div>
  );
}
