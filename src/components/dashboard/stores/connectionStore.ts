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
  /** Bearer token for the control agent when it runs with AGENT_TOKEN set. */
  agentToken: string;
  refreshMs: number;
  setBaseUrl: (baseUrl: string) => void;
  setToken: (token: string) => void;
  setAgentToken: (agentToken: string) => void;
  setRefreshMs: (refreshMs: number) => void;
}

// `/\/+$/` (not `/\/$/`): a pasted `host//` must not survive as `host/`, which
// would make every request URL `host//dashboard` and 404 on the exact-path router.
const envBase = import.meta.env.VITE_BUNQUEUE_URL?.trim().replace(/\/+$/, '');
const envToken = import.meta.env.VITE_BUNQUEUE_TOKEN;
const envAgentToken = import.meta.env.VITE_BUNQUEUE_AGENT_TOKEN;

/**
 * What gets persisted to localStorage. Both bearer tokens (server + control
 * agent) are deliberately excluded — an API credential must not sit in
 * plaintext at rest (same tradeoff as the S3 keys in s3Store): set
 * VITE_BUNQUEUE_TOKEN / VITE_BUNQUEUE_AGENT_TOKEN or re-enter them per session.
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
      agentToken: envAgentToken || '',
      refreshMs: 3000,
      setBaseUrl: (baseUrl) => set({ baseUrl: baseUrl.trim().replace(/\/+$/, '') }),
      setToken: (token) => set({ token }),
      setAgentToken: (agentToken) => set({ agentToken }),
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

/** Auth headers for the control agent (empty unless an AGENT_TOKEN was entered). */
export function getAgentAuthHeaders(): Record<string, string> {
  const { agentToken } = useConnectionStore.getState();
  return agentToken ? { Authorization: `Bearer ${agentToken}` } : {};
}
