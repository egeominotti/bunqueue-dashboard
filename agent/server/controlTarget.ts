import { safeErrorMessage } from '../errorMessage';

export type ServerManagementMode = 'managed' | 'external';

export interface ServerControlTarget {
  mode: ServerManagementMode;
  /** Canonical external HTTP base; present only in attach-only mode. */
  url?: string;
  /** Server bearer used only by the agent-side health probe. */
  token?: string;
}

export interface ExternalHealthProbe {
  reachable: boolean;
  healthy: boolean;
  statusCode: number | null;
  version?: string;
  error?: string;
}

export const MANAGED_CONTROL_TARGET: ServerControlTarget = Object.freeze({ mode: 'managed' });

/** Resolve the immutable lifecycle mode once, before the agent starts listening. */
export function resolveServerControlTarget(
  env: Record<string, string | undefined> = process.env
): ServerControlTarget {
  const configured = env.BUNQUEUE_MANAGED?.trim().toLowerCase();
  if (!configured || ['1', 'true', 'yes', 'on'].includes(configured)) {
    return MANAGED_CONTROL_TARGET;
  }
  if (!['0', 'false', 'no', 'off'].includes(configured)) {
    throw new Error('BUNQUEUE_MANAGED must be 1/0, true/false, yes/no, or on/off');
  }
  return Object.freeze({
    mode: 'external',
    url: normalizeExternalUrl(env.BUNQUEUE_URL),
    token: env.BUNQUEUE_TOKEN?.trim() || undefined,
  });
}

function normalizeExternalUrl(value: string | undefined): string {
  const candidate = value?.trim() || 'http://localhost:6790';
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('BUNQUEUE_URL must be an absolute HTTP(S) URL in external mode');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'BUNQUEUE_URL must be a credential-free HTTP(S) URL without query or fragment in external mode'
    );
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path}`;
}

/** Probe an externally supervised broker without following credential-bearing redirects. */
export async function probeExternalHealth(target: ServerControlTarget): Promise<ExternalHealthProbe> {
  if (target.mode !== 'external' || !target.url) {
    throw new Error('External health probe requires an external server target');
  }
  let response: Response;
  try {
    response = await fetch(`${target.url}/health`, {
      headers: target.token ? { Authorization: `Bearer ${target.token}` } : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
    });
  } catch (error) {
    return {
      reachable: false,
      healthy: false,
      statusCode: null,
      error: safeErrorMessage(error),
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      reachable: true,
      healthy: false,
      statusCode: response.status,
      error: `Health endpoint returned non-JSON HTTP ${response.status}`,
    };
  }
  const health = isRecord(body) ? body : {};
  const healthy = response.ok && health.ok === true;
  const version = typeof health.version === 'string' ? health.version : undefined;
  const reportedStatus = typeof health.status === 'string' ? health.status : undefined;
  return {
    reachable: true,
    healthy,
    statusCode: response.status,
    version,
    error: healthy
      ? undefined
      : reportedStatus
        ? `Health reported ${reportedStatus} (HTTP ${response.status})`
        : `Health endpoint returned HTTP ${response.status}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
