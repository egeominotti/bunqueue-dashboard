import { MAX_FLOW_NODES } from './flowConstants';

const RECENT_KEY = 'bq-dash-recent-flows';
const RECENT_MAX = 8;

export interface RecentFlow {
  root: string;
  nodes: number;
  at: number;
}

export function recentFlowsStorageKey(target: string): string {
  return `${RECENT_KEY}:${encodeURIComponent(target.trim() || '/api')}`;
}

export function readRecentFlows(target: string, persist: boolean): RecentFlow[] {
  if (!persist) return [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(recentFlowsStorageKey(target)) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (item): item is RecentFlow =>
          typeof (item as RecentFlow)?.root === 'string' &&
          (item as RecentFlow).root.length > 0 &&
          (item as RecentFlow).root.length <= 1024 &&
          Number.isSafeInteger((item as RecentFlow)?.nodes) &&
          (item as RecentFlow).nodes > 1 &&
          (item as RecentFlow).nodes <= MAX_FLOW_NODES &&
          Number.isFinite((item as RecentFlow)?.at) &&
          (item as RecentFlow).at >= 0
      )
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

export function pushRecentFlow(
  target: string,
  list: RecentFlow[],
  entry: RecentFlow,
  persist: boolean
): RecentFlow[] {
  const next = [entry, ...list.filter((item) => item.root !== entry.root)].slice(0, RECENT_MAX);
  if (!persist) return next;
  try {
    localStorage.setItem(recentFlowsStorageKey(target), JSON.stringify(next));
  } catch {
    // The in-memory list remains available when storage is blocked or full.
  }
  return next;
}
