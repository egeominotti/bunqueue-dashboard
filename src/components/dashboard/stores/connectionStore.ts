import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  refreshMs: number;
  setBaseUrl: (baseUrl: string) => void;
  setToken: (token: string) => void;
  setRefreshMs: (refreshMs: number) => void;
}

const envBase = import.meta.env.VITE_BUNQUEUE_URL?.replace(/\/$/, '');
const envToken = import.meta.env.VITE_BUNQUEUE_TOKEN;

/**
 * What gets persisted to localStorage. The bearer token is deliberately
 * excluded — an API credential must not sit in plaintext at rest (same
 * tradeoff as the S3 keys in s3Store): set VITE_BUNQUEUE_TOKEN or re-enter it
 * in Settings per session.
 */
export function persistedConnectionState(s: ConnectionState): {
  baseUrl: string;
  refreshMs: number;
} {
  return { baseUrl: s.baseUrl, refreshMs: s.refreshMs };
}

export const useConnectionStore = create<ConnectionState>()(
  persist(
    (set) => ({
      baseUrl: envBase || '/api',
      token: envToken || '',
      refreshMs: 3000,
      setBaseUrl: (baseUrl) => set({ baseUrl: baseUrl.replace(/\/$/, '') }),
      setToken: (token) => set({ token }),
      setRefreshMs: (refreshMs) => set({ refreshMs: Math.max(500, refreshMs) }),
    }),
    {
      name: 'bq-dash-connection',
      // version+migrate rewrite the stored blob on rehydrate, scrubbing tokens
      // already persisted by older builds (partialize alone only stops new writes).
      version: 1,
      partialize: persistedConnectionState,
      migrate: (persisted) => persistedConnectionState(persisted as ConnectionState),
    }
  )
);

/** Non-reactive accessors for the API layer (outside React). */
export function getBaseUrl(): string {
  return useConnectionStore.getState().baseUrl || '/api';
}

export function getAuthHeaders(): Record<string, string> {
  const { token } = useConnectionStore.getState();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
