import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ChannelType = 'email' | 'webhook' | 'slack';
export type Metric = 'error_rate' | 'p99_latency' | 'waiting' | 'failed' | 'dlq';
export type Operator = '>=' | '>' | '<=' | '<';

export interface Channel {
  id: string;
  type: ChannelType;
  target: string;
}

export interface AlertRule {
  id: string;
  name: string;
  metric: Metric;
  operator: Operator;
  threshold: number;
  queue: string;
  channel: ChannelType;
  enabled: boolean;
}

interface AlertsState {
  channels: Channel[];
  rules: AlertRule[];
  addChannel: (type: ChannelType, target: string) => void;
  removeChannel: (id: string) => void;
  addRule: (rule: Omit<AlertRule, 'id'>) => void;
  removeRule: (id: string) => void;
  toggleRule: (id: string) => void;
}

const uid = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * What gets persisted. A webhook/slack channel `target` is a secret URL, so it
 * is kept in memory only (same secrets-at-rest policy as the connection token
 * and the S3 keys) — the channel survives reload with a blank, re-enterable
 * target. `email` targets are not credentials and persist as-is.
 */
export function persistedAlertsState(s: AlertsState): { channels: Channel[]; rules: AlertRule[] } {
  return {
    channels: s.channels.map((c) => (c.type === 'email' ? c : { ...c, target: '' })),
    rules: s.rules,
  };
}

/**
 * Alert configuration is stored client-side only. bunqueue OSS has no alerting
 * backend, so this persists rules/channels in localStorage for you to wire into
 * your own monitoring (or the hosted bunqueue Cloud).
 */
export const useAlertsStore = create<AlertsState>()(
  persist(
    (set) => ({
      channels: [],
      rules: [],
      addChannel: (type, target) =>
        set((s) => ({ channels: [...s.channels, { id: uid(), type, target }] })),
      removeChannel: (id) => set((s) => ({ channels: s.channels.filter((c) => c.id !== id) })),
      addRule: (rule) => set((s) => ({ rules: [...s.rules, { ...rule, id: uid() }] })),
      removeRule: (id) => set((s) => ({ rules: s.rules.filter((r) => r.id !== id) })),
      toggleRule: (id) =>
        set((s) => ({
          rules: s.rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
        })),
    }),
    { name: 'bq-dash-alerts', partialize: persistedAlertsState }
  )
);

export const METRIC_LABELS: Record<Metric, string> = {
  error_rate: 'error rate',
  p99_latency: 'p99 latency',
  waiting: 'waiting jobs',
  failed: 'failed jobs',
  dlq: 'DLQ size',
};
