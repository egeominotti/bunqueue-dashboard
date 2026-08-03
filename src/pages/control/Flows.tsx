import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getBaseUrl, useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Card } from '@/components/ui/Card';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  BqError,
  captureServerRequestTarget,
  getJobAtTarget,
  type ServerRequestTarget,
} from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { isDemo } from '@/lib/demo/isDemo';
import { type FlowEdge, type LayoutOptions, layoutDag } from '@/lib/flowLayout';
import { opaqueHttpIdError } from '@/lib/upstreamPaths';

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
// v2.8.55 accepts a 100-level atomic flow. Keep every requested seed path
// representable; the node cap remains a browser/render safety boundary.
const MAX_NODES = 500;
const MAX_DEPTH = 100;
const MAX_PARENT_HOPS = 100;
const DEMO_ROOT = 'flow-order-9a3f';

const STATE_STYLE: Record<string, string> = {
  completed: 'border-success/50 bg-success/10 text-success',
  failed: 'border-danger/50 bg-danger/10 text-danger',
  active: 'border-blue-400/60 bg-blue-400/10 text-blue-400',
  delayed: 'border-accent/50 bg-accent/10 text-accent',
  waiting: 'border-warning/50 bg-warning/10 text-warning',
  prioritized: 'border-warning/50 bg-warning/10 text-warning',
  'waiting-children': 'border-cyan-400/60 bg-cyan-400/10 text-cyan-400',
};
export const flowStateStyle = (s?: string) =>
  (s && STATE_STYLE[s]) || 'border-line bg-surface-2 text-muted';

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

/** Recent flow ids are server-scoped; ids from another target are meaningless. */
export function recentFlowsStorageKey(target: string): string {
  return `${RECENT_KEY}:${encodeURIComponent(target.trim() || '/api')}`;
}

function readRecentFlows(target: string, persist: boolean): RecentFlow[] {
  if (!persist) return [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(recentFlowsStorageKey(target)) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (r): r is RecentFlow =>
          typeof (r as RecentFlow)?.root === 'string' &&
          (r as RecentFlow).root.length > 0 &&
          (r as RecentFlow).root.length <= 1024 &&
          Number.isSafeInteger((r as RecentFlow)?.nodes) &&
          (r as RecentFlow).nodes > 1 &&
          (r as RecentFlow).nodes <= MAX_NODES &&
          Number.isFinite((r as RecentFlow)?.at) &&
          (r as RecentFlow).at >= 0
      )
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function pushRecentFlow(
  target: string,
  list: RecentFlow[],
  entry: RecentFlow,
  persist: boolean
): RecentFlow[] {
  const next = [entry, ...list.filter((r) => r.root !== entry.root)].slice(0, RECENT_MAX);
  if (!persist) return next;
  try {
    localStorage.setItem(recentFlowsStorageKey(target), JSON.stringify(next));
  } catch {
    /* storage full/blocked — the in-memory list still works this session */
  }
  return next;
}

export interface Graph {
  jobs: Map<string, JobFull>;
  edges: FlowEdge[];
  /** True when the walk stopped at MAX_NODES/MAX_DEPTH before exhausting the flow. */
  truncated: boolean;
  /** Nodes whose GET /jobs/:id failed — their edges are missing from the graph. */
  failed: number;
  /** Per-node reason for an unavailable/malformed referenced job. */
  failures: Map<string, string>;
  /** Definite topology violations visible in the HTTP snapshot. */
  issues: string[];
  /** Missing dependencies that a configured failure policy may have released. */
  policyNotes: string[];
  /** One real dependency cycle, if present (first id is repeated at the end). */
  cycle: string[] | null;
  /** Contract/runtime limits that make this a known partial view, not corruption. */
  limitations: string[];
}

export class FlowSnapshotError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FlowSnapshotError';
  }
}

function validIdList(value: unknown, field: string, id: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || opaqueHttpIdError(entry) !== null)
  ) {
    throw new FlowSnapshotError(`Job ${id} returned an invalid ${field} list`);
  }
  return value;
}

/** Treat a 2xx response with the wrong shape as corruption, not an unknown job. */
function validateJobSnapshot(response: unknown, requestedId: string): JobFull {
  if (response == null || typeof response !== 'object' || Array.isArray(response)) {
    throw new FlowSnapshotError(`GET /jobs/${requestedId} returned an invalid response`);
  }
  const envelope = response as { ok?: unknown; job?: unknown };
  if (envelope.ok !== true) {
    throw new FlowSnapshotError(`GET /jobs/${requestedId} returned an invalid success envelope`);
  }
  const job = envelope.job;
  if (job == null || typeof job !== 'object' || Array.isArray(job)) {
    throw new FlowSnapshotError(`GET /jobs/${requestedId} returned no job snapshot`);
  }
  const raw = job as Record<string, unknown>;
  if (raw.id !== requestedId) {
    throw new FlowSnapshotError(
      `GET /jobs/${requestedId} returned the wrong job id (${String(raw.id)})`
    );
  }
  if (typeof raw.queue !== 'string' || raw.queue.length === 0) {
    throw new FlowSnapshotError(`Job ${requestedId} returned an invalid queue`);
  }
  if (typeof raw.state !== 'string' || raw.state.length === 0) {
    throw new FlowSnapshotError(`Job ${requestedId} returned an invalid state`);
  }
  if (
    !Object.hasOwn(raw, 'parentId') ||
    (raw.parentId !== null &&
      (typeof raw.parentId !== 'string' || opaqueHttpIdError(raw.parentId) !== null))
  ) {
    throw new FlowSnapshotError(`Job ${requestedId} returned an invalid parentId`);
  }
  return {
    ...(job as JobFull),
    parentId: raw.parentId as string | null,
    childrenIds: validIdList(raw.childrenIds, 'childrenIds', requestedId),
    dependsOn: validIdList(raw.dependsOn, 'dependsOn', requestedId),
  };
}

async function fetchFlowJob(
  target: ServerRequestTarget,
  id: string,
  signal?: AbortSignal
): Promise<JobFull> {
  signal?.throwIfAborted();
  const response = await getJobAtTarget(target, id, signal);
  // `getJobAtTarget` has the same guard, but keep the traversal invariant local:
  // a mock/alternate transport that ignores abort can never advance the walk.
  signal?.throwIfAborted();
  return validateJobSnapshot(response as unknown, id);
}

export interface FlowTraversalOptions {
  /** One opaque base URL + bearer snapshot, reusable across root climb and BFS. */
  target?: ServerRequestTarget;
  /** Route/connection lifecycle cancellation; the transport adds its deadline. */
  signal?: AbortSignal;
  /**
   * Validated seed-to-root snapshots returned by `resolveFlowRoot`. Supplying
   * them keeps the originally requested job in the graph even when corrupt
   * parent metadata omits the matching child backlink.
   */
  seedPath?: readonly JobFull[];
  /** Known partial-snapshot boundaries discovered while resolving the root. */
  limitations?: readonly string[];
}

export interface FlowRootResolution {
  id: string;
  job: JobFull;
  hops: number;
  /** Complete validated path in seed-to-root order (both endpoints included). */
  path: JobFull[];
  /** A legitimate removed ancestor that v2.8.55 can no longer return over HTTP. */
  missingParent?: string;
}

export function flowJobIdError(id: string): string | null {
  const error = opaqueHttpIdError(id);
  return error ? `Job ID: ${error}` : null;
}

/** Climb the complete v2.8.55 parent chain; never claim a partial subtree is the root. */
export async function resolveFlowRoot(
  id: string,
  options: FlowTraversalOptions = {}
): Promise<FlowRootResolution> {
  const idError = flowJobIdError(id);
  if (idError) throw new FlowSnapshotError(idError);
  // Capture exactly once. Reading the Zustand store per hop could combine the
  // parent chain of tenant A with the credentials/server of tenant B.
  const target = options.target ?? captureServerRequestTarget();
  const { signal } = options;
  let current = id;
  const seen = new Set<string>([id]);
  const path: JobFull[] = [];
  for (let hops = 0; ; hops++) {
    signal?.throwIfAborted();
    let job: JobFull;
    try {
      job = await fetchFlowJob(target, current, signal);
    } catch (error) {
      // Cancellation retains its native reason; it is not a corrupt/missing
      // parent and callers must be able to distinguish lifecycle aborts.
      signal?.throwIfAborted();
      if (hops === 0) throw error;
      if (error instanceof BqError && error.status === 404) {
        const visibleRoot = path.at(-1);
        if (!visibleRoot) throw error;
        return {
          id: visibleRoot.id,
          job: visibleRoot,
          hops: Math.max(0, path.length - 1),
          path,
          missingParent: current,
        };
      }
      throw new FlowSnapshotError(
        `Could not resolve the flow root because parent ${current} could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    path.push(job);
    const parent = job.parentId;
    if (!parent) return { id: current, job, hops, path };
    if (seen.has(parent)) {
      throw new FlowSnapshotError(`Flow parent cycle detected at job ${parent}`);
    }
    if (hops >= MAX_PARENT_HOPS) {
      throw new FlowSnapshotError(
        `Flow parent chain exceeds the v2.8.55 limit of ${MAX_PARENT_HOPS} levels`
      );
    }
    seen.add(parent);
    current = parent;
  }
}

/** Return one directed cycle without letting corrupt topology hang the viewer. */
export function findDirectedCycle(ids: string[], edges: FlowEdge[]): string[] | null {
  const known = new Set(ids);
  const out = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (known.has(edge.from) && known.has(edge.to)) out.get(edge.from)?.push(edge.to);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const next of out.get(id) ?? []) {
      if (state.get(next) === 1) {
        const start = stack.lastIndexOf(next);
        return [...stack.slice(Math.max(0, start)), next];
      }
      if (state.get(next) !== 2) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of ids) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

type PossibleFailureRelease =
  | { scope: 'child'; policy: 'removeDependencyOnFailure' | 'ignoreDependencyOnFailure' }
  | { scope: 'parent'; policy: 'continueParentOnFailure' }
  | null;

const FAILURE_POLICIES = [
  'failParentOnFailure',
  'removeDependencyOnFailure',
  'continueParentOnFailure',
  'ignoreDependencyOnFailure',
] as const;

function enabledFailurePolicies(job: JobFull): (typeof FAILURE_POLICIES)[number][] {
  return FAILURE_POLICIES.filter((policy) => job[policy] === true);
}

/**
 * The v2.8.55 HTTP snapshot exposes a configured failure policy, but not the
 * canonical failure maps needed to prove whether it has fired. State/timeline
 * are deliberately ignored: retries retain policy flags and may retain, cap or
 * replace failure history. The structural backlink is the only safe ownership
 * prerequisite for treating a missing dependency as ambiguous.
 */
function possibleFailureRelease(
  job: JobFull | undefined,
  parentId: string
): PossibleFailureRelease {
  if (job?.parentId !== parentId) return null;
  const policies = enabledFailurePolicies(job);
  if (policies.length !== 1) return null;
  if (policies[0] === 'continueParentOnFailure') {
    return { scope: 'parent', policy: 'continueParentOnFailure' };
  }
  if (policies[0] === 'removeDependencyOnFailure') {
    return { scope: 'child', policy: 'removeDependencyOnFailure' };
  }
  if (policies[0] === 'ignoreDependencyOnFailure') {
    return { scope: 'child', policy: 'ignoreDependencyOnFailure' };
  }
  return null;
}

/**
 * BFS over structural children plus non-structural dependencies. v2.8.55
 * creates every structural child in BOTH `childrenIds` and `dependsOn`; that
 * pair is rendered once as a child edge, otherwise every new flow becomes an
 * artificial two-edge cycle. Runtime failure resolution can later make those
 * lists intentionally asymmetric, which is validated after the walk.
 */
export async function walkFlow(
  rootId: string,
  initialRoot?: JobFull,
  options: FlowTraversalOptions = {}
): Promise<Graph> {
  const idError = flowJobIdError(rootId);
  if (idError) throw new FlowSnapshotError(idError);
  // This default also snapshots once for standalone callers. The Flows page
  // passes one explicit target to both resolveFlowRoot and walkFlow.
  const target = options.target ?? captureServerRequestTarget();
  const { signal } = options;
  const jobs = new Map<string, JobFull>();
  const edges: FlowEdge[] = [];
  const dependencyEdges: FlowEdge[] = [];
  const seenEdge = new Set<string>();
  const seenDependencyEdge = new Set<string>();
  const failures = new Map<string, string>();
  const issueSet = new Set<string>();
  const policyNoteSet = new Set<string>();
  const limitationSet = new Set(options.limitations ?? []);
  const queue: { id: string; depth: number }[] = [{ id: rootId, depth: 0 }];
  const scheduled = new Set<string>([rootId]);
  const initialSnapshots = new Map<string, JobFull>();
  if (initialRoot) {
    initialSnapshots.set(rootId, validateJobSnapshot({ ok: true, job: initialRoot }, rootId));
  }
  const rootToSeed = [...(options.seedPath ?? [])].reverse();
  let seedPathTruncated = false;
  if (rootToSeed.length > 0 && rootToSeed[0]?.id !== rootId) {
    throw new FlowSnapshotError('Resolved seed path does not start at the requested flow root');
  }
  for (const [depth, snapshot] of rootToSeed.entries()) {
    const validated = validateJobSnapshot({ ok: true, job: snapshot }, snapshot.id);
    initialSnapshots.set(validated.id, validated);
    if (depth === 0) continue;
    if (depth > MAX_DEPTH || scheduled.size >= MAX_NODES) {
      seedPathTruncated = true;
      continue;
    }
    if (!scheduled.has(validated.id)) {
      scheduled.add(validated.id);
      queue.push({ id: validated.id, depth });
    }
  }
  const expanded = new Set<string>();
  let truncated = seedPathTruncated;

  while (queue.length) {
    signal?.throwIfAborted();
    const { id, depth } = queue.shift() as { id: string; depth: number };
    if (expanded.has(id)) continue;
    expanded.add(id);

    let job: JobFull | null = null;
    try {
      job = initialSnapshots.get(id) ?? (await fetchFlowJob(target, id, signal));
    } catch (error) {
      // Never downgrade cancellation to an unavailable-node placeholder. This
      // matters when the aborted request was the final queued node.
      signal?.throwIfAborted();
      // The root is the only required snapshot. Referenced failures become
      // explicit placeholders so the operator can see exactly which edge dangles.
      if (id === rootId) throw error;
      failures.set(id, error instanceof Error ? error.message : String(error));
    }
    jobs.set(id, job ?? ({ id, state: 'unknown' } as JobFull));
    if (!job) continue;
    if (depth >= MAX_DEPTH) {
      // This node has neighbours we won't walk — the graph is incomplete.
      if ((job.childrenIds?.length ?? 0) + (job.dependsOn?.length ?? 0) > 0) truncated = true;
      continue;
    }

    const discover = (next: string): boolean => {
      if (scheduled.has(next)) return true;
      if (scheduled.size >= MAX_NODES) {
        truncated = true;
        return false;
      }
      scheduled.add(next);
      queue.push({ id: next, depth: depth + 1 });
      return true;
    };
    const addEdge = (from: string, to: string, kind: FlowEdge['kind'], next: string) => {
      if (!discover(next)) return;
      const k = `${from}->${to}:${kind}`;
      if (!seenEdge.has(k)) {
        seenEdge.add(k);
        edges.push({ from, to, kind });
      }
    };
    const children = job.childrenIds ?? [];
    const dependencies = job.dependsOn ?? [];
    const childSet = new Set(children);
    const dependencySet = new Set(dependencies);
    if (childSet.size !== children.length) issueSet.add(`Job ${id} lists a child more than once`);
    if (dependencySet.size !== dependencies.length) {
      issueSet.add(`Job ${id} lists a dependency more than once`);
    }
    for (const child of children) {
      addEdge(id, child, 'child', child);
    }
    for (const dependency of dependencies) {
      if (discover(dependency)) {
        const key = `${dependency}->${id}`;
        if (!seenDependencyEdge.has(key)) {
          seenDependencyEdge.add(key);
          dependencyEdges.push({ from: dependency, to: id, kind: 'depends' });
        }
        if (!childSet.has(dependency)) addEdge(dependency, id, 'depends', dependency);
      }
    }
  }

  // Validate both halves of every structural link after all reachable snapshots
  // are available. Failure policies live on children, so an early symmetry check
  // cannot distinguish corruption from Bunqueue's valid runtime mutations.
  for (const [id, job] of jobs) {
    if (!failures.has(id) && enabledFailurePolicies(job).length > 1) {
      issueSet.add(`Job ${id} enables mutually exclusive failure policies`);
    }
  }
  for (const edge of edges) {
    if (edge.kind !== 'child' || failures.has(edge.to)) continue;
    const child = jobs.get(edge.to);
    if (child && child.parentId !== edge.from) {
      issueSet.add(
        `Child ${edge.to} points to parent ${String(child.parentId ?? 'none')}, not ${edge.from}`
      );
    }
  }
  for (const [parentId, parent] of jobs) {
    if (failures.has(parentId)) continue;
    const children = parent.childrenIds ?? [];
    // A removeOnFail child can disappear after its policy has already resolved
    // the parent. Without that snapshot we also cannot rule out a `continue`
    // child that released every sibling, so the existing failed/truncated graph
    // signal is more truthful than speculative topology warnings.
    if (children.some((childId) => !jobs.has(childId) || failures.has(childId))) continue;
    const parentRelease = children
      .map((childId) => ({ childId, release: possibleFailureRelease(jobs.get(childId), parentId) }))
      .find(({ release }) => release?.scope === 'parent');
    for (const childId of children) {
      if (parent.dependsOn?.includes(childId)) continue;
      if (parentRelease?.release?.scope === 'parent') {
        policyNoteSet.add(
          `Parent ${parentId} is missing dependency ${childId}; ${parentRelease.release.policy} on child ${parentRelease.childId} may have released all parent dependencies, but the HTTP snapshot cannot prove whether the policy fired`
        );
        continue;
      }
      const childRelease = possibleFailureRelease(jobs.get(childId), parentId);
      if (childRelease?.scope === 'child') {
        policyNoteSet.add(
          `Parent ${parentId} is missing dependency ${childId}; ${childRelease.policy} may have released it, but the HTTP snapshot cannot prove whether the policy fired`
        );
        continue;
      }
      issueSet.add(`Parent ${parentId} lists child ${childId} without the matching dependency`);
    }
  }
  for (const [id, job] of jobs) {
    if (failures.has(id) || !job.parentId) continue;
    const parent = jobs.get(job.parentId);
    if (!parent || failures.has(job.parentId)) continue;
    if (!parent.childrenIds?.includes(id)) {
      issueSet.add(`Parent ${job.parentId} does not list child ${id}`);
    }
  }
  const cycle = findDirectedCycle([...jobs.keys()], dependencyEdges);
  return {
    jobs,
    edges,
    truncated,
    failed: failures.size,
    failures,
    issues: [...issueSet],
    policyNotes: [...policyNoteSet],
    cycle,
    limitations: [...limitationSet],
  };
}

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

function pathBetween(from: { x: number; y: number }, to: { x: number; y: number }): string {
  // Reverse dependencies must attach to the near sides of their nodes. Always
  // using from.right → to.left made right-to-left edges cross both node bodies.
  return from.x <= to.x
    ? edgePath(from.x + NODE_W, from.y + NODE_H / 2, to.x, to.y + NODE_H / 2)
    : edgePath(from.x, from.y + NODE_H / 2, to.x + NODE_W, to.y + NODE_H / 2);
}

function isConnectionFailure(error: Error): boolean {
  return (
    (error instanceof BqError && error.status === 0) ||
    error.name === 'TypeError' ||
    error.name === 'AbortError' ||
    error.name === 'TimeoutError'
  );
}

/** In-memory only; used to reject late work after a connection retarget. */
function currentFlowConnectionIdentity(): string {
  const { token } = useConnectionStore.getState();
  return JSON.stringify([getBaseUrl(), token]);
}

export function Flows() {
  const [params, setParams] = useSearchParams();
  const rootParam = params.get('root') ?? (isDemo() ? DEMO_ROOT : '');
  const baseUrl = useConnectionStore((state) => state.baseUrl);
  const token = useConnectionStore((state) => state.token);
  const targetBaseUrl = getBaseUrl();
  // Never persist or fingerprint bearer credentials. Authenticated targets keep
  // recent roots only in component memory and discard them on credential change.
  const persistRecent = token.length === 0;
  const [input, setInput] = useState(rootParam);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [recent, setRecent] = useState<RecentFlow[]>(() =>
    readRecentFlows(targetBaseUrl, persistRecent)
  );
  const reqId = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const connectionIdentity = useRef(currentFlowConnectionIdentity());

  const load = useCallback(
    async (seed: string) => {
      // An event handler from the just-replaced render must not cancel the new
      // connection's work before React commits its replacement handler.
      const liveConnection = useConnectionStore.getState();
      if (liveConnection.baseUrl !== baseUrl || liveConnection.token !== token) return;
      // Starting any load cancels the full parent-climb + BFS lifecycle before
      // clearing its UI. This also covers Refresh and same-root form submits.
      activeRequest.current?.abort();
      activeRequest.current = null;
      const mine = ++reqId.current;
      const id = seed.trim();
      setGraph(null);
      setSelected(null);
      setError(null);
      if (!id) {
        setLoading(false);
        return;
      }
      const idError = flowJobIdError(id);
      if (idError) {
        setError(new FlowSnapshotError(idError));
        setLoading(false);
        return;
      }

      const target = captureServerRequestTarget();
      const expectedConnection = currentFlowConnectionIdentity();
      const canPersistRecent = useConnectionStore.getState().token.length === 0;
      const controller = new AbortController();
      activeRequest.current = controller;
      const isCurrentTarget = () =>
        mounted.current &&
        mine === reqId.current &&
        !controller.signal.aborted &&
        expectedConnection === currentFlowConnectionIdentity();

      setLoading(true);
      try {
        const options: FlowTraversalOptions = { target, signal: controller.signal };
        const root = await resolveFlowRoot(id, options);
        const limitations = root.missingParent
          ? [
              `Ancestor ${root.missingParent} is no longer available. Bunqueue may legitimately remove a completed flow root, so this graph starts at the oldest surviving node.`,
            ]
          : [];
        const nextGraph = await walkFlow(root.id, root.job, {
          ...options,
          seedPath: root.path,
          limitations,
        });
        if (!isCurrentTarget()) return;
        setGraph(nextGraph);
        setSelected(root.id);
        // Remember real flows (2+ nodes) so the empty state can offer them later.
        if (nextGraph.jobs.size > 1) {
          setRecent((list) =>
            pushRecentFlow(
              target.baseUrl,
              list,
              {
                root: root.id,
                nodes: nextGraph.jobs.size,
                at: Date.now(),
              },
              canPersistRecent
            )
          );
        }
      } catch (caught) {
        // Abort and obsolete-target failures are lifecycle events, not errors to
        // flash under the replacement graph.
        if (!isCurrentTarget()) return;
        setError(caught instanceof Error ? caught : new Error('Failed to load flow'));
      } finally {
        if (activeRequest.current === controller) activeRequest.current = null;
        if (isCurrentTarget()) setLoading(false);
      }
    },
    [baseUrl, token]
  );

  // Zustand subscriptions run synchronously with setState, so the old target is
  // aborted before React renders the replacement connection. Generation checks
  // still protect against fetch mocks/transports that ignore AbortSignal.
  useEffect(() => {
    mounted.current = true;
    connectionIdentity.current = currentFlowConnectionIdentity();
    const unsubscribe = useConnectionStore.subscribe(() => {
      const nextIdentity = currentFlowConnectionIdentity();
      if (nextIdentity === connectionIdentity.current) return;
      connectionIdentity.current = nextIdentity;
      reqId.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = null;
      if (!mounted.current) return;
      setGraph(null);
      setSelected(null);
      setError(null);
      setLoading(false);
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      reqId.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, []);

  // Recent ids from another bunqueue target/credential must never leak into this
  // view. `token` is only an in-memory invalidation dependency, never a key.
  useEffect(() => {
    setRecent(token ? [] : readRecentFlows(targetBaseUrl, true));
  }, [targetBaseUrl, token]);

  // URL is the source of truth: back/forward updates both the field and graph.
  useEffect(() => {
    setInput(rootParam);
    void load(rootParam);
  }, [rootParam, load]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = input.trim();
    if (!id) return;
    if (id === rootParam) void load(id);
    else setParams({ root: id }, { replace: true });
  };

  const layout = useMemo(
    () => (graph ? layoutDag([...graph.jobs.keys()], graph.edges, LAYOUT) : null),
    [graph]
  );
  const pos = useMemo(() => new Map(layout?.nodes.map((node) => [node.id, node]) ?? []), [layout]);
  const selectedJob = selected ? graph?.jobs.get(selected) : undefined;
  const selectedFailure = selected ? graph?.failures.get(selected) : undefined;

  return (
    <div>
      <PageHeader
        title="Flows"
        description="Visualize a job flow: parent, children, and dependency edges as an interactive graph."
        actions={
          graph && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void load(rootParam)}
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50"
            >
              Refresh
            </button>
          )
        }
      />

      <Card className="mb-6">
        <form onSubmit={submit} className="flex flex-wrap items-center gap-3">
          <input
            name="flow-job-id"
            autoComplete="off"
            spellCheck={false}
            maxLength={1024}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Flow job ID"
            aria-label="Root job ID"
            aria-describedby="flow-input-help"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/50"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Load Flow'}
          </button>
        </form>
        <p id="flow-input-help" className="mt-2 text-xs text-faint">
          Structural parent/child flows can start from any surviving node. Dependency-only chains
          can only be followed upstream with the v2.8.55 HTTP API, so use the most downstream job to
          see the full chain. Up to {MAX_NODES} nodes are rendered.
        </p>
      </Card>

      <div aria-live="polite">
        {error &&
          (isConnectionFailure(error) ? (
            <OfflineBanner
              message={`Could not load the flow — ${error.message}`}
              onRetry={() => void load(rootParam)}
            />
          ) : (
            <ErrorState error={error} onRetry={() => void load(rootParam)} />
          ))}
        {loading && <LoadingState label="Loading flow…" />}
      </div>

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
                      title={r.root}
                      onClick={() => {
                        setInput(r.root);
                        setParams({ root: r.root }, { replace: true });
                      }}
                      className="min-h-10 rounded-lg border border-line bg-surface-2 px-3 py-1.5 font-mono text-xs text-muted transition-colors hover:border-line-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                    >
                      <span translate="no">{shortId(r.root)}</span>
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
                {graph.edges.map((e) => {
                  const a = pos.get(e.from);
                  const b = pos.get(e.to);
                  if (!a || !b) return null;
                  return (
                    <path
                      key={`${e.from}-${e.to}-${e.kind}`}
                      d={pathBetween(a, b)}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeDasharray={e.kind === 'depends' ? '4 4' : undefined}
                      markerEnd={`url(#flow-arrow-${e.kind === 'depends' ? 'dependency' : 'child'})`}
                      opacity={0.5}
                    />
                  );
                })}
              </svg>
              {layout.nodes.map((n) => {
                const job = graph.jobs.get(n.id);
                const unavailable = graph.failures.has(n.id);
                const state = unavailable ? 'unavailable' : (job?.state ?? 'unknown');
                return (
                  <button
                    type="button"
                    key={n.id}
                    data-flow-node={n.id}
                    onClick={() => setSelected(n.id)}
                    aria-pressed={selected === n.id}
                    aria-label={`${n.id}, queue ${job?.queue ?? 'unknown'}, state ${state}`}
                    title={n.id}
                    style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
                    className={cn(
                      'absolute flex flex-col justify-center gap-0.5 rounded-lg border px-3 text-left transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70',
                      flowStateStyle(job?.state),
                      selected === n.id && 'ring-2 ring-accent'
                    )}
                  >
                    <span translate="no" className="truncate font-mono text-xs text-fg">
                      {shortId(n.id)}
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

          <aside aria-label="Selected job details" aria-live="polite">
            <Card>
              {selectedJob ? (
                <div className="space-y-3 text-sm">
                  <div>
                    <div className="text-xs text-faint">Job</div>
                    <div translate="no" className="break-all font-mono text-xs text-fg">
                      {selectedJob.id}
                    </div>
                  </div>
                  {selectedFailure && (
                    <p role="alert" className="break-words text-xs text-warning">
                      Snapshot unavailable: {selectedFailure}
                    </p>
                  )}
                  <Field label="Queue" value={selectedJob.queue ?? '—'} />
                  <Field
                    label="State"
                    value={selectedFailure ? 'unavailable' : (selectedJob.state ?? 'unknown')}
                  />
                  <Field
                    label="Priority"
                    value={selectedJob.priority === undefined ? '—' : String(selectedJob.priority)}
                  />
                  <Field label="Parent" value={selectedJob.parentId ?? '—'} />
                  <Field
                    label="Children"
                    value={selectedFailure ? '—' : String(selectedJob.childrenIds?.length ?? 0)}
                  />
                  <Field
                    label="Depends On"
                    value={selectedFailure ? '—' : String(selectedJob.dependsOn?.length ?? 0)}
                  />
                  <Link
                    to={`/job?id=${encodeURIComponent(selectedJob.id)}`}
                    className="inline-block rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                  >
                    Open in Job Inspector
                  </Link>
                </div>
              ) : (
                <p className="text-sm text-muted">Select a node to inspect it.</p>
              )}
              <div className="mt-4 border-t border-line pt-3 text-xs text-faint" aria-live="polite">
                {graph.truncated && (
                  <div className="mb-1 text-warning">
                    Graph truncated at {MAX_NODES} nodes / depth {MAX_DEPTH} — not the whole flow.
                  </div>
                )}
                {graph.limitations.length > 0 && (
                  <details className="mb-1 text-warning">
                    <summary className="cursor-pointer">
                      {graph.limitations.length} known snapshot limitation
                      {graph.limitations.length === 1 ? '' : 's'}
                    </summary>
                    <ul className="mt-1 space-y-1 pl-3">
                      {graph.limitations.map((limitation) => (
                        <li key={limitation} className="break-words">
                          {limitation}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {graph.failed > 0 && (
                  <details className="mb-1 text-warning">
                    <summary className="cursor-pointer">
                      {graph.failed} node{graph.failed === 1 ? '' : 's'} couldn't be loaded — this
                      is not the whole flow
                    </summary>
                    <ul className="mt-1 space-y-1 pl-3">
                      {[...graph.failures].map(([id, reason]) => (
                        <li key={id} className="break-words">
                          <span translate="no" className="font-mono">
                            {id}
                          </span>
                          : {reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {graph.cycle && (
                  <div className="mb-1 break-words text-danger">
                    Dependency cycle detected:{' '}
                    <span translate="no" className="font-mono">
                      {graph.cycle.join(' → ')}
                    </span>
                    . This is not a valid atomic v2.8.55 flow.
                  </div>
                )}
                {graph.issues.length > 0 && (
                  <details className="mb-1 text-warning">
                    <summary className="cursor-pointer">
                      {graph.issues.length}{' '}
                      {graph.issues.length === 1
                        ? 'possible snapshot inconsistency'
                        : 'possible snapshot inconsistencies'}{' '}
                      detected (the flow may have changed during these requests)
                    </summary>
                    <ul className="mt-1 space-y-1 pl-3">
                      {graph.issues.map((issue) => (
                        <li key={issue} className="break-words">
                          {issue}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {graph.policyNotes.length > 0 && (
                  <details className="mb-1 text-muted">
                    <summary className="cursor-pointer">
                      {graph.policyNotes.length} failure-policy{' '}
                      {graph.policyNotes.length === 1 ? 'ambiguity' : 'ambiguities'}
                    </summary>
                    <p className="mt-1">
                      These are informational: the HTTP snapshot cannot prove whether a configured
                      policy fired.
                    </p>
                    <ul className="mt-1 space-y-1 pl-3">
                      {graph.policyNotes.map((note) => (
                        <li key={note} className="break-words">
                          {note}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <div className="mb-1">
                  {graph.jobs.size} node{graph.jobs.size === 1 ? '' : 's'} · {graph.edges.length}{' '}
                  edge
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
          </aside>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-2">
      <span className="shrink-0 text-xs text-faint">{label}</span>
      <span className="min-w-0 break-all text-right text-fg">{value}</span>
    </div>
  );
}
