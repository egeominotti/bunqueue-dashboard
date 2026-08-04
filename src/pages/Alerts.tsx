import { useState } from 'react';
import { METRIC_LABELS, useAlertsStore } from '@/components/dashboard/stores/alertsStore';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Button, IconButton } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState, OfflineBanner } from '@/components/ui/feedback';
import { Toggle } from '@/components/ui/form';
import { IconCheck, IconTrash } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { formatRelativeTime } from '@/lib/format';
import {
  alertConnectionIdentity,
  enableNotifications,
  useAlertRuntimeStore,
} from '@/lib/useAlertEngine';
import { RuleForm } from './alerts/RuleForm';

export type { AlertRuleDraft } from './alerts/model';
export { buildAlertRule, channelTargetError } from './alerts/model';
export { RuleForm } from './alerts/RuleForm';

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
