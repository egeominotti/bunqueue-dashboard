import { normalizeBaseUrl, safeTarget } from './connectionTarget';

export const DEFAULT_CONNECTION_PROFILE_ID = 'default';
export const MAX_CONNECTION_PROFILES = 32;
const MAX_PROFILE_NAME = 64;
const PROFILE_ID = /^[a-zA-Z0-9_-]{1,64}$/u;

export interface ConnectionProfile {
  id: string;
  name: string;
  baseUrl: string;
  agentBaseUrl: string;
}

export interface PersistedConnectionState {
  profiles: ConnectionProfile[];
  activeProfileId: string;
  refreshMs: number;
}

export interface ConnectionDefaults {
  baseUrl: string;
  agentBaseUrl: string;
  refreshMs: number;
}

export function defaultConnectionProfile(defaults: ConnectionDefaults): ConnectionProfile {
  return {
    id: DEFAULT_CONNECTION_PROFILE_ID,
    name: 'Local Bunqueue',
    baseUrl: defaults.baseUrl,
    agentBaseUrl: defaults.agentBaseUrl,
  };
}

export function safeProfileName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const clean = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('')
    .trim();
  return clean ? [...clean].slice(0, MAX_PROFILE_NAME).join('') : fallback;
}

function safeProfileId(value: unknown, fallback: string): string {
  return typeof value === 'string' && PROFILE_ID.test(value) ? value : fallback;
}

function profileFrom(
  value: unknown,
  index: number,
  defaults: ConnectionDefaults
): ConnectionProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const baseUrl = normalizeBaseUrl(raw.baseUrl);
  if (!baseUrl) return null;
  const id = safeProfileId(raw.id, `profile-${index + 1}`);
  return {
    id,
    name: safeProfileName(raw.name, `Bunqueue ${index + 1}`),
    baseUrl,
    agentBaseUrl: safeTarget(raw.agentBaseUrl, defaults.agentBaseUrl),
  };
}

export function sanitizeProfiles(
  value: unknown,
  defaults: ConnectionDefaults
): ConnectionProfile[] {
  if (!Array.isArray(value)) return [defaultConnectionProfile(defaults)];
  const profiles: ConnectionProfile[] = [];
  const ids = new Set<string>();
  for (const [index, candidate] of value.slice(0, MAX_CONNECTION_PROFILES).entries()) {
    const profile = profileFrom(candidate, index, defaults);
    if (!profile || ids.has(profile.id)) continue;
    ids.add(profile.id);
    profiles.push(profile);
  }
  return profiles.length ? profiles : [defaultConnectionProfile(defaults)];
}

export function sanitizePersistedState(
  value: unknown,
  defaults: ConnectionDefaults,
  safeRefreshMs: (value: unknown) => number
): PersistedConnectionState {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const profiles = sanitizeProfiles(raw.profiles, defaults);
  const requestedId = typeof raw.activeProfileId === 'string' ? raw.activeProfileId : '';
  const activeProfileId = profiles.some((profile) => profile.id === requestedId)
    ? requestedId
    : profiles[0].id;
  return { profiles, activeProfileId, refreshMs: safeRefreshMs(raw.refreshMs) };
}

export function migrateLegacyState(
  value: unknown,
  defaults: ConnectionDefaults,
  safeRefreshMs: (value: unknown) => number
): PersistedConnectionState {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  if (Array.isArray(raw.profiles)) return sanitizePersistedState(raw, defaults, safeRefreshMs);
  const profile = defaultConnectionProfile({
    ...defaults,
    baseUrl: safeTarget(raw.baseUrl, defaults.baseUrl),
  });
  return {
    profiles: [profile],
    activeProfileId: profile.id,
    refreshMs: safeRefreshMs(raw.refreshMs),
  };
}

export function uniqueProfileId(existing: readonly ConnectionProfile[]): string {
  const used = new Set(existing.map((profile) => profile.id));
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 16);
  const seed = random || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let candidate = `node-${seed}`;
  let suffix = 2;
  while (used.has(candidate)) candidate = `node-${seed}-${suffix++}`;
  return candidate;
}
