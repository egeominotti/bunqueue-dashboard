import { timingSafeEqual } from 'node:crypto';
import { hostnameOf, resolveAllowedHosts } from '../agent/server';

const BASE_PATH_PATTERN = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?\/?$/;

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

/** Normalize the runtime mount point to either an empty root prefix or `/a/b`. */
export function resolveBasePath(value: unknown): string {
  if (value === undefined || value === null || value === '' || value === '/') return '';
  if (typeof value !== 'string') throw new Error('BASE_PATH must be a URL path');
  const candidate = value.trim();
  if (!BASE_PATH_PATTERN.test(candidate)) {
    throw new Error(
      'BASE_PATH must start with one slash and contain only URL-safe path segments'
    );
  }
  if (candidate.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('BASE_PATH cannot contain dot path segments');
  }
  return candidate.replace(/\/+$/, '');
}

/** Return the path as seen by the mounted app, or null when it is outside the mount. */
export function stripBasePath(pathname: string, basePath: string): string | null {
  if (!basePath) return pathname;
  if (pathname === basePath) return '/';
  if (!pathname.startsWith(`${basePath}/`)) return null;
  return pathname.slice(basePath.length) || '/';
}

/** Prefix root-relative Vite URLs and inject the standalone runtime endpoints. */
export function prepareRuntimeIndexHtml(indexHtml: string, basePath: string): string {
  const mount = basePath || '/';
  const agentUrl = `${basePath}/agent`;
  const apiUrl = `${basePath}/api`;
  const prefixed = basePath
    ? indexHtml.replace(/\b(href|src)=(['"])\/(?!\/)/g, `$1=$2${basePath}/`)
    : indexHtml;
  const runtimeConfig =
    '<script>' +
    `window.__BUNQUEUE_BASE_PATH__=${JSON.stringify(mount)};` +
    `window.__BUNQUEUE_AGENT_URL__=${JSON.stringify(agentUrl)};` +
    `window.__BUNQUEUE_API_URL__=${JSON.stringify(apiUrl)}` +
    '</script>';
  if (!prefixed.includes('</head>')) {
    throw new Error('Embedded index.html is missing </head>');
  }
  return prefixed.replace('</head>', `${runtimeConfig}</head>`);
}

/** Vite emits root-relative font URLs in CSS when its build base is `/`. */
export function prefixCssAssetUrls(css: string, basePath: string): string {
  if (!basePath) return css;
  return css.replace(/url\((['"]?)\/assets\//g, `url($1${basePath}/assets/`);
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
  /** Normalized mount prefix (`''` for root, otherwise no trailing slash). */
  basePath?: string;
}
