const DEFAULT_ORIGINS = ['http://localhost:5273', 'http://127.0.0.1:5273'];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];

export function resolveAllowedOrigins(env = process.env): string[] {
  const extra = (env.AGENT_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return Array.from(new Set([...DEFAULT_ORIGINS, ...extra]));
}

/** Extract a lowercase bare hostname from a Host header or origin. */
export function hostnameOf(host: string): string {
  const stripped = host.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const ipv6 = stripped.match(/^\[([^\]]+)\]/);
  if (ipv6) return ipv6[1].toLowerCase();
  const firstColon = stripped.indexOf(':');
  if (firstColon === -1) return stripped.toLowerCase();
  if (firstColon !== stripped.lastIndexOf(':')) return stripped.toLowerCase();
  return stripped.slice(0, firstColon).toLowerCase();
}

export function resolveAllowedHosts(env = process.env, extra: string[] = []): string[] {
  const fromEnvironment = (env.AGENT_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => hostnameOf(host.trim()))
    .filter(Boolean);
  const extraHosts = extra.map(hostnameOf).filter(Boolean);
  return Array.from(new Set([...LOOPBACK_HOSTS, ...extraHosts, ...fromEnvironment]));
}

export function isOriginAllowed(origin: string | null, allowed: string[]): boolean {
  if (!origin) return true;
  return allowed.includes(origin.replace(/\/$/, ''));
}

export function isHostAllowed(host: string | null, allowed?: string[]): boolean {
  if (!allowed) return true;
  if (!host) return false;
  return allowed.includes(hostnameOf(host));
}

export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Token',
    Vary: 'Origin',
  };
  if (origin && allowed.includes(origin.replace(/\/$/, ''))) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function tokenOk(request: Request, token?: string): boolean {
  if (!token) return false;
  const authorization = request.headers.get('authorization') ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  return bearer === token || request.headers.get('x-agent-token') === token;
}
