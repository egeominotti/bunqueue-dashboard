import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { runtimeConfigValue } from '@/lib/runtimeConfig';
import { createResilientStateStorage } from './resilientStateStorage';

export interface ConnectionSaveResult {
  persisted: boolean;
  error?: string;
}

export interface ConnectionDraft {
  baseUrl: string;
  token: string;
  agentToken: string;
}

/**
 * Where the dashboard points and how often it polls.
 *
 * `baseUrl` defaults to the Vite dev proxy at `/api` (see vite.config.ts), which
 * forwards to a local bunqueue server on :6790. Override it (Settings page or
 * VITE_BUNQUEUE_URL) to point at a remote server.
 */
interface ConnectionState {
  baseUrl: string;
  token: string;
  /** Bearer token for the control agent when it runs with AGENT_TOKEN set. */
  agentToken: string;
  refreshMs: number;
  saveConnection: (draft: ConnectionDraft) => ConnectionSaveResult;
  setBaseUrl: (baseUrl: string) => void;
  setToken: (token: string) => void;
  setAgentToken: (agentToken: string) => void;
  setRefreshMs: (refreshMs: number) => void;
}

export const SAFE_DEFAULT_BASE_URL = '/api';
export const CONNECTION_STORAGE_KEY = 'bq-dash-connection';
const CONNECTION_STORAGE_VERSION = 3;
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

/**
 * Parse and canonicalize the only server targets to which credentials may be
 * attached. Returning null is deliberate: callers must never preserve part of
 * an invalid value (especially the authority from a legacy `//host` URL).
 */
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
      // URL parsing resolves dot segments. Re-check the canonical path because
      // `/%2e%2e//host` otherwise normalizes into a protocol-relative string.
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

  // Require the explicit `scheme://authority` spelling. WHATWG URL accepts
  // ambiguous inputs such as `http:host`, but connection settings should not.
  const scheme = candidate.match(/^https?:\/\//i)?.[0];
  if (!scheme) return null;
  const authorityAndPath = candidate.slice(scheme.length);
  const authority = authorityAndPath.split('/', 1)[0];
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

/** Resolve build/runtime defaults without allowing an unsafe target. */
export function resolveDefaultBaseUrl(value: unknown, runtimeValue?: unknown): string {
  return normalizeBaseUrl(value) ?? normalizeBaseUrl(runtimeValue) ?? SAFE_DEFAULT_BASE_URL;
}

const DEFAULT_BASE_URL = resolveDefaultBaseUrl(
  import.meta.env.VITE_BUNQUEUE_URL,
  runtimeConfigValue('__BUNQUEUE_API_URL__')
);
const DEFAULT_REFRESH_MS = 3000;
const MIN_REFRESH_MS = 500;
const MAX_REFRESH_MS = 60_000;

function safeBaseUrl(value: unknown): string {
  return normalizeBaseUrl(value) ?? DEFAULT_BASE_URL;
}

function safeRefreshMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_REFRESH_MS;
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.round(value)));
}

function safeToken(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * What gets persisted to localStorage. Both bearer tokens (server + control
 * agent) are deliberately excluded — an API credential must not sit in
 * plaintext at rest (same tradeoff as the S3 keys in s3Store). They are also
 * never read from VITE_* variables: those values are compiled into public
 * JavaScript and therefore are not a safe secret-delivery mechanism.
 */
export function persistedConnectionState(s: ConnectionState): {
  baseUrl: string;
  refreshMs: number;
} {
  return { baseUrl: safeBaseUrl(s.baseUrl), refreshMs: safeRefreshMs(s.refreshMs) };
}

/** Sanitize an untrusted/stale localStorage payload before it reaches timers or fetch. */
export function sanitizedPersistedConnectionState(value: unknown): {
  baseUrl: string;
  refreshMs: number;
} {
  const stored =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    baseUrl: safeBaseUrl(stored.baseUrl),
    refreshMs: safeRefreshMs(stored.refreshMs),
  };
}

/** Move the historical implicit `/api` default to this deployment's runtime mount. */
export function migratePersistedConnectionState(
  value: unknown,
  storedVersion: number,
  deploymentDefault: unknown = DEFAULT_BASE_URL
): { baseUrl: string; refreshMs: number } {
  const state = sanitizedPersistedConnectionState(value);
  if (storedVersion < CONNECTION_STORAGE_VERSION && state.baseUrl === SAFE_DEFAULT_BASE_URL) {
    return {
      ...state,
      baseUrl: resolveDefaultBaseUrl(undefined, deploymentDefault),
    };
  }
  return state;
}

let lastPersistenceError: Error | null = null;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function recordPersistenceError(value: unknown): void {
  lastPersistenceError = asError(value);
}

function persistenceResult(): ConnectionSaveResult {
  if (!lastPersistenceError) return { persisted: true };
  const name =
    lastPersistenceError.name && lastPersistenceError.name !== 'Error'
      ? `${lastPersistenceError.name}: `
      : '';
  return { persisted: false, error: `${name}${lastPersistenceError.message}` };
}

const resilientStateStorage = createResilientStateStorage({
  key: CONNECTION_STORAGE_KEY,
  version: CONNECTION_STORAGE_VERSION,
  sanitizeState: sanitizedPersistedConnectionState,
  onError: recordPersistenceError,
  reportMissingWrites: true,
});

const connectionStorage = createJSONStorage(() => resilientStateStorage);

export const useConnectionStore = create<ConnectionState>()(
  persist(
    (set) => ({
      baseUrl: DEFAULT_BASE_URL,
      token: '',
      agentToken: '',
      refreshMs: DEFAULT_REFRESH_MS,
      saveConnection: (draft) => {
        // One Zustand update is the in-memory commit boundary. Persistence is
        // best-effort and cannot leave URL/token fields partially updated.
        lastPersistenceError = null;
        set({
          baseUrl: safeBaseUrl(draft.baseUrl),
          token: safeToken(draft.token),
          agentToken: safeToken(draft.agentToken),
        });
        return persistenceResult();
      },
      setBaseUrl: (baseUrl) => set({ baseUrl: safeBaseUrl(baseUrl) }),
      setToken: (token) => set({ token: safeToken(token) }),
      setAgentToken: (agentToken) => set({ agentToken: safeToken(agentToken) }),
      setRefreshMs: (refreshMs) => set({ refreshMs: safeRefreshMs(refreshMs) }),
    }),
    {
      name: CONNECTION_STORAGE_KEY,
      // `globalThis` works in browsers and in the Bun test preload. Zustand's
      // default reaches through `window`, which is absent in non-DOM runtimes
      // even when a standards-compatible storage adapter is installed.
      storage: connectionStorage,
      // version+migrate rewrite the stored blob on rehydrate, scrubbing tokens
      // already persisted by older builds (partialize alone only stops new writes).
      version: CONNECTION_STORAGE_VERSION,
      partialize: persistedConnectionState,
      migrate: migratePersistedConnectionState,
      // `merge` runs for same-version data too. localStorage is user-controlled
      // and older/corrupt blobs must not inject NaN/strings into setTimeout or
      // resurrect bearer-token fields from a historical schema.
      merge: (persisted, current) => ({
        ...current,
        ...sanitizedPersistedConnectionState(persisted),
        token: '',
        agentToken: '',
      }),
    }
  )
);

/** Non-reactive accessors for the API layer (outside React). */
export function getBaseUrl(): string {
  // Defense in depth for direct Zustand state injection or a future migration
  // regression: no transport may ever consume an unvalidated authority.
  return safeBaseUrl(useConnectionStore.getState().baseUrl);
}

export function getAuthHeaders(): Record<string, string> {
  const token = safeToken(useConnectionStore.getState().token);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Auth headers for the control agent (empty unless an AGENT_TOKEN was entered). */
export function getAgentAuthHeaders(): Record<string, string> {
  const agentToken = safeToken(useConnectionStore.getState().agentToken);
  return agentToken ? { Authorization: `Bearer ${agentToken}` } : {};
}
