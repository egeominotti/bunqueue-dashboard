import { createJSONStorage } from 'zustand/middleware';
import { runtimeConfigValue } from '@/lib/runtimeConfig';
import {
  type ConnectionDefaults,
  defaultConnectionProfile,
  migrateLegacyState,
  type PersistedConnectionState,
  sanitizePersistedState,
} from './connectionProfiles';
import { resolveAgentBase, resolveDefaultBaseUrl } from './connectionTarget';
import { createResilientStateStorage } from './resilientStateStorage';

export const CONNECTION_STORAGE_KEY = 'bq-dash-connection';
export const CONNECTION_STORAGE_VERSION = 4;
const DEFAULT_REFRESH_MS = 3000;
const MIN_REFRESH_MS = 500;
const MAX_REFRESH_MS = 60_000;

export const CONNECTION_DEFAULTS: ConnectionDefaults = {
  baseUrl: resolveDefaultBaseUrl(
    import.meta.env.VITE_BUNQUEUE_URL,
    runtimeConfigValue('__BUNQUEUE_API_URL__')
  ),
  agentBaseUrl: resolveAgentBase(
    runtimeConfigValue('__BUNQUEUE_AGENT_URL__'),
    import.meta.env.VITE_BUNQUEUE_AGENT_URL
  ),
  refreshMs: DEFAULT_REFRESH_MS,
};
export const DEFAULT_CONNECTION_PROFILE = defaultConnectionProfile(CONNECTION_DEFAULTS);

export function safeRefreshMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_REFRESH_MS;
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.round(value)));
}

export function persistedConnectionState(value: unknown): PersistedConnectionState {
  const state = value as {
    profiles?: unknown;
    activeProfileId?: unknown;
    baseUrl?: unknown;
    refreshMs?: unknown;
  } | null;
  return sanitizePersistedState(
    {
      profiles:
        state?.profiles ??
        (state?.baseUrl ? [{ ...DEFAULT_CONNECTION_PROFILE, baseUrl: state.baseUrl }] : undefined),
      activeProfileId: state?.activeProfileId,
      refreshMs: state?.refreshMs,
    },
    CONNECTION_DEFAULTS,
    safeRefreshMs
  );
}

export function sanitizedPersistedConnectionState(value: unknown): PersistedConnectionState {
  const raw = value as { profiles?: unknown } | null;
  return Array.isArray(raw?.profiles)
    ? sanitizePersistedState(value, CONNECTION_DEFAULTS, safeRefreshMs)
    : migrateLegacyState(value, CONNECTION_DEFAULTS, safeRefreshMs);
}

export function migratePersistedConnectionState(
  value: unknown,
  storedVersion: number,
  deploymentDefault: unknown = CONNECTION_DEFAULTS.baseUrl
): PersistedConnectionState {
  const defaults = {
    ...CONNECTION_DEFAULTS,
    baseUrl: resolveDefaultBaseUrl(undefined, deploymentDefault),
  };
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const migrationValue =
    storedVersion < 3 && raw.baseUrl === '/api' ? { ...raw, baseUrl: defaults.baseUrl } : value;
  return storedVersion < CONNECTION_STORAGE_VERSION
    ? migrateLegacyState(migrationValue, defaults, safeRefreshMs)
    : sanitizePersistedState(value, defaults, safeRefreshMs);
}

let lastPersistenceError: Error | null = null;
function recordPersistenceError(value: unknown): void {
  lastPersistenceError = value instanceof Error ? value : new Error(String(value));
}

export function beginConnectionPersistence(): void {
  lastPersistenceError = null;
}

export function connectionPersistenceResult(): { persisted: boolean; error?: string } {
  if (!lastPersistenceError) return { persisted: true };
  const prefix =
    lastPersistenceError.name && lastPersistenceError.name !== 'Error'
      ? `${lastPersistenceError.name}: `
      : '';
  return { persisted: false, error: `${prefix}${lastPersistenceError.message}` };
}

export const connectionStorage = createJSONStorage<PersistedConnectionState>(() =>
  createResilientStateStorage({
    key: CONNECTION_STORAGE_KEY,
    version: CONNECTION_STORAGE_VERSION,
    sanitizeState: sanitizedPersistedConnectionState,
    onError: recordPersistenceError,
    reportMissingWrites: true,
  })
);
