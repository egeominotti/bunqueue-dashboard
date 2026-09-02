import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  beginConnectionPersistence,
  CONNECTION_DEFAULTS,
  CONNECTION_STORAGE_KEY,
  CONNECTION_STORAGE_VERSION,
  connectionPersistenceResult,
  connectionStorage,
  DEFAULT_CONNECTION_PROFILE,
  migratePersistedConnectionState,
  persistedConnectionState,
  safeRefreshMs,
  sanitizedPersistedConnectionState,
} from './connectionPersistence';
import {
  type ConnectionProfile,
  MAX_CONNECTION_PROFILES,
  type PersistedConnectionState,
  safeProfileName,
  uniqueProfileId,
} from './connectionProfiles';
import { safeTarget, safeToken } from './connectionTarget';

export {
  BASE_URL_ERROR,
  isValidBaseUrl,
  normalizeBaseUrl,
  resolveAgentBase,
  resolveDefaultBaseUrl,
  SAFE_AGENT_BASE,
  SAFE_DEFAULT_BASE_URL,
} from './connectionTarget';
export type { ConnectionProfile } from './connectionProfiles';
export {
  CONNECTION_STORAGE_KEY,
  CONNECTION_STORAGE_VERSION,
  migratePersistedConnectionState,
  persistedConnectionState,
  sanitizedPersistedConnectionState,
} from './connectionPersistence';

export interface ConnectionSaveResult {
  persisted: boolean;
  error?: string;
}
export interface ConnectionDraft {
  baseUrl: string;
  token: string;
  agentToken: string;
  agentBaseUrl?: string;
  name?: string;
}
export interface ProfileCreateResult extends ConnectionSaveResult {
  id?: string;
}

interface ConnectionState {
  profiles: ConnectionProfile[];
  activeProfileId: string;
  baseUrl: string;
  agentBaseUrl: string;
  token: string;
  agentToken: string;
  refreshMs: number;
  saveConnection: (draft: ConnectionDraft) => ConnectionSaveResult;
  addProfile: (draft: ConnectionDraft) => ProfileCreateResult;
  activateProfile: (id: string) => boolean;
  removeProfile: (id: string) => boolean;
  setBaseUrl: (baseUrl: string) => void;
  setAgentBaseUrl: (agentBaseUrl: string) => void;
  setToken: (token: string) => void;
  setAgentToken: (agentToken: string) => void;
  setRefreshMs: (refreshMs: number) => void;
}

export interface ConnectionProfileTarget extends ConnectionProfile {
  readonly token: string;
  readonly agentToken: string;
}

const credentials = new Map<string, { token: string; agentToken: string }>();

function activeProfile(
  state: Pick<ConnectionState, 'profiles' | 'activeProfileId'>
): ConnectionProfile {
  return (
    state.profiles.find((profile) => profile.id === state.activeProfileId) ??
    state.profiles[0] ??
    DEFAULT_CONNECTION_PROFILE
  );
}

function replaceActiveProfile(state: ConnectionState, patch: Partial<ConnectionProfile>) {
  const profile = activeProfile(state);
  const next = { ...profile, ...patch, id: profile.id };
  return state.profiles.map((candidate) => (candidate.id === profile.id ? next : candidate));
}

function remember(id: string, token: unknown, agentToken: unknown): void {
  credentials.set(id, { token: safeToken(token), agentToken: safeToken(agentToken) });
}

export const useConnectionStore = create<ConnectionState>()(
  persist<ConnectionState, [], [], PersistedConnectionState>(
    (set, get) => ({
      profiles: [DEFAULT_CONNECTION_PROFILE],
      activeProfileId: DEFAULT_CONNECTION_PROFILE.id,
      baseUrl: DEFAULT_CONNECTION_PROFILE.baseUrl,
      agentBaseUrl: DEFAULT_CONNECTION_PROFILE.agentBaseUrl,
      token: '',
      agentToken: '',
      refreshMs: CONNECTION_DEFAULTS.refreshMs,
      saveConnection: (draft) => {
        beginConnectionPersistence();
        const state = get();
        const profile = activeProfile(state);
        const next = {
          ...profile,
          name: safeProfileName(draft.name, profile.name),
          baseUrl: safeTarget(draft.baseUrl, CONNECTION_DEFAULTS.baseUrl),
          agentBaseUrl: safeTarget(
            draft.agentBaseUrl ?? profile.agentBaseUrl,
            CONNECTION_DEFAULTS.agentBaseUrl
          ),
        };
        remember(profile.id, draft.token, draft.agentToken);
        set({
          profiles: replaceActiveProfile(state, next),
          baseUrl: next.baseUrl,
          agentBaseUrl: next.agentBaseUrl,
          token: safeToken(draft.token),
          agentToken: safeToken(draft.agentToken),
        });
        return connectionPersistenceResult();
      },
      addProfile: (draft) => {
        const state = get();
        if (state.profiles.length >= MAX_CONNECTION_PROFILES) {
          return {
            persisted: false,
            error: `At most ${MAX_CONNECTION_PROFILES} Bunqueue nodes are supported.`,
          };
        }
        beginConnectionPersistence();
        const id = uniqueProfileId(state.profiles);
        const profile: ConnectionProfile = {
          id,
          name: safeProfileName(draft.name, `Bunqueue ${state.profiles.length + 1}`),
          baseUrl: safeTarget(draft.baseUrl, CONNECTION_DEFAULTS.baseUrl),
          agentBaseUrl: safeTarget(draft.agentBaseUrl, CONNECTION_DEFAULTS.agentBaseUrl),
        };
        remember(id, draft.token, draft.agentToken);
        set({
          profiles: [...state.profiles, profile],
          activeProfileId: id,
          baseUrl: profile.baseUrl,
          agentBaseUrl: profile.agentBaseUrl,
          token: safeToken(draft.token),
          agentToken: safeToken(draft.agentToken),
        });
        return { ...connectionPersistenceResult(), id };
      },
      activateProfile: (id) => {
        const state = get();
        const profile = state.profiles.find((candidate) => candidate.id === id);
        if (!profile) return false;
        remember(state.activeProfileId, state.token, state.agentToken);
        const secret = credentials.get(id) ?? { token: '', agentToken: '' };
        set({
          activeProfileId: id,
          baseUrl: profile.baseUrl,
          agentBaseUrl: profile.agentBaseUrl,
          ...secret,
        });
        return true;
      },
      removeProfile: (id) => {
        const state = get();
        if (state.profiles.length === 1 || !state.profiles.some((profile) => profile.id === id)) {
          return false;
        }
        credentials.delete(id);
        const profiles = state.profiles.filter((profile) => profile.id !== id);
        if (id !== state.activeProfileId) {
          set({ profiles });
          return true;
        }
        const profile = profiles[0];
        const secret = credentials.get(profile.id) ?? { token: '', agentToken: '' };
        set({
          profiles,
          activeProfileId: profile.id,
          baseUrl: profile.baseUrl,
          agentBaseUrl: profile.agentBaseUrl,
          ...secret,
        });
        return true;
      },
      setBaseUrl: (baseUrl) =>
        set((state) => {
          const safe = safeTarget(baseUrl, CONNECTION_DEFAULTS.baseUrl);
          return { baseUrl: safe, profiles: replaceActiveProfile(state, { baseUrl: safe }) };
        }),
      setAgentBaseUrl: (agentBaseUrl) =>
        set((state) => {
          const safe = safeTarget(agentBaseUrl, CONNECTION_DEFAULTS.agentBaseUrl);
          return {
            agentBaseUrl: safe,
            profiles: replaceActiveProfile(state, { agentBaseUrl: safe }),
          };
        }),
      setToken: (token) =>
        set((state) => {
          const safe = safeToken(token);
          remember(state.activeProfileId, safe, state.agentToken);
          return { token: safe };
        }),
      setAgentToken: (agentToken) =>
        set((state) => {
          const safe = safeToken(agentToken);
          remember(state.activeProfileId, state.token, safe);
          return { agentToken: safe };
        }),
      setRefreshMs: (refreshMs) => set({ refreshMs: safeRefreshMs(refreshMs) }),
    }),
    {
      name: CONNECTION_STORAGE_KEY,
      storage: connectionStorage,
      version: CONNECTION_STORAGE_VERSION,
      partialize: persistedConnectionState,
      migrate: migratePersistedConnectionState,
      merge: (persisted, current) => {
        credentials.clear();
        const safe = sanitizedPersistedConnectionState(persisted);
        const profile =
          safe.profiles.find((candidate) => candidate.id === safe.activeProfileId) ??
          safe.profiles[0];
        return {
          ...current,
          ...safe,
          baseUrl: profile.baseUrl,
          agentBaseUrl: profile.agentBaseUrl,
          token: '',
          agentToken: '',
        };
      },
    }
  )
);

export function captureConnectionProfileTarget(
  id: string
): Readonly<ConnectionProfileTarget> | null {
  const state = useConnectionStore.getState();
  const profile = state.profiles.find((candidate) => candidate.id === id);
  if (!profile) return null;
  const secret =
    id === state.activeProfileId
      ? { token: safeToken(state.token), agentToken: safeToken(state.agentToken) }
      : (credentials.get(id) ?? { token: '', agentToken: '' });
  return Object.freeze({ ...profile, ...secret });
}

export const getBaseUrl = () =>
  safeTarget(useConnectionStore.getState().baseUrl, CONNECTION_DEFAULTS.baseUrl);
export const getAgentBaseUrl = () =>
  safeTarget(useConnectionStore.getState().agentBaseUrl, CONNECTION_DEFAULTS.agentBaseUrl);
export const getAuthHeaders = () => bearer(useConnectionStore.getState().token);
export const getAgentAuthHeaders = () => bearer(useConnectionStore.getState().agentToken);
function bearer(value: unknown): Record<string, string> {
  const token = safeToken(value);
  return token ? { Authorization: `Bearer ${token}` } : {};
}
