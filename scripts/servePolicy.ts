import { timingSafeEqual } from 'node:crypto';
import { hostnameOf, resolveAllowedHosts } from '../agent/server';

export const RESPONSE_SECURITY_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(RESPONSE_SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** True loopback names/addresses. 0.0.0.0 is a wildcard, never local-only. */
export function isLoopbackHost(host: string): boolean {
  const value = hostnameOf(host);
  const octets = value.split('.');
  const ipv4Loopback =
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
  return (
    value === 'localhost' ||
    value === '::1' ||
    value === '0:0:0:0:0:0:0:1' ||
    ipv4Loopback
  );
}

export function isLoopbackBind(host: string): boolean {
  return isLoopbackHost(host);
}

function configuredValues(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function remoteBridgeRequiresToken(
  loopbackBind: boolean,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!loopbackBind || env.TRUST_PROXY === '1') return true;
  const configured = [
    ...configuredValues(env.AGENT_ALLOWED_HOSTS),
    ...configuredValues(env.AGENT_ALLOWED_ORIGINS),
  ];
  return configured.some((value) => !isLoopbackHost(value));
}

const PROXY_HINT_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
] as const;

export function isRemoteBridgeRequest(req: Request, remotePolicy = false): boolean {
  if (remotePolicy || PROXY_HINT_HEADERS.some((name) => req.headers.has(name))) return true;
  const origin = req.headers.get('origin');
  if (origin && !isLoopbackHost(origin)) return true;
  const host = req.headers.get('host') ?? new URL(req.url).hostname;
  return !isLoopbackHost(host);
}

export function apiTokenOk(req: Request, token: string | undefined): boolean {
  if (!token) return false;
  const authorization = req.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorization.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function resolveServeAllowedHosts(
  bindHost: string,
  allowedOrigins: string[],
  env: Record<string, string | undefined> = process.env
): string[] {
  const originHosts = allowedOrigins
    .map((origin) => {
      try {
        return new URL(origin).hostname;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  const concreteBindHosts = bindHost === '0.0.0.0' || bindHost === '::' ? [] : [bindHost];
  return resolveAllowedHosts(env, [...originHosts, ...concreteBindHosts]);
}

export function remoteControlEnabled(
  remotePolicy: boolean,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!remotePolicy) return true;
  return Boolean(env.AGENT_TOKEN?.trim());
}

export function agentSubUrl(pathname: string, search: string): URL {
  const rest = pathname.slice('/agent'.length) || '/';
  const sub = new URL('http://agent.internal');
  sub.pathname = rest.startsWith('/') ? rest : `/${rest}`;
  sub.search = search;
  return sub;
}

export interface ServeHandlerOptions {
  api: string;
  indexHtml: string;
  assets: Record<string, string>;
  agentHandle: (req: Request) => Response | Promise<Response>;
  remoteAgentHandle: (req: Request) => Response | Promise<Response>;
  allowedOrigins: string[];
  allowedHosts?: string[];
  agentBridge: boolean;
  agentTokenConfigured: boolean;
  apiToken?: string;
  /** Aborts upstream API streams during terminal listener drain. */
  apiShutdownSignal?: AbortSignal;
  remoteBridgePolicy?: boolean;
  trustProxy?: boolean;
}
