import { useId, useRef, useState } from 'react';
import {
  type AlertStoreMutationResult,
  type ChannelType,
  METRIC_LABELS,
  type Metric,
  type Operator,
} from '@/components/dashboard/stores/alertsStore';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/form';
import {
  ALERT_METRICS,
  ALERT_OPERATORS,
  type AlertRuleDraft,
  buildAlertRule,
  METRIC_UNITS,
} from './model';

export function RuleForm({
  onAdd,
}: {
  onAdd: (rule: {
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
  const [error, setError] = useState<{ field: keyof AlertRuleDraft; message: string } | null>(null);
  const submitted = useRef(false);
  const errorId = useId();
  const invalid = (field: keyof AlertRuleDraft) => error?.field === field;
  const save = () => {
    if (submitted.current) return;
    const built = buildAlertRule({ name, metric, operator, threshold, queue, channel: 'email' });
    if (!built.ok) return setError({ field: built.field, message: built.error });
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
  };
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
          onChange={(event) => {
            setName(event.target.value);
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
          onChange={(event) => {
            setMetric(event.target.value as Metric);
            setError(null);
          }}
        >
          {ALERT_METRICS.map((item) => (
            <option key={item} value={item}>
              {METRIC_LABELS[item]}
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
          onChange={(event) => {
            setOperator(event.target.value as Operator);
            setError(null);
          }}
        >
          {ALERT_OPERATORS.map((item) => (
            <option key={item} value={item}>
              {item}
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
          onChange={(event) => {
            setThreshold(event.target.value);
            setError(null);
          }}
          placeholder={METRIC_UNITS[metric].placeholder}
        />
      </Field>
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
          onChange={(event) => {
            setQueue(event.target.value);
            setError(null);
          }}
          disabled={metric === 'p99_latency'}
          placeholder={metric === 'p99_latency' ? 'Global' : 'All queues'}
          className="disabled:cursor-not-allowed disabled:opacity-40"
        />
      </Field>
      <div className="col-span-full">
        <Button variant="accent" disabled={!name.trim() || !threshold.trim()} onClick={save}>
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
