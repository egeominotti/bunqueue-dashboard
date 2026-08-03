import { useId, useRef, useState } from 'react';
import {
  type AlertRule,
  type AlertStoreMutationResult,
  type ChannelType,
  isValidAlertChannelTarget,
  METRIC_LABELS,
  type Metric,
  type Operator,
  useAlertsStore,
} from '@/components/dashboard/stores/alertsStore';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Button, IconButton } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState, OfflineBanner } from '@/components/ui/feedback';
import { Field, Input, Select, Toggle } from '@/components/ui/form';
import { IconCheck, IconTrash } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { formatRelativeTime } from '@/lib/format';
import {
  alertConnectionIdentity,
  enableNotifications,
  useAlertRuntimeStore,
} from '@/lib/useAlertEngine';

const CHANNELS: ChannelType[] = ['email', 'webhook', 'slack'];
const METRICS = Object.keys(METRIC_LABELS) as Metric[];
const OPERATORS: Operator[] = ['>=', '>', '<=', '<'];

// Threshold unit per metric — mirrors how useAlertEngine resolves each value
// (error_rate is a 0–100 percentage, p99_latency is milliseconds, the rest are
// job counts).
const METRIC_UNITS: Record<Metric, { unit: string; placeholder: string }> = {
  error_rate: { unit: '% (0–100)', placeholder: 'e.g. 5' },
  p99_latency: { unit: 'ms', placeholder: 'e.g. 250' },
  waiting: { unit: 'jobs', placeholder: 'e.g. 100' },
  failed: { unit: 'jobs', placeholder: 'e.g. 10' },
  dlq: { unit: 'jobs', placeholder: 'e.g. 1' },
};

const QUEUE_RE = /^[a-zA-Z0-9_\-.:]+$/;

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
  if (!METRICS.includes(draft.metric)) {
    return { ok: false, error: 'Invalid metric', field: 'metric' };
  }
  if (!OPERATORS.includes(draft.operator)) {
    return { ok: false, error: 'Invalid operator', field: 'operator' };
  }
  const queue = draft.metric === 'p99_latency' ? '' : draft.queue.trim();
  if (!name) return { ok: false, error: 'Rule name is required', field: 'name' };
  if (name.length > 200) {
    return {
      ok: false,
      error: 'Rule name must be 200 characters or fewer',
      field: 'name',
    };
  }
  if (!draft.threshold.trim()) {
    return { ok: false, error: 'Threshold is required', field: 'threshold' };
  }
  const threshold = Number(draft.threshold);
  if (!Number.isFinite(threshold) || threshold < 0) {
    return {
      ok: false,
      error: 'Threshold must be a non-negative number',
      field: 'threshold',
    };
  }
  if (draft.metric === 'error_rate' && threshold > 100) {
    return {
      ok: false,
      error: 'Error-rate threshold must be between 0 and 100%',
      field: 'threshold',
    };
  }
  if (['waiting', 'failed', 'dlq'].includes(draft.metric) && !Number.isSafeInteger(threshold)) {
    return {
      ok: false,
      error: 'Job-count thresholds must be whole numbers',
      field: 'threshold',
    };
  }
  if (queue && (queue.length > 256 || !QUEUE_RE.test(queue))) {
    return {
      ok: false,
      error: 'Queue contains unsupported characters or is too long',
      field: 'queue',
    };
  }
  if (!CHANNELS.includes(draft.channel)) {
    return { ok: false, error: 'Invalid channel type', field: 'channel' };
  }
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

function initialPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export function Alerts() {
  const { rules, addRule, removeRule, toggleRule } = useAlertsStore();
  const runtimeBreaches = useAlertRuntimeStore((s) => s.breaching);
  const runtimeStatus = useAlertRuntimeStore((s) => s.status);
  const runtimeError = useAlertRuntimeStore((s) => s.error);
  const runtimeIdentity = useAlertRuntimeStore((s) => s.connectionIdentity);
  const connectionIdentity = useConnectionStore((s) => alertConnectionIdentity(s.baseUrl, s.token));
  const hasEnabledRules = rules.some((rule) => rule.enabled);
  // The headless engine resets in an effect. Gate its store snapshot during the
  // render that changes connection so server A's breaches never paint under B.
  const runtimeIsCurrent = runtimeIdentity === connectionIdentity;
  const breaching = runtimeIsCurrent ? runtimeBreaches : [];
  const status = runtimeIsCurrent ? runtimeStatus : hasEnabledRules ? 'checking' : 'idle';
  const statusError = runtimeIsCurrent ? runtimeError : null;
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    initialPermission
  );

  const requestPermission = async () => {
    setPermission(await enableNotifications());
  };

  return (
    <div>
      <PageHeader
        title="Alerts"
        description="Threshold rules evaluated live in your browser."
        live={hasEnabledRules && status === 'live'}
        actions={
          <>
            {permission === 'granted' ? (
              <span className="flex items-center gap-1.5 text-sm text-success">
                <IconCheck className="size-4" /> Desktop alerts on
              </span>
            ) : permission === 'unsupported' ? (
              <span className="text-sm text-faint">Notifications unsupported</span>
            ) : permission === 'denied' ? (
              <span className="text-sm text-faint">
                Desktop alerts blocked — allow notifications in browser settings
              </span>
            ) : (
              <Button size="sm" onClick={requestPermission}>
                Enable desktop notifications
              </Button>
            )}
            <Button
              variant="accent"
              size="sm"
              aria-expanded={showRuleForm}
              aria-controls="alert-rule-form"
              onClick={() => setShowRuleForm((v) => !v)}
            >
              + Create Alert Rule
            </Button>
          </>
        }
      />

      {hasEnabledRules && status === 'checking' && (
        <p role="status" className="mb-4 text-sm text-muted">
          Checking alert metrics for the connected server…
        </p>
      )}
      {hasEnabledRules && status === 'degraded' && (
        <OfflineBanner
          message={
            statusError ?? 'Alert metrics are unavailable; current rule results may be stale.'
          }
        />
      )}

      <div className="mb-6 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-400/90">
        Rules are evaluated in this browser while a tab is open (even backgrounded), raising an
        in-app toast and — if enabled — a desktop notification. bunqueue OSS has no alerting
        backend, so email/webhook/slack delivery still needs your own monitoring or hosted bunqueue
        Cloud.
      </div>

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold text-fg">Triggered Alerts</h2>
        {breaching.length === 0 ? (
          <EmptyState
            icon={<IconCheck />}
            title="No triggered alerts"
            hint={
              !hasEnabledRules
                ? 'No enabled rules yet. Create one below.'
                : status === 'live'
                  ? 'All enabled rules are within their thresholds.'
                  : status === 'checking'
                    ? 'Alert metrics are still being checked.'
                    : 'Alert metrics are unavailable; no all-clear result is available.'
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-danger/30 bg-red-500/5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                  <th className="px-5 py-3 font-medium">Rule</th>
                  <th className="px-5 py-3 font-medium">Condition</th>
                  <th className="px-5 py-3 font-medium">Queue</th>
                  <th className="px-5 py-3 text-right font-medium">Current</th>
                  <th className="px-5 py-3 text-right font-medium">Since</th>
                </tr>
              </thead>
              <tbody>
                {breaching.map((b) => (
                  <tr key={b.ruleId} className="border-b border-line last:border-0">
                    <td className="px-5 py-3 font-medium text-danger">{b.ruleName}</td>
                    <td className="px-5 py-3 text-muted">
                      {b.metricLabel} {b.operator}{' '}
                      <span className="font-semibold text-fg">{b.threshold}</span>
                    </td>
                    <td className="px-5 py-3 text-muted">{b.queue || 'All queues'}</td>
                    <td className="px-5 py-3 text-right tnum font-semibold text-danger">
                      {Math.round(b.value * 100) / 100}
                    </td>
                    <td className="px-5 py-3 text-right text-faint">{formatRelativeTime(b.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-fg">Alert Rules</h2>
        {showRuleForm && (
          <div id="alert-rule-form">
            <Card className="mb-4">
              <RuleForm
                onAdd={(r) => {
                  const result = addRule(r);
                  if (result.ok) setShowRuleForm(false);
                  return result;
                }}
              />
            </Card>
          </div>
        )}
        {rules.length === 0 ? (
          <EmptyState
            title="No alert rules"
            hint="Create a rule to be notified when a threshold is crossed."
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                  <th className="px-5 py-3 font-medium">Rule</th>
                  <th className="px-5 py-3 font-medium">Condition</th>
                  <th className="px-5 py-3 font-medium">Queue</th>
                  <th className="px-5 py-3 font-medium">Delivery</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="w-12 px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0">
                    <td className="px-5 py-3 font-medium text-fg">{r.name}</td>
                    <td className="px-5 py-3 text-muted">
                      {METRIC_LABELS[r.metric]} {r.operator}{' '}
                      <span className="font-semibold text-accent">{r.threshold}</span>
                    </td>
                    <td className="px-5 py-3 text-muted">{r.queue || 'All queues'}</td>
                    <td className="px-5 py-3">
                      <span className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-muted">
                        Browser
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <Toggle
                        checked={r.enabled}
                        onChange={() => toggleRule(r.id)}
                        label="Enabled"
                      />
                    </td>
                    <td className="px-5 py-3 text-right">
                      <IconButton
                        aria-label={`Delete rule ${r.name}`}
                        onClick={() =>
                          window.confirm(`Delete alert rule "${r.name}"?`) && removeRule(r.id)
                        }
                      >
                        <IconTrash className="size-3.5" />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export function RuleForm({
  onAdd,
}: {
  onAdd: (r: {
    name: string;
    metric: Metric;
    operator: Operator;
    threshold: number;
    queue: string;
    channel: ChannelType;
    enabled: boolean;
  }) => AlertStoreMutationResult;
}) {
  const [name, setName] = useState('');
  const [metric, setMetric] = useState<Metric>('error_rate');
  const [operator, setOperator] = useState<Operator>('>=');
  const [threshold, setThreshold] = useState('');
  const [queue, setQueue] = useState('');
  const [error, setError] = useState<{
    field: keyof AlertRuleDraft;
    message: string;
  } | null>(null);
  const submitted = useRef(false);
  const errorId = useId();
  const invalid = (field: keyof AlertRuleDraft) => error?.field === field;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
      <Field label="Name">
        <Input
          name="alert-rule-name"
          autoComplete="off"
          maxLength={200}
          value={name}
          aria-invalid={invalid('name')}
          aria-describedby={invalid('name') ? errorId : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder="High error rate"
        />
      </Field>
      <Field label="Metric">
        <Select
          name="alert-rule-metric"
          value={metric}
          aria-invalid={invalid('metric')}
          aria-describedby={invalid('metric') ? errorId : undefined}
          onChange={(e) => {
            setMetric(e.target.value as Metric);
            setError(null);
          }}
        >
          {METRICS.map((m) => (
            <option key={m} value={m}>
              {METRIC_LABELS[m]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Operator">
        <Select
          name="alert-rule-operator"
          value={operator}
          aria-invalid={invalid('operator')}
          aria-describedby={invalid('operator') ? errorId : undefined}
          onChange={(e) => {
            setOperator(e.target.value as Operator);
            setError(null);
          }}
        >
          {OPERATORS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Threshold" hint={METRIC_UNITS[metric].unit}>
        <Input
          name="alert-rule-threshold"
          autoComplete="off"
          type="number"
          min={0}
          max={metric === 'error_rate' ? 100 : undefined}
          step={['waiting', 'failed', 'dlq'].includes(metric) ? 1 : 'any'}
          value={threshold}
          aria-invalid={invalid('threshold')}
          aria-describedby={invalid('threshold') ? errorId : undefined}
          onChange={(e) => {
            setThreshold(e.target.value);
            setError(null);
          }}
          placeholder={METRIC_UNITS[metric].placeholder}
        />
      </Field>
      {/* p99 latency is exposed per TCP operation, not per queue — the engine
          evaluates it globally, so a queue scope would be silently ignored. */}
      <Field
        label="Queue (optional)"
        hint={metric === 'p99_latency' ? 'global only — latency is not per queue' : undefined}
      >
        <Input
          name="alert-rule-queue"
          autoComplete="off"
          spellCheck={false}
          maxLength={256}
          value={queue}
          aria-invalid={invalid('queue')}
          aria-describedby={invalid('queue') ? errorId : undefined}
          onChange={(e) => {
            setQueue(e.target.value);
            setError(null);
          }}
          disabled={metric === 'p99_latency'}
          placeholder={metric === 'p99_latency' ? 'Global' : 'All queues'}
          className="disabled:cursor-not-allowed disabled:opacity-40"
        />
      </Field>
      <div className="col-span-full">
        <Button
          variant="accent"
          disabled={!name.trim() || !threshold.trim()}
          onClick={() => {
            if (submitted.current) return;
            const built = buildAlertRule({
              name,
              metric,
              operator,
              threshold,
              queue,
              // Retained in the persisted schema for backwards compatibility;
              // delivery is browser-only in OSS and is not user-selectable.
              channel: 'email',
            });
            if (!built.ok) {
              setError({ field: built.field, message: built.error });
              return;
            }
            submitted.current = true;
            try {
              const result = onAdd(built.rule);
              if (!result.ok) {
                submitted.current = false;
                setError({ field: 'name', message: result.error });
              }
            } catch (submissionError) {
              submitted.current = false;
              setError({ field: 'name', message: (submissionError as Error).message });
            }
          }}
        >
          Save rule
        </Button>
        {error && (
          <span id={errorId} role="alert" className="ml-3 text-xs text-danger">
            {error.message}
          </span>
        )}
      </div>
    </div>
  );
}
