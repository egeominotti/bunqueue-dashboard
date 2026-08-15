import type { ServerConfig } from './manager';

const MANAGED_PROXY_PATH_PATTERN = /^\/(?:[A-Za-z0-9._~-]+\/)*api$/;

export interface ManagedTargetPolicy {
  /** Exact browser-visible proxy alias accepted in addition to legacy `/api`. */
  proxyPath: string;
  /** Local upstream represented by the alias; it still passes the anti-SSRF gate. */
  proxyUrl?: string;
}

/** Validate the one browser-visible proxy path that aliases the local managed server. */
export function resolveManagedProxyPath(value: string | undefined): string {
  const path = value?.trim() || '/api';
  if (
    !MANAGED_PROXY_PATH_PATTERN.test(path) ||
    path.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('Managed proxy path must be /api or a safe root-relative path ending in /api');
  }
  return path;
}

/** Resolve the alias once without cloning a request or touching its body stream. */
export function resolveManagedTargetPolicy(
  proxyPath: string | undefined,
  proxyUrl?: string
): ManagedTargetPolicy {
  return {
    proxyPath: resolveManagedProxyPath(proxyPath),
    proxyUrl: proxyUrl?.trim() || undefined,
  };
}

/** Refuse agent-side SDK operations for a server the agent does not manage. */
export function assertManagedTarget(
  query: URLSearchParams,
  config: ServerConfig,
  policy: ManagedTargetPolicy | string =
    process.env.BUNQUEUE_URL?.trim() || 'http://localhost:6790'
): void {
  const target = query.get('target');
  if (!target) throw new Error('Managed Bunqueue target is required');
  const proxyPath =
    typeof policy === 'string' ? '/api' : resolveManagedProxyPath(policy.proxyPath);
  const proxyTarget =
    (typeof policy === 'string' ? policy : policy.proxyUrl?.trim()) ||
    process.env.BUNQUEUE_URL?.trim() ||
    'http://localhost:6790';
  if (target === '/api' || target === proxyPath) {
    assertLocalTarget(proxyTarget, config, 'Dashboard /api proxy');
    return;
  }
  assertLocalTarget(target, config, 'Managed target');
}

/** Resolve the exact AUTH_TOKENS value inherited by the managed child. */
export function managedAuthToken(config: ServerConfig): string | undefined {
  const configured = Object.hasOwn(config.extraEnv, 'AUTH_TOKENS')
    ? config.extraEnv.AUTH_TOKENS
    : process.env.AUTH_TOKENS;
  return configured
    ?.split(',')
    .map((token) => token.trim())
    .find(Boolean);
}

function assertLocalTarget(target: string, config: ServerConfig, label: string): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`${label} must be an absolute local HTTP URL`);
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!local || port !== config.httpPort || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(
      `${label} ${target} does not match the agent-managed Bunqueue server on port ${config.httpPort}`
    );
  }
}
