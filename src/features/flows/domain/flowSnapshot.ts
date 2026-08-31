import {
  BqError,
  captureServerRequestTarget,
  getJobAtTarget,
  type ServerRequestTarget,
} from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import type { FlowEdge } from '@/lib/flowLayout';
import { opaqueHttpIdError } from '@/lib/upstreamPaths';
import { MAX_PARENT_HOPS } from './flowConstants';

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
export function validateJobSnapshot(response: unknown, requestedId: string): JobFull {
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

export async function fetchFlowJob(
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
  /** A legitimate removed ancestor that v2.9.2 can no longer return over HTTP. */
  missingParent?: string;
}

export function flowJobIdError(id: string): string | null {
  const error = opaqueHttpIdError(id);
  return error ? `Job ID: ${error}` : null;
}

/** Climb the complete v2.9.2 parent chain; never claim a partial subtree is the root. */
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
        `Flow parent chain exceeds the Bunqueue 2.9.2 limit of ${MAX_PARENT_HOPS} levels`
      );
    }
    seen.add(parent);
    current = parent;
  }
}
