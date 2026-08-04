import {
  type AlertRule,
  type ChannelType,
  isValidAlertChannelTarget,
  type Metric,
  type Operator,
} from '@/components/dashboard/stores/alertsStore';

export const ALERT_METRICS: Metric[] = ['error_rate', 'p99_latency', 'waiting', 'failed', 'dlq'];
export const ALERT_OPERATORS: Operator[] = ['>=', '>', '<=', '<'];
const CHANNELS: ChannelType[] = ['email', 'webhook', 'slack'];
const QUEUE_RE = /^[a-zA-Z0-9_\-.:]+$/;

export const METRIC_UNITS: Record<Metric, { unit: string; placeholder: string }> = {
  error_rate: { unit: '% (0–100)', placeholder: 'e.g. 5' },
  p99_latency: { unit: 'ms', placeholder: 'e.g. 250' },
  waiting: { unit: 'jobs', placeholder: 'e.g. 100' },
  failed: { unit: 'jobs', placeholder: 'e.g. 10' },
  dlq: { unit: 'jobs', placeholder: 'e.g. 1' },
};

export function channelTargetError(type: ChannelType, rawTarget: string): string | null {
  const target = rawTarget.trim();
  if (!target) return 'A destination is required';
  if (target.length > 2048) return 'Destination must be 2048 characters or fewer';
  if (type === 'email') {
    return isValidAlertChannelTarget(type, target) ? null : 'Enter a valid email address';
  }
  try {
    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return 'Enter an http:// or https:// URL without embedded credentials';
    }
    return null;
  } catch {
    return 'Enter a valid http:// or https:// URL';
  }
}

export interface AlertRuleDraft {
  name: string;
  metric: Metric;
  operator: Operator;
  threshold: string;
  queue: string;
  channel: ChannelType;
}

export function buildAlertRule(
  draft: AlertRuleDraft
):
  | { ok: true; rule: Omit<AlertRule, 'id'> }
  | { ok: false; error: string; field: keyof AlertRuleDraft } {
  const name = draft.name.trim();
  if (!ALERT_METRICS.includes(draft.metric))
    return { ok: false, error: 'Invalid metric', field: 'metric' };
  if (!ALERT_OPERATORS.includes(draft.operator))
    return { ok: false, error: 'Invalid operator', field: 'operator' };
  const queue = draft.metric === 'p99_latency' ? '' : draft.queue.trim();
  if (!name) return { ok: false, error: 'Rule name is required', field: 'name' };
  if (name.length > 200)
    return { ok: false, error: 'Rule name must be 200 characters or fewer', field: 'name' };
  if (!draft.threshold.trim())
    return { ok: false, error: 'Threshold is required', field: 'threshold' };
  const threshold = Number(draft.threshold);
  if (!Number.isFinite(threshold) || threshold < 0)
    return { ok: false, error: 'Threshold must be a non-negative number', field: 'threshold' };
  if (draft.metric === 'error_rate' && threshold > 100)
    return {
      ok: false,
      error: 'Error-rate threshold must be between 0 and 100%',
      field: 'threshold',
    };
  if (['waiting', 'failed', 'dlq'].includes(draft.metric) && !Number.isSafeInteger(threshold))
    return { ok: false, error: 'Job-count thresholds must be whole numbers', field: 'threshold' };
  if (queue && (queue.length > 256 || !QUEUE_RE.test(queue)))
    return {
      ok: false,
      error: 'Queue contains unsupported characters or is too long',
      field: 'queue',
    };
  if (!CHANNELS.includes(draft.channel))
    return { ok: false, error: 'Invalid channel type', field: 'channel' };
  return {
    ok: true,
    rule: {
      name,
      metric: draft.metric,
      operator: draft.operator,
      threshold,
      queue,
      channel: draft.channel,
      enabled: true,
    },
  };
}
