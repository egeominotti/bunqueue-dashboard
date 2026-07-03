import { useState } from 'react';
import {
  type ChannelType,
  METRIC_LABELS,
  type Metric,
  type Operator,
  useAlertsStore,
} from '@/components/dashboard/stores/alertsStore';
import { Button, IconButton } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/feedback';
import { Field, Input, Select, Toggle } from '@/components/ui/form';
import { IconCheck, IconTrash } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { formatRelativeTime } from '@/lib/format';
import { enableNotifications, useAlertRuntimeStore } from '@/lib/useAlertEngine';

const CHANNELS: ChannelType[] = ['email', 'webhook', 'slack'];
const METRICS = Object.keys(METRIC_LABELS) as Metric[];
const OPERATORS: Operator[] = ['>=', '>', '<=', '<'];

function initialPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export function Alerts() {
  const { channels, rules, addChannel, removeChannel, addRule, removeRule, toggleRule } =
    useAlertsStore();
  const breaching = useAlertRuntimeStore((s) => s.breaching);
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
        live
        actions={
          <>
            {permission === 'granted' ? (
              <span className="flex items-center gap-1.5 text-sm text-success">
                <IconCheck className="size-4" /> Desktop alerts on
              </span>
            ) : permission === 'unsupported' ? (
              <span className="text-sm text-faint">Notifications unsupported</span>
            ) : (
              <Button size="sm" onClick={requestPermission}>
                Enable desktop notifications
              </Button>
            )}
            <Button variant="accent" size="sm" onClick={() => setShowRuleForm((v) => !v)}>
              + Create Alert Rule
            </Button>
          </>
        }
      />

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
              rules.some((r) => r.enabled)
                ? 'All enabled rules are within their thresholds.'
                : 'No enabled rules yet. Create one below.'
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

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold text-fg">Notification Channels</h2>
        <Card>
          {channels.length === 0 ? (
            <p className="mb-4 text-sm text-faint">No channels yet. Add one below.</p>
          ) : (
            <ul className="mb-4 divide-y divide-line">
              {channels.map((c) => (
                <li key={c.id} className="flex items-center justify-between py-2.5">
                  <div>
                    <div className="text-sm font-medium capitalize text-fg">{c.type}</div>
                    <div className="font-mono text-xs text-faint">{c.target}</div>
                  </div>
                  <IconButton aria-label="Remove channel" onClick={() => removeChannel(c.id)}>
                    <IconTrash className="size-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <ChannelForm onAdd={addChannel} />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-fg">Alert Rules</h2>
        {showRuleForm && (
          <Card className="mb-4">
            <RuleForm
              onAdd={(r) => {
                addRule(r);
                setShowRuleForm(false);
              }}
            />
          </Card>
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
                  <th className="px-5 py-3 font-medium">Channel</th>
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
                      <span className="rounded-md bg-surface-2 px-2 py-0.5 text-xs capitalize text-muted">
                        {r.channel}
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
                      <IconButton aria-label="Delete rule" onClick={() => removeRule(r.id)}>
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

function ChannelForm({ onAdd }: { onAdd: (type: ChannelType, target: string) => void }) {
  const [type, setType] = useState<ChannelType>('email');
  const [target, setTarget] = useState('');
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-36">
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as ChannelType)}>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="min-w-56 flex-1">
        <Field label={type === 'email' ? 'Email address' : 'URL'}>
          <Input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={type === 'email' ? 'ops@example.com' : 'https://hooks…'}
          />
        </Field>
      </div>
      <Button
        variant="accent"
        disabled={!target}
        onClick={() => {
          onAdd(type, target);
          setTarget('');
        }}
      >
        Add channel
      </Button>
    </div>
  );
}

function RuleForm({
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
  }) => void;
}) {
  const [name, setName] = useState('');
  const [metric, setMetric] = useState<Metric>('error_rate');
  const [operator, setOperator] = useState<Operator>('>=');
  const [threshold, setThreshold] = useState('');
  const [queue, setQueue] = useState('');
  const [channel, setChannel] = useState<ChannelType>('email');

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="High error rate"
        />
      </Field>
      <Field label="Metric">
        <Select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
          {METRICS.map((m) => (
            <option key={m} value={m}>
              {METRIC_LABELS[m]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Operator">
        <Select value={operator} onChange={(e) => setOperator(e.target.value as Operator)}>
          {OPERATORS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Threshold">
        <Input
          type="number"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          placeholder="55"
        />
      </Field>
      <Field label="Queue (optional)">
        <Input value={queue} onChange={(e) => setQueue(e.target.value)} placeholder="All queues" />
      </Field>
      <Field label="Channel">
        <Select value={channel} onChange={(e) => setChannel(e.target.value as ChannelType)}>
          {CHANNELS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </Field>
      <div className="col-span-full">
        <Button
          variant="accent"
          disabled={!name || !threshold}
          onClick={() =>
            onAdd({
              name,
              metric,
              operator,
              threshold: Number(threshold),
              queue,
              channel,
              enabled: true,
            })
          }
        >
          Save rule
        </Button>
      </div>
    </div>
  );
}
