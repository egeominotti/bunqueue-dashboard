import {
  captureConnectionProfileTarget,
  type ConnectionProfileTarget,
} from '@/components/dashboard/stores/connectionStore';
import type { ServerStatus } from '@/lib/bqTypes';

export interface FleetEndpointHealth {
  reachable: boolean;
  healthy: boolean;
  statusCode?: number;
  version?: string;
  error?: string;
}

export interface FleetNodeSnapshot {
  target: ConnectionProfileTarget;
  server: FleetEndpointHealth;
  agent: FleetEndpointHealth & { status?: ServerStatus };
}

type LifecycleAction = 'start' | 'stop' | 'restart';
const REQUEST_TIMEOUT_MS = 7_500;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed ${label} response`);
  }
  return value as Record<string, unknown>;
}

async function responseError(response: Response): Promise<Error> {
  try {
    const body = asRecord(await response.json(), 'error');
    if (typeof body.error === 'string' && body.error) return new Error(body.error);
  } catch {
    // Preserve the HTTP fallback for empty/non-JSON bodies.
  }
  return new Error(`HTTP ${response.status}`);
}

async function requestRecord(
  baseUrl: string,
  path: string,
  token: string,
  signal?: AbortSignal,
  init?: RequestInit,
  acceptedStatuses: readonly number[] = []
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    signal: requestSignal,
  });
  if (!response.ok && !acceptedStatuses.includes(response.status))
    throw await responseError(response);
  return { response, body: asRecord(await response.json(), path) };
}

async function probeServer(
  target: ConnectionProfileTarget,
  signal?: AbortSignal
): Promise<FleetEndpointHealth> {
  try {
    const { response, body } = await requestRecord(
      target.baseUrl,
      '/health',
      target.token,
      signal,
      undefined,
      [503]
    );
    if (typeof body.ok !== 'boolean') throw new Error('Malformed Bunqueue health response');
    return {
      reachable: true,
      healthy: body.ok,
      statusCode: response.status,
      version: typeof body.version === 'string' ? body.version : undefined,
    };
  } catch (error) {
    return { reachable: false, healthy: false, error: (error as Error).message };
  }
}

function validStatus(
  value: Record<string, unknown>
): value is Record<string, unknown> & ServerStatus {
  return (
    ['running', 'stopped', 'starting', 'stopping'].includes(String(value.status)) &&
    value.config !== null &&
    typeof value.config === 'object' &&
    !Array.isArray(value.config)
  );
}

async function probeAgent(
  target: ConnectionProfileTarget,
  signal?: AbortSignal
): Promise<FleetNodeSnapshot['agent']> {
  try {
    const { response, body } = await requestRecord(
      target.agentBaseUrl,
      '/control/status',
      target.agentToken,
      signal
    );
    if (!validStatus(body)) throw new Error('Malformed control agent response');
    return {
      reachable: true,
      healthy: body.healthy === true,
      statusCode: response.status,
      version: typeof body.version === 'string' ? body.version : undefined,
      status: body,
    };
  } catch (error) {
    return { reachable: false, healthy: false, error: (error as Error).message };
  }
}

export async function probeFleetNode(
  profileId: string,
  signal?: AbortSignal
): Promise<FleetNodeSnapshot> {
  const target = captureConnectionProfileTarget(profileId);
  if (!target) throw new Error(`Unknown Bunqueue connection profile: ${profileId}`);
  const [server, agent] = await Promise.all([
    probeServer(target, signal),
    probeAgent(target, signal),
  ]);
  return { target, server, agent };
}

export function probeFleet(
  profileIds: readonly string[],
  signal?: AbortSignal
): Promise<FleetNodeSnapshot[]> {
  return Promise.all(profileIds.map((id) => probeFleetNode(id, signal)));
}

export async function runFleetLifecycle(
  profileId: string,
  action: LifecycleAction,
  signal?: AbortSignal
): Promise<ServerStatus> {
  const target = captureConnectionProfileTarget(profileId);
  if (!target) throw new Error(`Unknown Bunqueue connection profile: ${profileId}`);
  const { body } = await requestRecord(
    target.agentBaseUrl,
    `/control/${action}`,
    target.agentToken,
    signal,
    { method: 'POST' }
  );
  if (!validStatus(body)) throw new Error('Malformed control agent response');
  return body;
}

export function postgresTopologyKey(snapshot: FleetNodeSnapshot): string | null {
  const status = snapshot.agent.status;
  if (status?.storageMode !== 'postgres' || !status.postgresTarget) return null;
  return `${status.postgresTarget}\u0000${status.postgresNamespace ?? 'default'}`;
}
