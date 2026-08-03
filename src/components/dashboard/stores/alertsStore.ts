import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

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

export type AlertStoreMutationResult = { ok: true } | { ok: false; error: string };

interface AlertsState {
  channels: Channel[];
  rules: AlertRule[];
  addChannel: (type: ChannelType, target: string) => AlertStoreMutationResult;
  removeChannel: (id: string) => void;
  addRule: (rule: Omit<AlertRule, 'id'>) => AlertStoreMutationResult;
  removeRule: (id: string) => void;
  toggleRule: (id: string) => void;
}

export const ALERTS_STORAGE_KEY = 'bq-dash-alerts';
const ALERTS_STORAGE_VERSION = 1;
const CHANNEL_TYPES: readonly ChannelType[] = ['email', 'webhook', 'slack'];
const METRICS: readonly Metric[] = ['error_rate', 'p99_latency', 'waiting', 'failed', 'dlq'];
const OPERATORS: readonly Operator[] = ['>=', '>', '<=', '<'];
export const MAX_ALERT_CHANNELS = 100;
export const MAX_ALERT_RULES = 500;
const MAX_ID_CHARS = 128;
const MAX_NAME_CHARS = 200;
const MAX_TARGET_CHARS = 2048;
const MAX_QUEUE_CHARS = 256;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const uid = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function uniqueId(existing: readonly { id: string }[]): string {
  const ids = new Set(existing.map((item) => item.id));
  const base = uid();
  if (!ids.has(base)) return base;
  // Date.now()/Math.random() can be frozen by a test harness or a hardened
  // browser. A deterministic suffix guarantees progress instead of spinning.
  let suffix = 1;
  while (ids.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isChannelType(value: unknown): value is ChannelType {
  return CHANNEL_TYPES.includes(value as ChannelType);
}

function isMetric(value: unknown): value is Metric {
  return METRICS.includes(value as Metric);
}

function isOperator(value: unknown): value is Operator {
  return OPERATORS.includes(value as Operator);
}

export function isValidAlertChannelTarget(type: ChannelType, rawTarget: string): boolean {
  const target = rawTarget.trim();
  if (!target || target.length > MAX_TARGET_CHARS) return false;
  if (type === 'email') return target.length <= 320 && EMAIL_RE.test(target);
  try {
    const url = new URL(target);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function sanitizedChannel(value: unknown): Channel | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !isChannelType(value.type)) return null;
  if (typeof value.target !== 'string') return null;
  const id = value.id.trim();
  const target = value.target.trim();
  if (!id || id.length > MAX_ID_CHARS || target.length > MAX_TARGET_CHARS) return null;
  if (value.type === 'email' && !isValidAlertChannelTarget(value.type, target)) return null;
  return {
    id,
    type: value.type,
    // Webhook and Slack targets are bearer-like secret URLs. Historical builds
    // persisted them, so hydration must scrub them rather than merely relying
    // on partialize for future writes.
    target: value.type === 'email' ? target : '',
  };
}

function sanitizedRule(value: unknown): AlertRule | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !isMetric(value.metric) ||
    !isOperator(value.operator) ||
    typeof value.threshold !== 'number' ||
    !Number.isFinite(value.threshold) ||
    typeof value.queue !== 'string' ||
    !isChannelType(value.channel) ||
    typeof value.enabled !== 'boolean'
  ) {
    return null;
  }
  const id = value.id.trim();
  const name = value.name.trim();
  const queue = value.queue.trim();
  if (
    !id ||
    id.length > MAX_ID_CHARS ||
    !name ||
    name.length > MAX_NAME_CHARS ||
    queue.length > MAX_QUEUE_CHARS ||
    value.threshold < 0 ||
    (value.metric === 'error_rate' && value.threshold > 100)
  ) {
    return null;
  }
  return {
    id,
    name,
    metric: value.metric,
    operator: value.operator,
    threshold: value.threshold,
    queue,
    channel: value.channel,
    enabled: value.enabled,
  };
}

/** Reduce an untrusted persisted value to the only shapes the UI can consume. */
export function sanitizedPersistedAlertsState(value: unknown): {
  channels: Channel[];
  rules: AlertRule[];
} {
  const stored = isRecord(value) ? value : {};
  const channels: Channel[] = [];
  const channelIds = new Set<string>();
  if (Array.isArray(stored.channels)) {
    for (const value of stored.channels) {
      if (channels.length >= MAX_ALERT_CHANNELS) break;
      const channel = sanitizedChannel(value);
      if (!channel || channelIds.has(channel.id)) continue;
      channelIds.add(channel.id);
      channels.push(channel);
    }
  }
  const rules: AlertRule[] = [];
  const ruleIds = new Set<string>();
  if (Array.isArray(stored.rules)) {
    for (const value of stored.rules) {
      if (rules.length >= MAX_ALERT_RULES) break;
      const rule = sanitizedRule(value);
      if (!rule || ruleIds.has(rule.id)) continue;
      ruleIds.add(rule.id);
      rules.push(rule);
    }
  }
  return {
    channels,
    rules,
  };
}

/**
 * What gets persisted. A webhook/slack channel `target` is a secret URL, so it
 * is kept in memory only (same secrets-at-rest policy as the connection token
 * and the S3 keys) — the channel survives reload with a blank, re-enterable
 * target. `email` targets are not credentials and persist as-is.
 */
export function persistedAlertsState(s: AlertsState): { channels: Channel[]; rules: AlertRule[] } {
  return sanitizedPersistedAlertsState({ channels: s.channels, rules: s.rules });
}

function browserStorage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function sanitizeStoredEnvelope(raw: string): { hydration: string; canonical: string } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const envelope = isRecord(parsed) ? parsed : {};
    const rawState = 'state' in envelope ? envelope.state : envelope;
    const state = sanitizedPersistedAlertsState(rawState);
    const version = typeof envelope.version === 'number' ? envelope.version : undefined;
    return {
      hydration: JSON.stringify({ state, ...(version === undefined ? {} : { version }) }),
      canonical: JSON.stringify({ state, version: ALERTS_STORAGE_VERSION }),
    };
  } catch {
    return null;
  }
}

/** localStorage is optional durability and must never break an in-memory edit. */
const resilientAlertsStorage: StateStorage = {
  getItem(name) {
    const storage = browserStorage();
    if (!storage) return null;
    let raw: string | null;
    try {
      raw = storage.getItem(name);
    } catch {
      return null;
    }
    if (raw === null || name !== ALERTS_STORAGE_KEY) return raw;
    const sanitized = sanitizeStoredEnvelope(raw);
    if (!sanitized) {
      try {
        storage.removeItem(name);
      } catch {
        // Corrupt optional storage can be ignored; defaults remain usable.
      }
      return null;
    }
    if (raw !== sanitized.canonical) {
      try {
        storage.setItem(name, sanitized.canonical);
      } catch {
        // Fail closed: if an old secret-bearing blob cannot be overwritten,
        // discard it rather than leave credentials at rest indefinitely.
        try {
          storage.removeItem(name);
        } catch {
          // Storage is externally controlled; sanitized hydration is still safe.
        }
      }
    }
    return sanitized.hydration;
  },
  setItem(name, value) {
    try {
      browserStorage()?.setItem(name, value);
    } catch {
      // The in-memory Zustand transaction has already succeeded.
    }
  },
  removeItem(name) {
    try {
      browserStorage()?.removeItem(name);
    } catch {
      // Durable cleanup is best-effort.
    }
  },
};

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
      addChannel: (type, target) => {
        let result: AlertStoreMutationResult = {
          ok: false,
          error: 'Alert destination was rejected.',
        };
        set((s) => {
          const normalizedTarget = target.trim();
          if (!isChannelType(type) || !isValidAlertChannelTarget(type, normalizedTarget)) {
            result = { ok: false, error: 'Alert destination is invalid.' };
            return s;
          }
          if (s.channels.length >= MAX_ALERT_CHANNELS) {
            result = {
              ok: false,
              error: `A maximum of ${MAX_ALERT_CHANNELS} alert destinations can be stored in this browser.`,
            };
            return s;
          }
          result = { ok: true };
          return {
            channels: [...s.channels, { id: uniqueId(s.channels), type, target: normalizedTarget }],
          };
        });
        return result;
      },
      removeChannel: (id) => set((s) => ({ channels: s.channels.filter((c) => c.id !== id) })),
      addRule: (rule) => {
        let result: AlertStoreMutationResult = {
          ok: false,
          error: 'Alert rule was rejected.',
        };
        set((s) => {
          if (s.rules.length >= MAX_ALERT_RULES) {
            result = {
              ok: false,
              error: `A maximum of ${MAX_ALERT_RULES} alert rules can be stored in this browser.`,
            };
            return s;
          }
          const sanitized = sanitizedRule({ ...rule, id: uniqueId(s.rules) });
          if (!sanitized) {
            result = { ok: false, error: 'Alert rule contains invalid fields.' };
            return s;
          }
          result = { ok: true };
          return { rules: [...s.rules, sanitized] };
        });
        return result;
      },
      removeRule: (id) => set((s) => ({ rules: s.rules.filter((r) => r.id !== id) })),
      toggleRule: (id) =>
        set((s) => ({
          rules: s.rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
        })),
    }),
    {
      name: ALERTS_STORAGE_KEY,
      version: ALERTS_STORAGE_VERSION,
      storage: createJSONStorage(() => resilientAlertsStorage),
      partialize: persistedAlertsState,
      migrate: sanitizedPersistedAlertsState,
      merge: (persisted, current) => ({
        ...current,
        ...sanitizedPersistedAlertsState(persisted),
      }),
    }
  )
);

export const METRIC_LABELS: Record<Metric, string> = {
  error_rate: 'error rate',
  p99_latency: 'p99 latency',
  waiting: 'waiting jobs',
  failed: 'failed jobs',
  dlq: 'DLQ size',
};
