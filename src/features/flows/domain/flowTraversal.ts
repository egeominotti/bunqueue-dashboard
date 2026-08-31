import { captureServerRequestTarget } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import type { FlowEdge } from '@/lib/flowLayout';
import { MAX_FLOW_DEPTH, MAX_FLOW_NODES } from './flowConstants';
import {
  FlowSnapshotError,
  type FlowTraversalOptions,
  fetchFlowJob,
  flowJobIdError,
  type Graph,
  validateJobSnapshot,
} from './flowSnapshot';

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
 * The v2.9.0 HTTP snapshot exposes a configured failure policy, but not the
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
 * BFS over structural children plus non-structural dependencies. v2.9.0
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
    if (depth > MAX_FLOW_DEPTH || scheduled.size >= MAX_FLOW_NODES) {
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
    if (depth >= MAX_FLOW_DEPTH) {
      // This node has neighbours we won't walk — the graph is incomplete.
      if ((job.childrenIds?.length ?? 0) + (job.dependsOn?.length ?? 0) > 0) truncated = true;
      continue;
    }

    const discover = (next: string): boolean => {
      if (scheduled.has(next)) return true;
      if (scheduled.size >= MAX_FLOW_NODES) {
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
