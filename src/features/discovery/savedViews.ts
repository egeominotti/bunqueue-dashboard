import type { DiscoveryQuery } from './model';

export interface SavedView {
  name: string;
  query: DiscoveryQuery;
}
type Reader = Pick<Storage, 'getItem'>;
type Writer = Pick<Storage, 'setItem'>;
const KEY = 'bunqueue-discovery-views-v1';
const MAX_BYTES = 32768;
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function allowlistedQuery(value: unknown): DiscoveryQuery {
  const raw = object(value);
  const query: DiscoveryQuery = {};
  for (const key of ['text', 'queue', 'state'] as const)
    if (typeof raw[key] === 'string' && raw[key]) query[key] = raw[key];
  if (Array.isArray(raw.profiles)) {
    const profiles = [
      ...new Set(
        raw.profiles.filter(
          (id): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/u.test(id)
        )
      ),
    ].slice(0, 32);
    if (profiles.length) query.profiles = profiles;
  }
  for (const key of ['minPriority', 'createdAfter', 'createdBefore'] as const)
    if (
      typeof raw[key] === 'number' &&
      Number.isFinite(raw[key]) &&
      (key === 'minPriority' || Math.abs(raw[key]) <= 8.64e15)
    )
      query[key] = raw[key];
  if (raw.includeDlq === true) query.includeDlq = true;
  return query;
}
function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
export function loadSavedViews(storage: Reader | undefined = browserStorage()): SavedView[] {
  try {
    const text = storage?.getItem(KEY);
    if (!text || new TextEncoder().encode(text).length > MAX_BYTES) return [];
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw) || raw.length > 32) return [];
    return raw.flatMap((value) => {
      const entry = object(value);
      return typeof entry.name === 'string' && entry.name.trim() && entry.name.length <= 64
        ? [{ name: entry.name.trim(), query: allowlistedQuery(entry.query) }]
        : [];
    });
  } catch {
    return [];
  }
}
export function saveSavedViews(
  views: readonly { name: string; query: unknown }[],
  storage: Writer | undefined = browserStorage()
): boolean {
  try {
    if (
      !storage ||
      views.length > 32 ||
      views.some((view) => !view.name.trim() || view.name.length > 64)
    )
      return false;
    const json = JSON.stringify(
      views.map((view) => ({ name: view.name.trim(), query: allowlistedQuery(view.query) }))
    );
    if (new TextEncoder().encode(json).length > MAX_BYTES) return false;
    storage.setItem(KEY, json);
    return true;
  } catch {
    return false;
  }
}
export function queryToSearch(value: DiscoveryQuery): string {
  const query = allowlistedQuery(value);
  const params = new URLSearchParams();
  for (const [key, entry] of Object.entries(query))
    params.set(key, Array.isArray(entry) ? entry.join(',') : String(entry));
  return params.toString();
}
export function queryFromSearch(search: string): DiscoveryQuery {
  const params = new URLSearchParams(search);
  const raw: Record<string, unknown> = {};
  for (const key of ['text', 'queue', 'state']) raw[key] = params.get(key);
  if (params.has('profiles')) raw.profiles = params.get('profiles')!.split(',');
  for (const key of ['createdAfter', 'createdBefore', 'minPriority']) {
    const value = params.get(key);
    if (value?.trim()) raw[key] = Number(value);
  }
  raw.includeDlq = params.get('includeDlq') === 'true';
  return allowlistedQuery(raw);
}
