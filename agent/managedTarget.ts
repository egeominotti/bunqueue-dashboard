import type { ServerConfig } from './manager';

/** Refuse agent-side SDK operations for a server the agent does not manage. */
export function assertManagedTarget(
  query: URLSearchParams,
  config: ServerConfig,
  proxyTarget = process.env.BUNQUEUE_URL?.trim() || 'http://localhost:6790'
): void {
  const target = query.get('target');
  if (!target) throw new Error('Managed Bunqueue target is required');
  if (target === '/api') {
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
