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
    { name: 'bq-dash-connection' }
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
