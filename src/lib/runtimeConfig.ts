const BASE_PATH_PATTERN = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?\/?$/;

type RuntimeConfigKey =
  | '__BUNQUEUE_AGENT_URL__'
  | '__BUNQUEUE_API_URL__'
  | '__BUNQUEUE_BASE_PATH__';

/** Read an injected standalone setting without trusting accessors on globalThis. */
export function runtimeConfigValue(key: RuntimeConfigKey): unknown {
  try {
    return (globalThis as unknown as Record<RuntimeConfigKey, unknown>)[key];
  } catch {
    return undefined;
  }
}

function normalizeRouterBasePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!BASE_PATH_PATTERN.test(candidate)) return null;
  if (candidate.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  const normalized = candidate.replace(/\/+$/, '');
  return normalized || '/';
}

/** Prefer a validated runtime mount, then Vite's build-time base. */
export function resolveRouterBasename(runtimeValue: unknown, buildValue: unknown): string {
  return normalizeRouterBasePath(runtimeValue) ?? normalizeRouterBasePath(buildValue) ?? '/';
}
