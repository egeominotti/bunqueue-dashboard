export const SAFE_DEFAULT_BASE_URL = '/api';
export const SAFE_AGENT_BASE = 'http://localhost:6800';
export const BASE_URL_ERROR =
  "Use an http(s) URL without credentials, query, or fragment, or a non-root path starting with '/'.";

const RELATIVE_URL_ORIGIN = 'https://bunqueue-dashboard.invalid';
const WHITESPACE = /\s/u;

function hasDisallowedUrlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return character === '\\' || WHITESPACE.test(character) || code < 32 || code === 127;
  });
}

/** Canonicalize the only HTTP targets to which credentials may be attached. */
export function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (
    !candidate ||
    candidate.includes('?') ||
    candidate.includes('#') ||
    hasDisallowedUrlCharacters(candidate)
  ) {
    return null;
  }

  if (candidate.startsWith('/')) {
    if (candidate.startsWith('//')) return null;
    try {
      const parsed = new URL(candidate, RELATIVE_URL_ORIGIN);
      const pathname = parsed.pathname.replace(/\/+$/, '');
      if (
        parsed.origin !== RELATIVE_URL_ORIGIN ||
        !pathname ||
        pathname === '/' ||
        pathname.startsWith('//')
      ) {
        return null;
      }
      return pathname;
    } catch {
      return null;
    }
  }

  const scheme = candidate.match(/^https?:\/\//i)?.[0];
  if (!scheme) return null;
  const authority = candidate.slice(scheme.length).split('/', 1)[0];
  if (!authority || authority.includes('@')) return null;
  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    const pathname = parsed.pathname.replace(/\/+$/, '');
    if (pathname.startsWith('//')) return null;
    return `${parsed.origin}${pathname}`;
  } catch {
    return null;
  }
}

export function isValidBaseUrl(value: unknown): boolean {
  return normalizeBaseUrl(value) !== null;
}

export function resolveDefaultBaseUrl(value: unknown, runtimeValue?: unknown): string {
  return normalizeBaseUrl(value) ?? normalizeBaseUrl(runtimeValue) ?? SAFE_DEFAULT_BASE_URL;
}

export function resolveAgentBase(runtimeValue: unknown, envValue: unknown): string {
  return normalizeBaseUrl(runtimeValue) ?? normalizeBaseUrl(envValue) ?? SAFE_AGENT_BASE;
}

export function safeTarget(value: unknown, fallback: string): string {
  return normalizeBaseUrl(value) ?? fallback;
}

export function safeToken(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
